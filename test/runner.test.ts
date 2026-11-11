import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { parseScenarioText } from '../src/load.ts';
import { runScenario } from '../src/runner.ts';
import { startPortal } from '../src/server.ts';

const HTML = `<!doctype html><title>Fixture</title><h1 id="h">Hello Fixture</h1>
<label for="n">Your name</label><input id="n"><button id="go" onclick="document.getElementById('o').textContent='Hi '+document.getElementById('n').value">Send</button>
<p id="o"></p>`;

let site: Server; let base = '';
before(async () => {
  site = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
after(() => site.close());

const scn = (steps: unknown[], extra: object = {}) =>
  parseScenarioText(JSON.stringify({ name: 't', timeout: 2000, steps, ...extra }), '.json');

test('runs a full scenario on a local page', async () => {
  const r = await runScenario(scn([
    { action: 'goto', url: base },
    { action: 'expect', kind: 'title', value: 'Fixture' },
    { action: 'extract', selector: '#h', as: 'h' },
    { action: 'fill', selector: 'label=Your name', value: 'Ann' },
    { action: 'click', selector: 'text=Send' },
    { action: 'expect', kind: 'text', selector: '#o', value: 'Hi Ann' },
    { action: 'expect', kind: 'text', value: '{{h}}' },
  ]));
  assert.equal(r.status, 'passed', r.error);
  assert.equal(r.vars.h, 'Hello Fixture');
});

test('a failing expect reports the step and fails', async () => {
  const r = await runScenario(scn([
    { action: 'goto', url: base },
    { action: 'expect', kind: 'text', value: 'not on this page' },
  ]));
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /step 2/);
});

test('without --heal a broken selector fails', async () => {
  const r = await runScenario(scn([{ action: 'goto', url: base }, { action: 'click', selector: '#old-id' }]));
  assert.equal(r.status, 'failed');
});

test('--heal swaps a broken selector using the (mocked) model and reports it', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"selector":"#go","reason":"renamed"}' }] }))) as typeof fetch;
  const r = await runScenario(scn([
    { action: 'goto', url: base },
    { action: 'fill', selector: '#n', value: 'Bo' },
    { action: 'click', selector: '#old-id' },
    { action: 'expect', kind: 'text', selector: '#o', value: 'Hi Bo' },
  ]), { heal: true, ai: { apiKey: 'k', fetchImpl } });
  assert.equal(r.status, 'passed', r.error);
  assert.equal(r.steps[2]?.status, 'healed');
  assert.equal((r.healed?.steps[2] as any).selector, '#go');
});

test('portal: validate and run over HTTP, rejects foreign Host', async () => {
  const srv = await startPortal(0);
  const port = (srv.address() as AddressInfo).port;
  try {
    const post = (p: string, body: object, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
    const md = `# P\n- goto ${base}\n- expect text "Hello Fixture"\n`;
    assert.equal((await post('/api/validate', { text: md, format: 'md' })).steps, 2);
    assert.equal((await post('/api/validate', { text: '{}', format: 'json' })).ok, false);
    const run = await post('/api/run', { text: md, format: 'md' });
    assert.equal(run.ok, true);
    assert.ok(run.log.length > 0);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await page.text(), /scenario-browser/);
  } finally { srv.close(); }
});
