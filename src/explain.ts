import type { Scenario, Step } from './schema.ts';

const q = (s: string): string => `"${s}"`;

const target = (s: { selector?: string; ai?: string }): string => {
  const sel = s.selector ?? '';
  if (/^ai=/i.test(sel)) return `the element described as ${q(sel.slice(3).trim())} (AI finds it)`;
  const m = /^(xpath|css|text|role|testid|label|placeholder)=(.*)$/is.exec(sel);
  const what = !m ? (sel.startsWith('//') || sel.startsWith('(//') ? `the element at XPath ${sel}` : `the element ${sel}`)
    : ({
      xpath: `the element at XPath ${m[2]}`, css: `the element ${m[2]}`, text: `the element with text ${q(m[2]!)}`,
      role: `the ${m[2]!.replace(/\[name=(.*)\]$/, ' named $1')}`, testid: `the element with test id ${q(m[2]!)}`,
      label: `the field labelled ${q(m[2]!)}`, placeholder: `the field with placeholder ${q(m[2]!)}`,
    } as Record<string, string>)[m[1]!.toLowerCase()]!;
  return s.ai && !/^ai=/i.test(sel) ? `${what} (found by AI for ${q(s.ai)}, locked)` : what;
};

const line = (s: Step): string => {
  switch (s.action) {
    case 'goto': return `Open ${s.url}`;
    case 'click': return `Click ${target(s)}`;
    case 'fill': return `Type ${q(s.value)} into ${target(s)}`;
    case 'press': return s.selector ? `Press ${s.key} in ${target(s)}` : `Press ${s.key}`;
    case 'select': return `Choose ${q(s.value)} in ${target(s)}`;
    case 'check': return `Tick ${target(s)}`;
    case 'wait': return `Wait ${s.ms} ms`;
    case 'waitFor': return `Wait until ${target(s)} appears`;
    case 'expect':
      if (s.kind === 'visible') return `Check that ${target(s)} is visible`;
      if (s.kind === 'js') return `Check that this JavaScript is true: ${s.value}`;
      return `Check that the ${s.kind === 'text' ? (s.selector ? `text of ${target(s)}` : 'page text') : s.kind} contains ${q(s.value ?? '')}`;
    case 'extract': return `Read the text of ${target(s)} and keep it as {{${s.as}}}`;
    case 'screenshot': return `Take a screenshot (${s.path})`;
    case 'evaluate': return `Run JavaScript in the page${s.as ? `, keep the result as {{${s.as}}}` : ''}`;
    case 'script': return s.file ? `Run the Node script ${s.file}` : 'Run an inline Node script';
    case 'include': return `Run the steps of ${s.file}`;
    case 'if': return `If ${'js' in s.when ? `this JavaScript is true: ${s.when.js}` : `${target({ selector: s.when.visible })} is visible`}:`;
    case 'repeat': return `Repeat ${s.times} times${s.as ? ` (counter {{${s.as}}})` : ''}:`;
    case 'forEach': return `For each item in ${typeof s.items === 'string' ? s.items : 'the list'} (as {{${s.as}}}):`;
  }
};

const render = (steps: readonly Step[], prefix: string, indent: string, out: string[]): void => {
  steps.forEach((s, i) => {
    const n = `${prefix}${i + 1}`;
    const flags = [s.retry ? `retry up to ${s.retry}x` : '', s.continueOnError ? 'carry on if it fails' : ''].filter(Boolean).join(', ');
    out.push(`${indent}${n}. ${line(s)}${flags ? ` [${flags}]` : ''}${s.note ? `  (${s.note})` : ''}`);
    if (s.action === 'if') {
      render(s.then, `${n}.`, `${indent}   `, out);
      if (s.else) { out.push(`${indent}   otherwise:`); render(s.else, `${n}e.`, `${indent}   `, out); }
    } else if (s.action === 'repeat' || s.action === 'forEach') render(s.steps, `${n}.`, `${indent}   `, out);
  });
};

/** A scenario as plain sentences, for a person who does not read JSON. */
export const explainScenario = (sc: Scenario): string => {
  const out: string[] = [`Scenario: ${sc.name}`];
  if (sc.description) out.push(sc.description);
  if (sc.tags?.length) out.push(`Tags: ${sc.tags.join(', ')}`);
  if (sc.baseUrl) out.push(`Base URL: ${sc.baseUrl}`);
  out.push('');
  render(sc.steps, '', '', out);
  return out.join('\n');
};
