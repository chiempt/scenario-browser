import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { discoverScenarios, filterScenarios, initProject, listProject, loadProject, parseEnv, runProject } from '../src/project.ts';
import { startPortal } from '../src/server.ts';

const run = promisify(execFile);
const CLI = path.resolve('src/cli.ts');
let site: Server; let base = '';
before(async () => {
  site = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>P</title><h1>Project fixture</h1>'); });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
after(() => site.close());

const mkProject = async (extra: object = {}, failing = false) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sbp-'));
  await mkdir(path.join(dir, 'scenarios')); await mkdir(path.join(dir, 'setup'));
  await writeFile(path.join(dir, 'scenario.project.json'), JSON.stringify({
    name: 'tmp project', baseUrl: base, vars: { who: 'project' }, envFile: '.env', defaults: { timeout: 1500 },
    setup: ['setup/s.json'], ...extra,
  }));
  await writeFile(path.join(dir, '.env'), '# c\nSECRET_WORD="Project"\nOTHER=1\n');
  await writeFile(path.join(dir, 'setup', 's.json'), JSON.stringify({ name: 'setup', steps: [{ action: 'goto', url: '/' }, { action: 'extract', selector: 'h1', as: 'heading' }] }));
  await writeFile(path.join(dir, 'scenarios', 'a.json'), JSON.stringify({ name: 'alpha', tags: ['smoke'], steps: [
    { action: 'goto', url: '/' }, { action: 'expect', kind: 'text', value: '{{env.SECRET_WORD}}' }, { action: 'expect', kind: 'js', value: 'vars.heading === "Project fixture" && vars.who === "cli"' }] }));
  await writeFile(path.join(dir, 'scenarios', 'b.md'), `# beta\ntags: slow, smoke\n\n- goto /\n- expect text "${failing ? 'absent text' : 'fixture'}"\n`);
  return dir;
};

test('parseEnv handles comments, quotes, export', () => {
  assert.deepEqual(parseEnv('# x\nA=1\nexport B="two words"\nC=\'q\'\n  D = 4 \n'), { A: '1', B: 'two words', C: 'q', D: '4' });
});

test('discover, tag and grep filters, list; setup files are not tests', async () => {
  const lp = await loadProject(await mkProject());
  const all = await discoverScenarios(lp);
  assert.deepEqual(all.map((d) => d.rel), ['scenarios/a.json', 'scenarios/b.md']);
  assert.deepEqual(filterScenarios(all, ['slow']).map((d) => d.scenario?.name), ['beta']);
  assert.deepEqual(filterScenarios(all, ['smoke']).length, 2);
  assert.deepEqual(filterScenarios(all, [], 'ALP').map((d) => d.scenario?.name), ['alpha']);
  assert.equal((await listProject(lp))[1]?.tags.join(), 'slow,smoke');
});

test('project run: setup vars, env file, --var precedence, baseUrl, report files', async () => {
  const dir = await mkProject();
  const rep = await runProject(await loadProject(dir), { vars: { who: 'cli' } });
  assert.equal(rep.status, 'passed', JSON.stringify(rep.scenarios.map((s) => s.error)));
  assert.deepEqual(rep.counts, { total: 2, passed: 2, failed: 0 });
  assert.deepEqual(rep.scenarios.map((s) => s.phase), ['setup', 'test', 'test']);
  const json = JSON.parse(await readFile(path.join(dir, 'reports', 'report.json'), 'utf8'));
  assert.equal(json.counts.total, 2);
  const html = await readFile(path.join(dir, 'reports', 'report.html'), 'utf8');
  assert.match(html, /tmp project/);
  assert.ok(!html.includes('Project</'), 'env values are not rendered');
});

test('failure: html lists the failed step with a screenshot; filters apply; setup failure skips tests', async () => {
  const dir = await mkProject({}, true);
  const rep = await runProject(await loadProject(dir), { vars: { who: 'cli' }, tags: ['slow'] });
  assert.equal(rep.status, 'failed');
  assert.deepEqual(rep.counts, { total: 1, passed: 0, failed: 1 });
  const shots = await readdir(path.join(dir, 'reports', 'shots'));
  assert.equal(shots.length, 1);
  assert.ok((await readFile(path.join(dir, 'reports', 'report.html'), 'utf8')).includes(shots[0]!));
  await writeFile(path.join(dir, 'setup', 's.json'), JSON.stringify({ name: 'setup', steps: [{ action: 'goto', url: '/' }, { action: 'expect', kind: 'text', value: 'nope' }] }));
  const rep2 = await runProject(await loadProject(dir));
  assert.equal(rep2.status, 'failed');
  assert.equal(rep2.counts.total, 0);
  assert.match(rep2.note ?? '', /setup failed/);
});

test('project run with no matching scenarios throws', async () => {
  await assert.rejects(runProject(await loadProject(await mkProject()), { tags: ['nothing'] }), /no scenarios matched/);
});

test('project init creates a valid project', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'sbi-')), 'proj');
  const created = await initProject(dir);
  assert.ok(created.includes('scenario.project.json'));
  const lp = await loadProject(dir);
  assert.equal((await listProject(lp)).length, 2);
  await assert.rejects(initProject(dir), /already exists/);
});

