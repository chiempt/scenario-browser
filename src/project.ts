import { glob, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiOptions } from './ai.ts';
import { loadScenario } from './load.ts';
import { applyLock } from './lock.ts';
import { prepareReportDir, writeReport, type ProjectReport } from './report.ts';
import { runScenario, type RunReport } from './runner.ts';
import { ProjectSchema, formatIssues, hasJs, type Project, type Scenario } from './schema.ts';

export const PROJECT_FILE = 'scenario.project.json';
export class ProjectError extends Error {}

export interface LoadedProject { project: Project; dir: string; file: string }

/** Accepts a project directory or the project file itself. */
export const loadProject = async (target: string): Promise<LoadedProject> => {
  const isDir = (await stat(target).catch(() => null))?.isDirectory();
  const file = isDir ? path.join(target, PROJECT_FILE) : target;
  const text = await readFile(file, 'utf8').catch(() => { throw new ProjectError(`no ${PROJECT_FILE} in ${target} (run "project init")`); });
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { throw new ProjectError(`${file}: not valid JSON: ${(e as Error).message}`); }
  const parsed = ProjectSchema.safeParse(data);
  if (!parsed.success) throw new ProjectError(`${file}:\n${formatIssues(parsed.error)}`);
  return { project: parsed.data, dir: path.resolve(path.dirname(file)), file: path.resolve(file) };
};

/** Minimal dotenv: KEY=VALUE lines, # comments, optional quotes. */
export const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
};

/** process.env wins over the project's env file, so CI secrets override local files. */
export const loadEnv = async (lp: LoadedProject): Promise<Record<string, string | undefined>> => {
  const file = path.resolve(lp.dir, lp.project.envFile ?? '.env');
  const text = await readFile(file, 'utf8').catch(() => '');
  return { ...parseEnv(text), ...process.env };
};

export interface Discovered { file: string; rel: string; scenario?: Scenario; error?: string }

const setupSet = (lp: LoadedProject) => new Set([...(lp.project.setup ?? []), ...(lp.project.teardown ?? [])].map((f) => path.resolve(lp.dir, f)));

export const discoverScenarios = async (lp: LoadedProject): Promise<Discovered[]> => {
  const patterns = lp.project.scenarios ?? ['scenarios/**/*.{json,md}'];
  const skip = setupSet(lp);
  const found = new Set<string>();
  for (const pat of patterns) for await (const f of glob(pat, { cwd: lp.dir })) {
    const abs = path.resolve(lp.dir, f);
    if (!/\.(json|md)$/i.test(abs) || skip.has(abs) || path.relative(lp.dir, abs).split(path.sep).includes('node_modules') || path.basename(abs) === PROJECT_FILE) continue;
    found.add(abs);
  }
  const out: Discovered[] = [];
  for (const file of [...found].sort()) {
    const rel = path.relative(lp.dir, file);
    try { out.push({ file, rel, scenario: await loadScenario(file) }); }
    catch (e) { out.push({ file, rel, error: (e as Error).message }); }
  }
  return out;
};

export const filterScenarios = (all: Discovered[], tags: string[] = [], grep?: string): Discovered[] => {
  const re = grep ? new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined;
  return all.filter((d) => {
    if (tags.length && !(d.scenario?.tags ?? []).some((t) => tags.includes(t))) return false;
    if (re && !re.test(`${d.scenario?.name ?? ''} ${d.rel}`)) return false;
    return true;
  });
};

export const listProject = async (lp: LoadedProject) =>
  (await discoverScenarios(lp)).map((d) => ({
    file: d.rel, name: d.scenario?.name ?? '(invalid)', tags: d.scenario?.tags ?? [],
    hasJs: d.scenario ? hasJs(d.scenario.steps) : false, ...(d.error ? { error: d.error } : {}),
  }));

export interface ProjectRunOptions {
  tags?: string[]; grep?: string; headless?: boolean; heal?: boolean;
  /** Forbid AI calls; ai= steps must be locked already. */
  noAi?: boolean;
  /** Write selectors the AI found back into the scenario files. */
  lock?: boolean;
  /** --var overrides. */
  vars?: Record<string, string>;
  reportDir?: string; ai?: AiOptions; log?: (l: string) => void;
}

