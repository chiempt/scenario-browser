import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkdown, MarkdownError } from '../src/markdown.ts';
import { parseScenarioText, ScenarioFileError } from '../src/load.ts';
import { interpolate } from '../src/template.ts';

test('markdown: all step kinds parse', () => {
  const s = parseMarkdown(`# Demo
Some description.
- set who = "Ann"
- goto https://example.com
- click "Login"
- fill #q "hello world"
- fill label=Email "a@b.c"
- press Enter
- press #q Tab
- select #c "VN"
- check #agree
- wait 250
- waitFor .r
- expect text "Example"
- expect text h1 "Example"
- expect url "example.com"
- expect title "Ex"
- expect visible h1
- extract h1 as heading
- screenshot a.png
`);
  assert.equal(s.name, 'Demo');
  assert.equal(s.vars?.who, 'Ann');
  assert.deepEqual(s.steps[1], { action: 'click', selector: 'text=Login' });
  assert.deepEqual(s.steps[2], { action: 'fill', selector: '#q', value: 'hello world' });
  assert.deepEqual(s.steps[4], { action: 'press', key: 'Enter' });
  assert.deepEqual(s.steps[11], { action: 'expect', kind: 'text', selector: 'h1', value: 'Example' });
  assert.equal(s.steps.length, 17);
});

test('markdown: bad input is rejected with a message', () => {
  assert.throws(() => parseMarkdown('- goto https://x.com'), MarkdownError);
  assert.throws(() => parseMarkdown('# T\n- teleport home'), /unknown step/);
  assert.throws(() => parseMarkdown('# T\n- click "oops'), /unterminated/);
  assert.throws(() => parseMarkdown('# T\n- wait soon'), /milliseconds/);
});

test('json: valid scenario passes, unknown key and bad url fail', () => {
  const ok = { name: 'x', steps: [{ action: 'goto', url: 'https://example.com' }] };
  assert.equal(parseScenarioText(JSON.stringify(ok), '.json').name, 'x');
  assert.throws(() => parseScenarioText(JSON.stringify({ ...ok, timout: 5 }), '.json'), ScenarioFileError);
  const bad = { name: 'x', steps: [{ action: 'goto', url: 'javascript:alert(1)' }] };
  assert.throws(() => parseScenarioText(JSON.stringify(bad), '.json'), /http/);
  assert.throws(() => parseScenarioText('{', '.json'), /not valid JSON/);
});

test('json: expect needs value or selector as appropriate', () => {
  const mk = (step: unknown) => JSON.stringify({ name: 'x', steps: [step] });
  assert.throws(() => parseScenarioText(mk({ action: 'expect', kind: 'text' }), '.json'), /needs "value"/);
  assert.throws(() => parseScenarioText(mk({ action: 'expect', kind: 'visible' }), '.json'), /needs "selector"/);
});

test('markdown and json go through the same validation', () => {
  const s = parseScenarioText('# T\n- goto https://example.com\n', '.md');
  assert.equal(s.steps[0]?.action, 'goto');
});

test('interpolate: substitutes and rejects unknown variables', () => {
  assert.equal(interpolate('hi {{ a }}!', { a: 'x' }), 'hi x!');
  assert.throws(() => interpolate('{{nope}}', {}), /unknown variable/);
});
