#!/usr/bin/env node
import { glob, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateScenario } from './ai.ts';
import { explainScenario } from './explain.ts';
import { applyLock } from './lock.ts';
import { startPicker } from './picker.ts';
import { listProfiles, openProfile, profilePath } from './profile.ts';
import { loadScenario, missingReferences } from './load.ts';
import { PROJECT_FILE, ProjectError, initProject, listProject, loadProject, runProject } from './project.ts';
import { runScenario } from './runner.ts';
import { jsonSchema, projectJsonSchema } from './schema.ts';
import { startPortal } from './server.ts';

const USAGE = `scenario-browser <command>

  run <file> [--headed] [--var k=v] [--launcher mod] [--heal [--save-healed]] [--lock] [--no-ai]
  explain <file>                              print a scenario as plain sentences
  profile open <name> [url]                   open a persistent browser profile so you can log in (kept between runs)
  profile list                                list saved profiles
  pick <url>                                  open the page, click an element, get XPath/CSS/text/role suggestions
  validate <file|dir>...                      check scenarios/projects without a browser
  project init [dir]                          create scenario.project.json + samples
  project list [--dir d]                      scenarios and tags in a project
  project run [--dir d] [--tag t]... [--grep text] [--headed] [--heal] [--lock] [--no-ai] [--var k=v] [--report-dir d]
  generate "description" [-o file.json]       (experimental) AI writes a scenario; needs ANTHROPIC_API_KEY
  portal [--port 7070] [--project dir]        local web UI on 127.0.0.1
  schema [scenario|project]                   print a JSON Schema

Scenarios can contain JavaScript (evaluate / script). They are code: only run files you trust.
Only automate sites you own or have permission to automate.`;

const flag = (args: string[], name: string): boolean => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const multi = (args: string[], name: string): string[] => {
  const out: string[] = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) { const v = args[i + 1]; args.splice(i, 2); if (v !== undefined) out.push(v); }
  return out;
};
const option = (args: string[], name: string): string | undefined => multi(args, name).pop();
const parseVars = (pairs: string[]): Record<string, string> =>
  Object.fromEntries(pairs.map((p) => {
    const i = p.indexOf('=');
    if (i < 1) throw new ProjectError(`--var needs k=v, got "${p}"`);
    return [p.slice(0, i), p.slice(i + 1)];
  }));

const expand = async (paths: string[]): Promise<string[]> => {
  const files: string[] = [];
  for (const p of paths) {
    if ((await stat(p).catch(() => null))?.isDirectory()) {
      for await (const f of glob('**/*.{json,md}', { cwd: p })) {
        if (f.split(path.sep).some((s) => s === 'node_modules' || s === 'reports')) continue;
        files.push(path.join(p, f));
      }
    } else files.push(p);
  }
  return files.sort();
};

/** The nearest enclosing project file, if any, so references are checked against the project root. */
const projectRootFor = async (file: string): Promise<string> => {
  for (let d = path.resolve(path.dirname(file)); ; d = path.dirname(d)) {
    if (await stat(path.join(d, PROJECT_FILE)).catch(() => null)) return d;
    if (d === path.dirname(d)) return path.resolve(path.dirname(file));
  }
};

