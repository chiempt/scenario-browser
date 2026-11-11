import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parseScenarioText, missingReferences } from '../src/load.ts';
import { parseMarkdown } from '../src/markdown.ts';
import { runScenario } from '../src/runner.ts';
import { hasJs } from '../src/schema.ts';
import { interpolate } from '../src/template.ts';

const HTML = `<!doctype html><title>Fixture</title><h1 id="h">Hello</h1><ul><li>a</li><li>b</li></ul>
<button id="go" onclick="document.getElementById('o').textContent='clicked'">Go</button><p id="o"></p>`;
let site: Server; let base = '';
before(async () => {
  site = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
after(() => site.close());

const scn = (steps: unknown[], extra: object = {}) =>
  parseScenarioText(JSON.stringify({ name: 'steps test', timeout: 1500, baseUrl: base, steps, ...extra }), '.json');
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'sb-'));

test('template: env.X, dotted vars, non-string values', () => {
  assert.equal(interpolate('{{env.USER_X}}-{{a.b}}-{{n}}', { a: { b: 'deep' }, n: [1] }, { USER_X: 'u' }), 'u-deep-[1]');
  assert.throws(() => interpolate('{{env.NOPE}}', {}, {}), /unknown variable/);
});

test('relative url needs baseUrl and joins to it', async () => {
  const r = await runScenario(scn([{ action: 'goto', url: '/x' }, { action: 'expect', kind: 'title', value: 'Fixture' }]));
  assert.equal(r.status, 'passed', r.error);
  const noBase = parseScenarioText(JSON.stringify({ name: 'n', timeout: 500, steps: [{ action: 'goto', url: '/x' }] }), '.json');
  const f = await runScenario(noBase, { outDir: await tmp() });
  assert.equal(f.status, 'failed');
  assert.match(f.error ?? '', /needs a baseUrl/);
});

test('evaluate stores a value; script runs in node with page, vars, expect; expect js polls', async () => {
  const r = await runScenario(scn([
    { action: 'goto', url: '/' },
    { action: 'evaluate', code: 'return document.querySelectorAll("li").length + vars.extra', as: 'count' },
    { action: 'script', code: 'expect.equal(vars.count, 5); vars.title = await page.title();' },
    { action: 'expect', kind: 'js', value: 'vars.title === document.title' },
    { action: 'click', selector: '#go' },
    { action: 'expect', kind: 'js', value: "document.getElementById('o').textContent === 'clicked'" },
  ], { vars: { extra: 3 } }));
  assert.equal(r.status, 'passed', r.error);
  assert.equal(r.vars.count, 5);
  assert.equal(r.vars.extra, undefined, 'unchanged initial vars are not echoed in the report');
});

test('script failure and expect failure are reported with a failure screenshot', async () => {
  const out = await tmp();
  const r = await runScenario(scn([{ action: 'goto', url: '/' }, { action: 'script', code: 'expect(false, "boom")' }]), { outDir: out });
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /boom/);
  const shot = r.steps.find((s) => s.status === 'failed')?.screenshot;
  assert.ok(shot);
  assert.ok((await readdir(out)).includes(shot));
});

test('script file: resolved from scenario dir, refused outside the root, refused without a location', async () => {
  const root = await tmp();
  await mkdir(path.join(root, 'sub'));
  await writeFile(path.join(root, 'sub', 's.js'), 'vars.fromFile = "yes";');
  await writeFile(path.join(root, 'outside.js'), 'vars.bad = 1;');
  const file = path.join(root, 'sub', 'a.json');
  const ok = await runScenario(scn([{ action: 'goto', url: '/' }, { action: 'script', file: 's.js' }]), { file, rootDir: root });
  assert.equal(ok.vars.fromFile, 'yes');
  const up = await runScenario(scn([{ action: 'goto', url: '/' }, { action: 'script', file: '../../x.js' }]), { file, rootDir: path.join(root, 'sub'), outDir: await tmp() });
  assert.match(up.error ?? '', /outside the project/);
  const none = await runScenario(scn([{ action: 'goto', url: '/' }, { action: 'script', file: 's.js' }]), { outDir: await tmp() });
  assert.match(none.error ?? '', /run from a file or project/);
});

