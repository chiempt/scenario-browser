# scenario-browser

Run browser automation from small **scenario files** (JSON or Markdown), with optional AI to **write** scenarios from a description and to **repair broken selectors** when a page changes. Plain Playwright + Chromium underneath. TypeScript, runs directly on Node 23.6+.

> **Use it only on sites you own or are explicitly allowed to automate.**
> scenario-browser does not solve captchas, evade bot detection, or spoof fingerprints, and will not accept contributions that do.

## Quickstart

```bash
git clone <this repo> && cd scenario-browser
npm install
npm run browser:install        # downloads Chromium via Playwright

node src/cli.ts validate examples
node src/cli.ts run examples/httpbin-html.md
node src/cli.ts run examples/example-heading.json --headed
```

## Scenarios

JSON (a `scenario.schema.json` is included for editor autocomplete):

```json
{
  "name": "example.com page check",
  "steps": [
    { "action": "goto", "url": "https://example.com" },
    { "action": "expect", "kind": "title", "value": "Example Domain" },
    { "action": "extract", "selector": "p", "as": "intro" }
  ]
}
```

Markdown, one step per line:

```markdown
# httpbin HTML page
- goto https://httpbin.org/html
- waitFor h1
- expect text "Herman Melville"
- fill #q "text"            # unquoted = CSS/XPath/Playwright selector
- click "Login"             # quoted = visible text (text=Login)
- extract h1 as title       # later usable as {{title}}
```

Steps: `goto`, `click`, `fill`, `press`, `select`, `check`, `wait`, `waitFor`, `expect` (`text`, `visible`, `url`, `title`), `extract`, `screenshot`. Selectors may be CSS, XPath, `text=...`, or `label=Field label`. `{{name}}` placeholders read from `vars` or `extract`. `goto` accepts only `http(s)` URLs. Unknown keys are errors, not silently ignored.

## CLI

| Command | What it does |
|---|---|
| `run <file> [--headed] [--heal] [--save-healed] [--launcher <module>]` | Run a scenario. Exit code 0 on pass, 1 on fail. |
| `validate <file\|dir>...` | Check scenarios without opening a browser. |
| `generate "description" [-o file.json]` | AI writes a validated scenario. |
| `portal [--port 7070]` | Local web UI. |
| `schema` | Print the JSON Schema. |

## AI steps

Set `ANTHROPIC_API_KEY` in your shell (it is read from the environment only, never stored or logged). Optional `SCENARIO_MODEL` overrides the model.

```bash
export ANTHROPIC_API_KEY=...
node src/cli.ts generate "open example.com and check the page title" -o my.json
node src/cli.ts run my.json --heal --save-healed
```

- `generate` asks the model for JSON, validates it against the schema, and retries once with the validation errors. Always review generated scenarios before running them.
- `--heal`: when a step fails on a selector, a compact list of interactive elements from the current page (tags, ids, labels, text; never field values) is sent to the model, which proposes a replacement. The step is retried once; healed steps are marked in the log. `--save-healed` writes the repaired selectors back to a `.json` scenario.

This sends page structure (element names/text, trimmed) to the Anthropic API. Do not use `--heal` on pages containing data you may not share.

## Custom launcher

By default `run` starts plain Playwright Chromium. `--launcher <module>` swaps that out: the module (a relative/absolute path or a package name) is imported dynamically and its default export (or a named `launch`) is called with `{ headless }`. It must return a Playwright `BrowserContext` or `Page`; the runner closes it (and its browser) at the end. Works together with `--heal`.

Plain Playwright with your own options (`my-launcher.mjs`):

```js
import { chromium } from 'playwright';

export default async ({ headless }) => {
  const browser = await chromium.launch({ headless });
  return browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
};
```

An already-installed Chrome via channel (no Chromium download needed):

```js
import { chromium } from 'playwright';

export default async ({ headless }) => {
  const browser = await chromium.launch({ channel: 'chrome', headless });
  return browser.newContext();
};
```

```bash
node src/cli.ts run examples/httpbin-html.md --launcher ./my-launcher.mjs --heal
```

The same acceptable-use rule applies to any launcher.

## Portal

```bash
node src/cli.ts portal      # http://127.0.0.1:7070
```

One page: paste or edit a scenario (JSON or Markdown), Validate, Run, read the log, or Generate with AI. It binds to `127.0.0.1` only and rejects non-local `Host` headers. It has no authentication; do not expose it to a network.

## Development

```bash
npm run check    # typecheck + tests + validate examples
```

Tests run against a local fixture page (real Chromium) and a mocked Anthropic API; no network or key needed. The example scenarios hit public sites (example.com, httpbin.org), which can change.

## Not done yet

Conditionals/loops, `include`, file upload/download steps, iframes, multi-tab, scheduled runs, run history in the portal, streaming logs.

## License

MIT
