import { KIND_PREFIX } from './selector.ts';
import type { Scenario, Step } from './schema.ts';

/**
 * Markdown scenarios: a `# Title`, optional paragraph lines, then one step per
 * `- ` bullet.
 *
 *   - goto https://example.com
 *   - click "Login"              quoted = visible text (text=Login)
 *   - click #submit              unquoted = CSS/XPath/Playwright selector
 *   - fill #q "hello"
 *   - fill label=Email "a@b.c"
 *   - press Enter                or: press #q Enter
 *   - select #country "VN"
 *   - check #agree
 *   - wait 500                   milliseconds
 *   - waitFor .results
 *   - expect text "Example Domain"
 *   - expect url "example.com"
 *   - expect title "Example"
 *   - expect visible h1
 *   - extract h1 as heading
 *   - screenshot out.png
 *
 * Selector prefixes work unquoted: xpath=//a[@id='x'], css=.card, role=button,
 * testid=go, label=Email, placeholder=Search. If a selector has spaces, quote it
 * ("role=button[name=\"Sign in\"]"); a quoted token that starts with a prefix
 * is used as is. `ai="the Sign in button"` asks the AI to find the element;
 * `--lock` rewrites it to the found selector plus a trailing
 * <!-- ai="the Sign in button" --> comment that keeps your words.
 *
 * `set name = value` bullets define {{name}} variables.
 *
 *   tags: smoke, login          (a line before the steps)
 *   - include ./login.md
 *   - expect js "document.title.length > 0"
 *
 * A fenced ```js block is a Node-side `script` step (page, vars, env, expect in
 * scope). ```js evaluate as name  runs inside the page and stores the result.
 * Control flow (if/repeat/forEach), retry and continueOnError are JSON-only.
 */
export class MarkdownError extends Error {}

/** Splits a line into tokens; "double quoted" tokens keep spaces and are flagged. */
const tokenize = (line: string): { text: string; quoted: boolean }[] => {
  const out: { text: string; quoted: boolean }[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i]!)) { i++; continue; }
    if (line.startsWith('ai="', i)) {
      let j = i + 4, buf = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) { buf += line[j + 1]; j += 2; } else buf += line[j++];
      }
      if (j >= line.length) throw new MarkdownError(`unterminated quote in: ${line}`);
      out.push({ text: `ai=${buf}`, quoted: false });
      i = j + 1;
    } else if (line[i] === '"') {
      let j = i + 1, buf = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) { buf += line[j + 1]; j += 2; } else buf += line[j++];
      }
      if (j >= line.length) throw new MarkdownError(`unterminated quote in: ${line}`);
      out.push({ text: buf, quoted: true });
      i = j + 1;
    } else {
      let j = i;
      while (j < line.length && !/\s/.test(line[j]!)) j++;
      out.push({ text: line.slice(i, j), quoted: false });
      i = j;
    }
  }
  return out;
};

const sel = (t: { text: string; quoted: boolean } | undefined, line: string): string => {
  if (!t) throw new MarkdownError(`missing selector in: ${line}`);
  return t.quoted && !KIND_PREFIX.test(t.text) ? `text=${t.text}` : t.text;
};
const val = (t: { text: string } | undefined, line: string): string => {
  if (!t) throw new MarkdownError(`missing value in: ${line}`);
  return t.text;
};

const parseStep = (line: string): Step => {
  const t = tokenize(line);
  const verb = t[0]?.text;
  switch (verb) {
    case 'include': return { action: 'include', file: val(t[1], line) };
    case 'goto': return { action: 'goto', url: val(t[1], line) };
    case 'click': return { action: 'click', selector: sel(t[1], line) };
    case 'check': return { action: 'check', selector: sel(t[1], line) };
    case 'waitFor': return { action: 'waitFor', selector: sel(t[1], line) };
    case 'fill': return { action: 'fill', selector: sel(t[1], line), value: val(t[2], line) };
    case 'select': return { action: 'select', selector: sel(t[1], line), value: val(t[2], line) };
    case 'press':
      return t.length >= 3
        ? { action: 'press', selector: sel(t[1], line), key: val(t[2], line) }
        : { action: 'press', key: val(t[1], line) };
    case 'wait': {
      const ms = Number(val(t[1], line));
      if (!Number.isInteger(ms)) throw new MarkdownError(`wait needs milliseconds: ${line}`);
      return { action: 'wait', ms };
    }
    case 'screenshot': return { action: 'screenshot', path: val(t[1], line) };
    case 'extract':
      if (t[2]?.text !== 'as') throw new MarkdownError(`use: extract <selector> as <name>: ${line}`);
      return { action: 'extract', selector: sel(t[1], line), as: val(t[3], line) };
    case 'expect': {
      const kind = t[1]?.text;
      if (kind === 'visible') return { action: 'expect', kind, selector: sel(t[2], line) };
      if (kind === 'text' || kind === 'url' || kind === 'title' || kind === 'js') {
        return t.length >= 4
          ? { action: 'expect', kind, selector: sel(t[2], line), value: val(t[3], line) }
          : { action: 'expect', kind, value: val(t[2], line) };
      }
      throw new MarkdownError(`expect needs text|visible|url|title: ${line}`);
    }
    default:
      throw new MarkdownError(`unknown step "${verb ?? ''}" in: ${line}`);
  }
};

export const parseMarkdown = (source: string): Scenario => {
  let name = '';
  const desc: string[] = [];
  const steps: Step[] = [];
  const vars: Record<string, string> = {};
  let tags: string[] | undefined;
  const lines = source.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    if (!line) continue;
    const fence = /^```js\b(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      n++;
      while (n < lines.length && !/^```\s*$/.test(lines[n]!.trim())) body.push(lines[n++]!);
      if (n >= lines.length) throw new MarkdownError('unterminated js code block');
      const info = fence[1]!.trim();
      const code = body.join('\n');
      if (info.startsWith('evaluate')) {
        const as = /^evaluate(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(info);
        if (!as) throw new MarkdownError('use: js evaluate as <name>, got: ' + info);
        steps.push({ action: 'evaluate', code, ...(as[1] ? { as: as[1] } : {}) });
      } else if (info === '') steps.push({ action: 'script', code });
      else throw new MarkdownError(`unknown js block option "${info}"`);
      continue;
    }
    const h = /^#\s+(.+)$/.exec(line);
    if (h && !name) { name = h[1]!.trim(); continue; }
    const tg = /^tags:\s*(.+)$/i.exec(line);
    if (tg && !steps.length) { tags = tg[1]!.split(',').map((x) => x.trim()).filter(Boolean); continue; }
    const b = /^[-*]\s+(.+)$/.exec(line);
    if (b) {
      let body = b[1]!.trim();
      let aiNote: string | undefined;
      const c = /\s*<!--\s*ai="((?:[^"\\]|\\.)*)"\s*-->$/.exec(body);
      if (c) { aiNote = c[1]!.replace(/\\(.)/g, '$1'); body = body.slice(0, c.index).trim(); }
      const set = /^set\s+([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(body);
      if (set) vars[set[1]!] = set[2]!.replace(/^"(.*)"$/, '$1');
      else steps.push(aiNote ? { ...parseStep(body), ai: aiNote } : parseStep(body));
    } else if (!line.startsWith('#')) desc.push(line);
  }
  if (!name) throw new MarkdownError('missing "# Title" line');
  return {
    name,
    ...(desc.length ? { description: desc.join(' ') } : {}),
    ...(tags ? { tags } : {}),
    ...(Object.keys(vars).length ? { vars } : {}),
    steps,
  };
};
