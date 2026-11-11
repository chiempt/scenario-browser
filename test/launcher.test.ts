import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { loadLauncher, toSession } from '../src/launch.ts';
import { parseScenarioText } from '../src/load.ts';
import { runScenario } from '../src/runner.ts';

test('loadLauncher rejects modules without a function export', async () => {
  await assert.rejects(loadLauncher('./test/fixtures/no-function.mjs'), /must export/);
  await assert.rejects(loadLauncher('node:path'), /must export/);
});

test('toSession rejects values that are neither context nor page', async () => {
  await assert.rejects(toSession({}), /BrowserContext or Page/);
});

test('run uses the launcher module (fake launcher returns a Page with a marker header)', async () => {
  let seen = '';
  const srv = createServer((req, res) => { seen = String(req.headers['x-from-launcher']); res.end('<title>L</title><p>ok</p>'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const s = parseScenarioText(JSON.stringify({ name: 'l', timeout: 2000, steps: [
      { action: 'goto', url }, { action: 'expect', kind: 'text', value: 'ok' }] }), '.json');
    const r = await runScenario(s, { launcher: './test/fixtures/fake-launcher.mjs' });
    assert.equal(r.status, 'passed', r.error);
    assert.equal(seen, '1');
    assert.deepEqual((globalThis as any).__launcherCalls, [{ headless: true }]);
  } finally { srv.close(); }
});
