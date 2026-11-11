# AI context: let an AI find the selector, then lock it

Two ways to get selectors into a scenario:

1. **You supply them.** Use the portal's *Pick element* (or `scenario-browser pick <url>`), click the element in the page, and copy the XPath / CSS / text / role it suggests.
2. **An AI finds them.** Describe the element in words (`ai=...`). The AI sees a reduced view of the live page plus your project context, picks a locator, and `--lock` saves it into the scenario so later runs need no AI.

Everything here is for sites you own or are allowed to automate. It needs `ANTHROPIC_API_KEY` for the AI path only; picking, locked scenarios and `--no-ai` runs need no key.

## Selector forms

| Form | Example |
|---|---|
| XPath | `//button[@id="go"]` or `xpath=//button[@id="go"]` |
| CSS | `#go`, `css=.card > a` |
| Visible text | `text=Login` |
| Role + name | `role=button[name="Sign in"]` |
| Test id | `testid=login-btn` (`data-testid`) |
| Label | `label=Email` |
| Placeholder | `placeholder=Search` |
| AI target | `ai=the Sign in button in the top right` |

## Writing an AI step

JSON, in any step that takes a `selector`:

```json
{ "action": "click", "selector": "ai=nút Đăng nhập ở góc phải" }
```

Markdown:

```markdown
- click ai="nút Đăng nhập ở góc phải"
```

Run it:

```bash
export ANTHROPIC_API_KEY=...
scenario-browser run login.json --lock
```

`--lock` writes what the AI found next to your words. JSON:

```json
{ "action": "click", "selector": "role=link[name=\"Đăng nhập\"]", "ai": "nút Đăng nhập ở góc phải" }
```

Markdown:

```markdown
- click "role=link[name=\"Đăng nhập\"]" <!-- ai="nút Đăng nhập ở góc phải" -->
```

From then on the step uses the locked selector and makes no AI call. `scenario-browser run login.json --no-ai` guarantees that: it fails fast if any `ai=` step is still unlocked, and `--heal` is off. To re-find one, put `"selector": "ai=..."` back (or delete the selector and the comment).

Notes:
- The AI's answer must match at least one element on the page, otherwise the step fails and nothing is locked.
- `{{vars}}` inside an `ai=` description are filled in, but such a step is resolved on every run and not locked.
- `--lock` rewrites the file you ran (`project run --lock` rewrites each scenario). `ai=` steps inside an `include`d file are not written back; lock that file directly.
- A missing key stops the run before the browser opens: `N step(s) use ai= selectors but ANTHROPIC_API_KEY is not set`.

## Project context

The AI cannot guess your app's vocabulary. Give it context in either place (both are read, in this order):

1. `context` in `scenario.project.json`
2. `context.md` next to it
3. `context` on a single scenario (JSON only)

Together capped at 8000 characters. It is sent to the model, so write no passwords, tokens or customer data in it.

Example `context.md`:

```markdown
# Acme shop (staging)

Online shop, Vietnamese UI, some English. Header has the account area on the right.

Terms
- "Giỏ hàng" is the cart, the icon with a number badge in the header.
- "Mua ngay" is Buy now on a product page; "Thêm vào giỏ" is Add to cart. They are different buttons.
- "Đăng nhập" opens a modal, not a new page.

Conventions
- Our test ids start with `qa-` (for example `qa-checkout`). Prefer them when present.
- Never click anything under "Admin" in the left menu.
```

## What the AI sees

Per ai= step: your context, the page URL without query string, the page title, your description, and up to 150 visible interactive elements (tag, id, name, type, role, trimmed text, placeholder, aria-label, label text, test id, link path without query, a CSS path).

Not sent: values of inputs, text of inputs, textareas and selects, hidden inputs, cookies, storage, headers, screenshots. Check your own page for secrets rendered as plain text (a token shown in a heading would be in the list).

The Anthropic API is called with your key from your machine; scenario-browser has no server of its own.

## Pick element (portal and CLI)

```bash
scenario-browser portal          # Pick element panel, enter a URL, Open page
scenario-browser pick https://your-site.example/login
```

Opens the page in a normal Playwright Chromium window. Move the mouse to see the highlight; click to select. Clicks are captured and not delivered to the page, so you can pick a Delete button safely. You get:

- XPath: by id, by test id, by exact text, and a positional path
- CSS: by id, by name, and a short path
- `text=`, `role=...[name="..."]`, `label=`, `placeholder=`, `testid=`
- for XPath and CSS, how many elements match (aim for 1)

In the portal each suggestion has *Copy* and *Insert as click* (adds a step to the editor). The picker reads no field values. You log in by hand in that window if the page needs it; the window is closed with *Close* and nothing is stored.

## Read a scenario back

```bash
scenario-browser explain login.json
```

```
Scenario: Login
1. Open https://example.com/login
2. Type "{{user}}" into the field labelled "Email"
3. Click the link named "Đăng nhập" (found by AI for "nút Đăng nhập ở góc phải", locked)
4. Check that the text of the element with test id "welcome" contains "Hello"
```

Useful for review: someone who does not read JSON can check what the test claims to do.
