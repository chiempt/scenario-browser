import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { explainScenario } from '../src/explain.ts';
import { loadContext } from '../src/context.ts';
import { loadScenario, parseScenarioText } from '../src/load.ts';
import { applyLock, lockMarkdown } from '../src/lock.ts';
import { startPicker } from '../src/picker.ts';
import { runScenario } from '../src/runner.ts';
import { parseRole } from '../src/selector.ts';

const HTML = `<!doctype html><title>Shop</title>
<header><a id="top-login" data-testid="login-link" href="/login?token=SECRET">Đăng nhập</a></header>
<label for="q">Search</label><input id="q" placeholder="Find products" value="PRIVATE-VALUE">
<textarea id="t">TEXTAREA-SECRET</textarea>
<button id="go" onclick="document.getElementById('o').textContent='clicked'">Buy now</button><p id="o"></p>`;

let site: Server; let base = '';
before(async () => {
  site = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
after(() => site.close());

const scn = (steps: unknown[], extra: object = {}) => parseScenarioText(JSON.stringify({ name: 't', timeout: 2000, steps, ...extra }), '.json');
const fakeAi = (replies: string[], seen: any[] = []): typeof fetch =>
  (async (_u: unknown, init: any) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: replies.shift() ?? '{"selector":null,"reason":"x"}' }] }), { status: 200 });
  }) as typeof fetch;

test('selector kinds: xpath=, css=, role, testid, placeholder, label, text, legacy bare', async () => {
  const r = await runScenario(scn([
    { action: 'goto', url: base },
    { action: 'expect', kind: 'visible', selector: 'xpath=//button[@id="go"]' },
    { action: 'expect', kind: 'visible', selector: '//button[normalize-space()="Buy now"]' },
    { action: 'expect', kind: 'visible', selector: 'css=#go' },
    { action: 'expect', kind: 'visible', selector: 'text=Buy now' },
    { action: 'expect', kind: 'visible', selector: 'testid=login-link' },
    { action: 'expect', kind: 'visible', selector: 'placeholder=Find products' },
    { action: 'expect', kind: 'visible', selector: 'label=Search' },
    { action: 'click', selector: 'role=button[name="Buy now"]' },
    { action: 'expect', kind: 'text', selector: '#o', value: 'clicked' },
  ]));
  assert.equal(r.status, 'passed', r.error);
  assert.deepEqual(parseRole('role=button[name=Sign in]'), { role: 'button', name: 'Sign in' });
  assert.deepEqual(parseRole('role=link'), { role: 'link' });
});

test('markdown: prefixes, quoted prefix, ai= token and the lock comment', () => {
  const s = parseScenarioText(`# T
- click xpath=//a[@id='x']
- click "role=button[name=\\"Sign in\\"]"
- click "Login"
- click ai="the Sign in button"
- click "css=#go" <!-- ai="the go button" -->
`, '.md');
  const sels = s.steps.map((x: any) => x.selector);
  assert.deepEqual(sels, ["xpath=//a[@id='x']", 'role=button[name="Sign in"]', 'text=Login', 'ai=the Sign in button', 'css=#go']);
  assert.equal((s.steps[4] as any).ai, 'the go button');
});

test('ai=: no key gives a clear error before any browser opens', async () => {
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(runScenario(scn([{ action: 'goto', url: base }, { action: 'click', selector: 'ai=the buy button' }])), /ANTHROPIC_API_KEY is not set/);
  } finally { if (saved) process.env.ANTHROPIC_API_KEY = saved; }
});

test('ai=: --no-ai refuses an unlocked step', async () => {
  await assert.rejects(runScenario(scn([{ action: 'click', selector: 'ai=x' }]), { noAi: true }), /--no-ai/);
});

test('ai=: finds the element with context, never sends field values, and reports a lockable scenario', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sb-ctx-'));
  await writeFile(path.join(dir, 'context.md'), 'This is a shop. "Mua ngay" means Buy now.');
  await writeFile(path.join(dir, 'scenario.project.json'), JSON.stringify({ name: 'p', context: 'Project says: staging env.' }));
  const seen: any[] = [];
  const r = await runScenario(scn([
    { action: 'goto', url: base },
    { action: 'click', selector: 'ai=nút Mua ngay' },
    { action: 'expect', kind: 'text', selector: '#o', value: 'clicked' },
  ], { context: 'Scenario note.' }), {
    rootDir: dir, ai: { apiKey: 'k', fetchImpl: fakeAi(['{"selector":"role=button[name=\\"Buy now\\"]","reason":"Mua ngay = Buy now"}'], seen) },
  });
  assert.equal(r.status, 'passed', r.error);
  const sent = seen[0].messages[0].content as string;
  assert.match(sent, /Mua ngay. means Buy now/);
  assert.match(sent, /staging env/);
  assert.match(sent, /Scenario note/);
  assert.match(sent, /nút Mua ngay/);
  for (const secret of ['PRIVATE-VALUE', 'TEXTAREA-SECRET', 'SECRET']) assert.ok(!sent.includes(secret), `leaked ${secret}`);
  assert.equal((r.locked?.steps[1] as any).selector, 'role=button[name="Buy now"]');
  assert.equal((r.locked?.steps[1] as any).ai, 'nút Mua ngay');
  assert.equal(r.picks?.length, 1);
});