const main = async (argv: string[]): Promise<number> => {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'validate': {
      const files = await expand(args);
      if (!files.length) { console.error('no files'); return 2; }
      let bad = 0;
      for (const f of files) {
        try {
          if (path.basename(f) === PROJECT_FILE) { const lp = await loadProject(f); console.log(`ok   ${f} (project "${lp.project.name}")`); continue; }
          const s = await loadScenario(f);
          const problems = await missingReferences(s, path.dirname(path.resolve(f)), await projectRootFor(f));
          if (problems.length) throw new Error(`${f}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
          console.log(`ok   ${f} (${s.steps.length} steps)`);
        } catch (e) { bad++; console.error(`FAIL ${(e as Error).message}`); }
      }
      return bad ? 1 : 0;
    }
    case 'run': {
      const headed = flag(args, '--headed'), heal = flag(args, '--heal'), save = flag(args, '--save-healed');
      const lock = flag(args, '--lock'), noAi = flag(args, '--no-ai');
      const launcher = option(args, '--launcher');
      const vars = parseVars(multi(args, '--var'));
      const file = args[0];
      if (!file) { console.error(USAGE); return 2; }
      const report = await runScenario(await loadScenario(file), {
        file, headless: headed ? false : undefined, heal, noAi, log: console.log, overrideVars: vars,
        rootDir: await projectRootFor(file), ...(launcher ? { launcher } : {}),
      });
      if (lock) { const note = await applyLock(file, report); if (note) console.log(note); }
      if (report.healed && save) {
        if (!file.endsWith('.json')) console.error('--save-healed only writes .json scenarios; healed scenario not saved');
        else { await writeFile(file, JSON.stringify(report.healed, null, 2) + '\n'); console.log(`saved healed selectors to ${file}`); }
      }
      return report.status === 'passed' ? 0 : 1;
    }
    case 'project': {
      const [sub, ...rest] = args;
      if (sub === 'init') {
        const created = await initProject(rest[0] ?? '.');
        console.log(`created in ${rest[0] ?? '.'}:\n${created.map((c) => `  ${c}`).join('\n')}\nnext: node src/cli.ts project run --dir ${rest[0] ?? '.'}`);
        return 0;
      }
      const dir = option(rest, '--dir') ?? '.';
      const lp = await loadProject(dir);
      if (sub === 'list') {
        for (const s of await listProject(lp)) console.log(`${s.file}  "${s.name}"${s.tags.length ? `  [${s.tags.join(', ')}]` : ''}${s.hasJs ? '  (js)' : ''}${'error' in s ? '  INVALID' : ''}`);
        return 0;
      }
      if (sub === 'run') {
        const headed = flag(rest, '--headed'), heal = flag(rest, '--heal'), lock = flag(rest, '--lock'), noAi = flag(rest, '--no-ai');
        const tags = multi(rest, '--tag'), grep = option(rest, '--grep'), reportDir = option(rest, '--report-dir');
        const vars = parseVars(multi(rest, '--var'));
        const report = await runProject(lp, {
          tags, ...(grep ? { grep } : {}), ...(headed ? { headless: false } : {}), heal, lock, noAi, vars,
          ...(reportDir ? { reportDir } : {}), log: console.log,
        });
        console.log(`\n${report.status.toUpperCase()}: ${report.counts.passed}/${report.counts.total} passed, ${report.counts.failed} failed${report.note ? ` (${report.note})` : ''}`);
        return report.status === 'passed' ? 0 : 1;
      }
      console.error(USAGE); return 2;
    }
    case 'explain': {
      if (!args[0]) { console.error(USAGE); return 2; }
      console.log(explainScenario(await loadScenario(args[0])));
      return 0;
    }
    case 'profile': {
      const [sub, name, url] = args;
      if (sub === 'list') { for (const n of await listProfiles()) console.log(n); return 0; }
      if (sub !== 'open' || !name) { console.error(USAGE); return 2; }
      const ctx = await openProfile(name);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      if (url) await page.goto(url).catch((e) => console.error(String(e)));
      console.log(`Profile "${name}" (${profilePath(name)}). Log in, then close the window or press Ctrl+C to save and exit.`);
      await new Promise<void>((resolve) => { ctx.on('close', () => resolve()); process.once('SIGINT', () => resolve()); });
      await ctx.close().catch(() => {});
      return 0;
    }
    case 'pick': {
      if (!args[0]) { console.error(USAGE); return 2; }
      const session = await startPicker(args[0], {
        onPick: (p) => console.log(`\n<${p.tag}>${p.text ? ` "${p.text}"` : ''}\n${p.candidates.map((c) => `  ${c.selector}${c.matches === undefined ? '' : `   (${c.matches} match${c.matches === 1 ? '' : 'es'})`}`).join('\n')}`),
      });
      console.log('Click elements in the browser window; suggestions print here. Close the window or press Ctrl+C to stop.');
      await new Promise<void>((resolve) => { session.page.on('close', () => resolve()); process.once('SIGINT', () => resolve()); });
      await session.close().catch(() => {});
      return 0;
    }
    case 'generate': {
      const out = option(args, '-o');
      const description = args.join(' ').trim();
      if (!description) { console.error(USAGE); return 2; }
      const json = JSON.stringify(await generateScenario(description), null, 2) + '\n';
      if (out) { await writeFile(out, json); console.error(`wrote ${out}`); } else process.stdout.write(json);
      return 0;
    }
    case 'portal': {
      const port = Number(option(args, '--port') ?? 7070);
      let project = option(args, '--project');
      if (!project && (await stat(PROJECT_FILE).catch(() => null))) project = '.';
      const srv = await startPortal(port, '127.0.0.1', project ? await loadProject(project) : undefined);
      console.log(`portal on http://127.0.0.1:${port}${project ? ` (project: ${project})` : ''}  (Ctrl+C to stop)`);
      await new Promise(() => srv);
      return 0;
    }
    case 'schema': console.log(JSON.stringify(args[0] === 'project' ? projectJsonSchema() : jsonSchema(), null, 2)); return 0;
    default: console.log(USAGE); return cmd ? 2 : 0;
  }
};

main(process.argv.slice(2)).then((c) => process.exit(c), (e: Error) => { console.error(e.message); process.exit(e instanceof ProjectError ? 2 : 1); });