test('CLI exit codes: 0 pass, 1 fail, 2 config error; --var and --tag work', async () => {
  const good = await mkProject();
  const ok = await run('node', [CLI, 'project', 'run', '--dir', good, '--var', 'who=cli']);
  assert.match(ok.stdout, /PASSED: 2\/2/);
  const bad = await mkProject({}, true);
  await assert.rejects(run('node', [CLI, 'project', 'run', '--dir', bad, '--var', 'who=cli']), (e: any) => e.code === 1);
  await assert.rejects(run('node', [CLI, 'project', 'run', '--dir', path.join(os.tmpdir(), 'no-such-project-dir')]), (e: any) => e.code === 2);
  await assert.rejects(run('node', [CLI, 'project', 'run', '--dir', good, '--tag', 'zzz']), (e: any) => e.code === 2);
  const v = await run('node', [CLI, 'validate', good]);
  assert.match(v.stdout, /project "tmp project"/);
});

test('portal: project list, project run, report served, js needs confirmation, cross-origin refused', async () => {
  const dir = await mkProject();
  const srv = await startPortal(0, '127.0.0.1', await loadProject(dir));
  const port = (srv.address() as AddressInfo).port;
  const u = (p: string) => `http://127.0.0.1:${port}${p}`;
  const post = (p: string, body: object, headers: Record<string, string> = {}) =>
    fetch(u(p), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const info = (await (await fetch(u('/api/project'))).json()) as any;
    assert.equal(info.project.scenarios.length, 2);
    assert.equal(info.project.scenarios[0].hasJs, true);
    const res = (await (await post('/api/project/run', { tags: ['slow'] })).json()) as any;
    assert.equal(res.ok, true, JSON.stringify(res));
    const html = await fetch(u('/reports/report.html'));
    assert.equal(html.status, 200);
    assert.equal((await fetch(u('/reports/..%2f..%2fscenario.project.json'))).status, 404);

    const withJs = { text: '# j\n- goto /\n```js\nexpect(true)\n```\n', format: 'md' };
    const v = (await (await post('/api/validate', withJs)).json()) as any;
    assert.equal(v.hasJs, true);
    const refused = await post('/api/run', withJs);
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as any).needsConfirm, true);
    const okRun = (await (await post('/api/run', { ...withJs, confirmJs: true })).json()) as any;
    assert.equal(okRun.ok, true, JSON.stringify(okRun));

    assert.equal((await post('/api/run', withJs, { origin: 'http://evil.example' })).status, 403);
    const form = await fetch(u('/api/run'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...withJs, confirmJs: true }) });
    assert.equal(form.status, 415);
  } finally { srv.close(); }
});