test('ai=: a selector that matches nothing is rejected, not locked', async () => {
  const r = await runScenario(scn([{ action: 'goto', url: base }, { action: 'click', selector: 'ai=thing' }]), {
    ai: { apiKey: 'k', fetchImpl: fakeAi(['{"selector":"css=#nope","reason":"guess"}']) },
  });
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /matches nothing/);
  assert.equal(r.locked, undefined);
});

test('lock: JSON file is rewritten, then runs with --no-ai and no key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sb-lock-'));
  const file = path.join(dir, 's.json');
  await writeFile(file, JSON.stringify({ name: 'lock me', timeout: 2000, steps: [
    { action: 'goto', url: base }, { action: 'click', selector: 'ai=the buy button' },
  ] }));
  const r = await runScenario(await loadScenario(file), { file, ai: { apiKey: 'k', fetchImpl: fakeAi(['{"selector":"#go","reason":"id"}']) } });
  assert.match((await applyLock(file, r)) ?? '', /locked 1/);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.steps[1].selector, '#go');
  assert.equal(saved.steps[1].ai, 'the buy button');
  const saved2 = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    const again = await runScenario(await loadScenario(file), { file, noAi: true });
    assert.equal(again.status, 'passed', again.error);
  } finally { if (saved2) process.env.ANTHROPIC_API_KEY = saved2; }
});

test('lock: Markdown line becomes selector + comment and re-parses', () => {
  const src = '# T\n- goto /\n- click ai="the buy button"\n';
  const { text, applied } = lockMarkdown(src, [{ ai: 'the buy button', selector: 'role=button[name="Buy now"]' }]);
  assert.equal(applied, 1);
  const s = parseScenarioText(text, '.md');
  assert.equal((s.steps[1] as any).selector, 'role=button[name="Buy now"]');
  assert.equal((s.steps[1] as any).ai, 'the buy button');
});

test('context: reads project field and context.md', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sb-c-'));
  assert.equal(await loadContext(dir), '');
  await writeFile(path.join(dir, 'context.md'), 'md part');
  await writeFile(path.join(dir, 'scenario.project.json'), JSON.stringify({ name: 'p', context: 'json part' }));
  assert.equal(await loadContext(dir), 'json part\n\nmd part');
});

test('explain: plain sentences incl. ai and locked steps', () => {
  const out = explainScenario(scn([
    { action: 'goto', url: 'https://example.com' },
    { action: 'click', selector: 'role=button[name="Sign in"]' },
    { action: 'click', selector: 'ai=the cart icon' },
    { action: 'fill', selector: 'label=Email', value: 'a@b.c' },
    { action: 'click', selector: '#go', ai: 'buy button' },
    { action: 'if', when: { visible: 'css=.banner' }, then: [{ action: 'click', selector: 'text=Close' }] },
  ]));
  assert.match(out, /1\. Open https:\/\/example.com/);
  assert.match(out, /Click the button named "Sign in"/);
  assert.match(out, /AI finds it/);
  assert.match(out, /Type "a@b.c" into the field labelled "Email"/);
  assert.match(out, /found by AI for "buy button", locked/);
  assert.match(out, /6\.1\. Click the element with text "Close"/);
});

test('picker: a real click is captured and returns XPath, CSS, text and role suggestions', async () => {
  const p = await startPicker(base, { headless: true });
  try {
    await p.page.click('#go');
    await p.page.waitForTimeout(200);
    assert.equal(await p.page.locator('#o').innerText(), '', 'the page click handler must not run in pick mode');
    const pick = p.last();
    assert.ok(pick, 'no pick recorded');
    assert.equal(pick.tag, 'button');
    const sels = pick.candidates.map((c) => c.selector);
    assert.ok(sels.includes('xpath=//*[@id="go"]'));
    assert.ok(sels.includes('css=#go'));
    assert.ok(sels.includes('text=Buy now'));
    assert.ok(sels.includes('role=button[name="Buy now"]'));
    assert.equal(pick.candidates.find((c) => c.selector === 'css=#go')?.matches, 1);
    await p.page.click('#q');
    await p.page.waitForTimeout(200);
    assert.ok(!JSON.stringify(p.last()).includes('PRIVATE-VALUE'));
    await assert.rejects(startPicker('file:///etc/passwd'), /http\(s\)/);
  } finally { await p.close(); }
});