export const runProject = async (lp: LoadedProject, opts: ProjectRunOptions = {}): Promise<ProjectReport> => {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const reportDir = path.resolve(lp.dir, opts.reportDir ?? lp.project.reportDir ?? 'reports');
  const outDir = await prepareReportDir(reportDir);
  const env = await loadEnv(lp);
  const d = lp.project.defaults ?? {};
  const launcher = d.launcher ? path.resolve(lp.dir, d.launcher) : undefined;
  let dynamic: Record<string, unknown> = {};
  const scenarios: ProjectReport['scenarios'] = [];
  let note: string | undefined;

  const one = async (file: string, phase: 'setup' | 'test' | 'teardown'): Promise<RunReport> => {
    const rel = path.relative(lp.dir, file);
    let scenario: Scenario;
    try { scenario = await loadScenario(file); }
    catch (e) {
      const r: RunReport = { scenario: rel, file: rel, tags: [], status: 'failed', startedAt: new Date().toISOString(), durationMs: 0, steps: [], vars: {}, error: (e as Error).message };
      scenarios.push({ ...r, phase }); return r;
    }
    log(`[${phase}] ${rel}`);
    let r: RunReport;
    try { r = await runScenario(scenario, {
      file, rootDir: lp.dir, outDir, env, log,
      ...(lp.project.baseUrl ? { baseUrl: lp.project.baseUrl } : {}),
      baseVars: { ...(lp.project.vars ?? {}), ...dynamic },
      ...(opts.vars ? { overrideVars: opts.vars } : {}),
      defaults: { ...(d.timeout ? { timeout: d.timeout } : {}), ...(d.headless === undefined ? {} : { headless: d.headless }) },
      ...(opts.headless === undefined ? {} : { headless: opts.headless }),
      ...(opts.heal ? { heal: true } : {}), ...(opts.noAi ? { noAi: true } : {}),
      ...(opts.ai ? { ai: opts.ai } : {}), ...(launcher ? { launcher } : {}),
    }); } catch (e) {
      r = { scenario: scenario.name, file: rel, tags: scenario.tags ?? [], status: 'failed', startedAt: new Date().toISOString(), durationMs: 0, steps: [], vars: {}, error: (e as Error).message };
    }
    if (opts.lock) { const note = await applyLock(file, r); if (note) log(note); }
    scenarios.push({ ...r, file: rel, phase });
    return r;
  };

  const all = await discoverScenarios(lp);
  const selected = filterScenarios(all, opts.tags, opts.grep);
  if (!selected.length) throw new ProjectError('no scenarios matched (check --tag / --grep and the "scenarios" globs)');

  let setupOk = true;
  for (const f of lp.project.setup ?? []) {
    const r = await one(path.resolve(lp.dir, f), 'setup');
    if (r.status === 'failed') { setupOk = false; note = `setup failed (${f}); tests were skipped`; break; }
    dynamic = { ...dynamic, ...r.vars };
  }
  if (setupOk) {
    for (const s of selected) {
      if (s.error) {
        scenarios.push({ scenario: s.rel, file: s.rel, tags: [], status: 'failed', startedAt: new Date().toISOString(), durationMs: 0, steps: [], vars: {}, error: s.error, phase: 'test' });
      } else await one(s.file, 'test');
    }
  }
  for (const f of lp.project.teardown ?? []) await one(path.resolve(lp.dir, f), 'teardown');

  const tests = scenarios.filter((s) => s.phase === 'test');
  const failedAny = scenarios.some((s) => s.status === 'failed') || !setupOk;
  const report: ProjectReport = {
    project: lp.project.name, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    status: failedAny ? 'failed' : 'passed',
    counts: { total: tests.length, passed: tests.filter((s) => s.status === 'passed').length, failed: tests.filter((s) => s.status === 'failed').length },
    scenarios, ...(note ? { note } : {}),
  };
  await writeReport(reportDir, report);
  log(`report: ${path.join(reportDir, 'report.html')}`);
  return report;
};

export const initProject = async (dir: string, name = path.basename(path.resolve(dir))): Promise<string[]> => {
  const target = path.join(dir, PROJECT_FILE);
  if (await stat(target).catch(() => null)) throw new ProjectError(`${target} already exists`);
  await mkdir(path.join(dir, 'scenarios'), { recursive: true });
  const files: Record<string, string> = {
    [PROJECT_FILE]: JSON.stringify({
      name, baseUrl: 'https://example.com', vars: { greeting: 'hello' }, envFile: '.env',
      defaults: { timeout: 10000, headless: true }, scenarios: ['scenarios/**/*.{json,md}'], reportDir: 'reports',
    }, null, 2) + '\n',
    'scenarios/smoke.md': `# Home page loads\ntags: smoke\n\n- goto /\n- expect title "Example Domain"\n- expect js "document.querySelectorAll('p').length > 0"\n`,
    'scenarios/headline.json': JSON.stringify({
      name: 'Page text', tags: ['smoke', 'content'],
      steps: [
        { action: 'goto', url: '/' },
        { action: 'evaluate', code: 'return document.title.length', as: 'titleLength' },
        { action: 'script', code: 'expect(vars.titleLength > 3, "title is too short")' },
      ],
    }, null, 2) + '\n',
    '.env.example': '# Read for {{env.NAME}} in scenarios. Copy to .env (git-ignored). Real environment variables win.\n# APP_USER=\n',
  };
  const created: string[] = [];
  for (const [rel, text] of Object.entries(files)) { await writeFile(path.join(dir, rel), text); created.push(rel); }
  if (!(await stat(path.join(dir, '.gitignore')).catch(() => null))) { await writeFile(path.join(dir, '.gitignore'), '.env\nreports/\n'); created.push('.gitignore'); }
  return created;
};