test('if / repeat / forEach', async () => {
  const r = await runScenario(scn([
    { action: 'goto', url: '/' },
    { action: 'evaluate', code: 'return 0', as: 'sum' },
    { action: 'repeat', times: 3, as: 'i', steps: [{ action: 'evaluate', code: 'return vars.sum + vars.i + 1', as: 'sum' }] },
    { action: 'forEach', items: 'letters', as: 'l', steps: [{ action: 'evaluate', code: 'return (vars.seen || "") + vars.l', as: 'seen' }] },
    { action: 'forEach', items: [10, 20], as: 'n', steps: [{ action: 'evaluate', code: 'return vars.n_index', as: 'lastIndex' }] },
    { action: 'if', when: { visible: '#h' }, then: [{ action: 'evaluate', code: 'return "then"', as: 'branch' }], else: [{ action: 'evaluate', code: 'return "else"', as: 'branch' }] },
    { action: 'if', when: { js: 'document.querySelectorAll("li").length > 5' }, then: [{ action: 'evaluate', code: 'return "many"', as: 'many' }], else: [{ action: 'evaluate', code: 'return "few"', as: 'many' }] },
  ], { vars: { letters: ['x', 'y', 'z'] } }));
  assert.equal(r.status, 'passed', r.error);
  assert.equal(r.vars.sum, 6);
  assert.equal(r.vars.seen, 'xyz');
  assert.equal(r.vars.lastIndex, 1);
  assert.equal(r.vars.branch, 'then');
  assert.equal(r.vars.many, 'few');
  assert.ok(r.steps.some((s) => s.path === '3.1' && s.depth === 1));
});

test('forEach over a non-array fails clearly', async () => {
  const r = await runScenario(scn([{ action: 'forEach', items: 'nope', as: 'x', steps: [{ action: 'wait', ms: 1 }] }]), { outDir: await tmp() });
  assert.match(r.error ?? '', /not an array/);
});

test('continueOnError ignores a failure; retry succeeds on a late element', async () => {
  const r = await runScenario(scn([
    { action: 'goto', url: '/' },
    { action: 'click', selector: '#missing', continueOnError: true },
    { action: 'evaluate', code: 'setTimeout(() => { const b = document.createElement("b"); b.id = "late"; b.textContent = "x"; document.body.append(b); }, 1800)' },
    { action: 'waitFor', selector: '#late', retry: 2 },
  ], { timeout: 1000 }), { outDir: await tmp() });
  assert.equal(r.status, 'passed', r.error);
  assert.equal(r.steps[1]?.status, 'ignored');
});

test('include runs a sub-scenario in the same page, passes vars, refuses cycles and escapes', async () => {
  const root = await tmp();
  await writeFile(path.join(root, 'child.json'), JSON.stringify({ name: 'child', steps: [{ action: 'goto', url: '/' }, { action: 'expect', kind: 'text', value: '{{word}}' }] }));
  await writeFile(path.join(root, 'loop.json'), JSON.stringify({ name: 'loop', steps: [{ action: 'include', file: 'loop.json' }] }));
  const file = path.join(root, 'main.json');
  const ok = await runScenario(scn([{ action: 'include', file: 'child.json', vars: { word: 'Hello' } }]), { file });
  assert.equal(ok.status, 'passed', ok.error);
  assert.ok(ok.steps.some((s) => s.path === '1.2'));
  const cyc = await runScenario(scn([{ action: 'include', file: 'loop.json' }]), { file, outDir: await tmp() });
  assert.match(cyc.steps.map((s) => s.error).join(), /cycle/);
  const esc = await runScenario(scn([{ action: 'include', file: '../x.json' }]), { file, outDir: await tmp() });
  assert.match(esc.steps[0]?.error ?? '', /outside the project/);
});

test('markdown: js blocks, tags, include, expect js', () => {
  const s = parseMarkdown('# T\ntags: a, b\n\n- include ./c.md\n- expect js "1 === 1"\n\n```js evaluate as n\nreturn 1;\n```\n\n```js\nexpect(true);\n```\n');
  assert.deepEqual(s.tags, ['a', 'b']);
  assert.deepEqual(s.steps.map((x) => x.action), ['include', 'expect', 'evaluate', 'script']);
  assert.equal((s.steps[2] as any).as, 'n');
  assert.equal(hasJs(s.steps), true);
  assert.throws(() => parseMarkdown('# T\n```js\nno end'), /unterminated/);
});

test('schema: script needs exactly one of code/file; nested errors carry a path', () => {
  assert.throws(() => scn([{ action: 'script' }]), /exactly one/);
  assert.throws(() => scn([{ action: 'script', code: 'x', file: 'y' }]), /exactly one/);
  assert.throws(() => scn([{ action: 'repeat', times: 2, steps: [{ action: 'expect', kind: 'js' }] }]), /steps\.0\.steps\.0/);
  assert.equal(hasJs(scn([{ action: 'goto', url: '/' }]).steps), false);
});

test('missingReferences flags absent and escaping files', async () => {
  const root = await tmp();
  const s = scn([{ action: 'include', file: 'nope.json' }, { action: 'script', file: '../up.js' }]);
  const p = await missingReferences(s, root);
  assert.equal(p.length, 2);
});
