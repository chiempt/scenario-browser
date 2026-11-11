import assert from 'node:assert/strict';
import { createServer as http, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.ts';

let site: Server; let base = ''; let dir = ''; let client: Client;
before(async () => {
  site = http((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Fixture</title><h1>Hi</h1>'); });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  dir = await mkdtemp(path.join(tmpdir(), 'sb-mcp-'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ workDir: dir }).connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});
after(async () => { await client.close(); site.close(); });

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content as { text: string }[])[0].text;
  return { isError: Boolean(r.isError), text: t };
};
const scn = (steps: unknown[]) => JSON.stringify({ name: 't', timeout: 2000, steps });

test('lists exactly validate, run, get_schema', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_schema', 'run', 'validate']);
});

test('get_schema returns a JSON schema', async () => {
  const r = await call('get_schema');
  assert.ok(JSON.parse(r.text).properties.steps);
});

test('validate accepts good and rejects bad scenarios', async () => {
  const ok = JSON.parse((await call('validate', { scenario: scn([{ action: 'goto', url: base }]) })).text);
  assert.equal(ok.ok, true);
  const bad = JSON.parse((await call('validate', { scenario: scn([{ action: 'nope' }]) })).text);
  assert.equal(bad.ok, false);
});

test('run executes a scenario and reports steps', async () => {
  const r = await call('run', { scenario: scn([{ action: 'goto', url: base }, { action: 'expect', kind: 'title', value: 'Fixture' }]) });
  assert.equal(r.isError, false, r.text);
  const rep = JSON.parse(r.text);
  assert.equal(rep.status, 'passed');
  assert.equal(rep.steps.length, 2);
});

test('run refuses JavaScript steps unless allowScript', async () => {
  const s = scn([{ action: 'goto', url: base }, { action: 'evaluate', code: 'return 1', as: 'x' }]);
  const refused = await call('run', { scenario: s });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /allowScript/);
  const allowed = await call('run', { scenario: s, allowScript: true });
  assert.equal(allowed.isError, false, allowed.text);
});

test('run refuses JS reached through an include', async () => {
  await writeFile(path.join(dir, 'js.json'), scn([{ action: 'script', code: 'vars.a = 1' }]));
  const r = await call('run', { scenario: scn([{ action: 'include', file: 'js.json' }]) });
  assert.equal(r.isError, true);
  assert.match(r.text, /allowScript/);
});

test('run blocks paths outside the working directory', async () => {
  const r = await call('run', { path: '../outside.json' });
  assert.equal(r.isError, true);
  assert.match(r.text, /outside/);
});

test('run loads a file inside the working directory', async () => {
  await writeFile(path.join(dir, 'ok.json'), scn([{ action: 'goto', url: base }]));
  const r = await call('run', { path: 'ok.json' });
  assert.equal(r.isError, false, r.text);
});
