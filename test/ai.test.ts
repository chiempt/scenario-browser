import assert from 'node:assert/strict';
import { test } from 'node:test';
import { complete, extractJson, generateScenario, suggestSelector } from '../src/ai.ts';

const fakeFetch = (replies: string[], seen: { body?: any; headers?: any }[] = []): typeof fetch =>
  (async (_url: unknown, init: any) => {
    seen.push({ body: JSON.parse(init.body), headers: init.headers });
    const text = replies.shift() ?? '';
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
  }) as typeof fetch;

const GOOD = JSON.stringify({ name: 'n', steps: [{ action: 'goto', url: 'https://example.com' }] });

test('complete: refuses without ANTHROPIC_API_KEY', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try { await assert.rejects(complete('s', 'u'), /ANTHROPIC_API_KEY/); }
  finally { if (saved) process.env.ANTHROPIC_API_KEY = saved; }
});

test('extractJson handles fences and chatter', () => {
  assert.equal(extractJson('Sure!\n```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('here {"a":1} done'), '{"a":1}');
  assert.throws(() => extractJson('nothing'), /no JSON/);
});

test('generate: returns a valid scenario and sends the key as a header only', async () => {
  const seen: any[] = [];
  const s = await generateScenario('open example', { apiKey: 'test-key', fetchImpl: fakeFetch(['```json\n' + GOOD + '\n```'], seen) });
  assert.equal(s.name, 'n');
  assert.equal(seen[0].headers['x-api-key'], 'test-key');
  assert.ok(!JSON.stringify(seen[0].body).includes('test-key'));
});

test('generate: one repair round, then gives up with a clear error', async () => {
  const s = await generateScenario('x', { apiKey: 'k', fetchImpl: fakeFetch(['{"name":"n","steps":[]}', GOOD]) });
  assert.equal(s.steps.length, 1);
  await assert.rejects(generateScenario('x', { apiKey: 'k', fetchImpl: fakeFetch(['{}', '{}']) }), /valid scenario after 2/);
});

test('suggestSelector parses a reply and handles null', async () => {
  const dom = [{ tag: 'button', css: '#go', id: 'go', text: 'Go' }];
  const a = await suggestSelector({ action: 'click', selector: '#old' }, 'timeout', dom, { apiKey: 'k', fetchImpl: fakeFetch(['{"selector":"#go","reason":"id renamed"}']) });
  assert.deepEqual(a, { selector: '#go', reason: 'id renamed' });
  const b = await suggestSelector({}, 'e', dom, { apiKey: 'k', fetchImpl: fakeFetch(['{"selector":null,"reason":"none"}']) });
  assert.equal(b, null);
});
