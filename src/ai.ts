import { parseScenarioText, ScenarioFileError } from './load.ts';
import { jsonSchema, type Scenario } from './schema.ts';
import type { DomItem } from './dom.ts';

/** Minimal Anthropic Messages API client over fetch. The key comes from ANTHROPIC_API_KEY only. */
export interface AiOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export const DEFAULT_MODEL = 'claude-sonnet-4-5';

export class AiError extends Error {}

export const complete = async (system: string, user: string, opts: AiOptions = {}): Promise<string> => {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AiError('ANTHROPIC_API_KEY is not set. Export it in your shell; it is never stored.');
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: opts.model ?? process.env.SCENARIO_MODEL ?? DEFAULT_MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new AiError(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = body.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
  if (!text) throw new AiError('empty response from the API');
  return text;
};

/** Pulls the first JSON object/array out of a reply that may be wrapped in a code fence. */
export const extractJson = (text: string): string => {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fence ? fence[1]! : text).trim();
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end < start) throw new AiError('no JSON found in the reply');
  return body.slice(start, end + 1);
};

const GENERATE_SYSTEM = `You write browser automation scenarios as a single JSON object and nothing else.
The JSON must satisfy this JSON Schema (all objects are strict, no extra keys):
${JSON.stringify(jsonSchema())}
Rules: only http(s) URLs; prefer stable selectors (ids, label=..., text=...); end with at least one "expect" step that proves success; never include credentials; output JSON only.`;

/** Description in, validated Scenario out. One repair round if the first answer is invalid. */
export const generateScenario = async (description: string, opts: AiOptions = {}): Promise<Scenario> => {
  let prompt = `Write a scenario for: ${description}`;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await complete(GENERATE_SYSTEM, prompt, opts);
    try {
      return parseScenarioText(extractJson(reply), '.json', 'generated scenario');
    } catch (e) {
      lastError = (e as Error).message;
      prompt = `Write a scenario for: ${description}\nYour previous answer was invalid:\n${lastError}\nReturn corrected JSON only.`;
    }
  }
  throw new ScenarioFileError(`the model did not return a valid scenario after 2 tries:\n${lastError}`);
};

const HEAL_SYSTEM = `You repair broken selectors in browser automation. You get the failing step, the error, and a reduced DOM list of the current page.
Reply with JSON only: {"selector": "<replacement>", "reason": "<short>"}. Pick a selector that exists in the DOM list (prefer id, label=..., text=..., then the css field). If nothing fits reply {"selector": null, "reason": "..."}.`;

export interface HealSuggestion { selector: string; reason: string }

export const suggestSelector = async (
  step: unknown, error: string, dom: DomItem[], opts: AiOptions = {},
): Promise<HealSuggestion | null> => {
  const reply = await complete(
    HEAL_SYSTEM,
    `Failing step: ${JSON.stringify(step)}\nError: ${error.slice(0, 400)}\nDOM: ${JSON.stringify(dom)}`,
    opts,
  );
  const data = JSON.parse(extractJson(reply)) as { selector?: string | null; reason?: string };
  return typeof data.selector === 'string' && data.selector
    ? { selector: data.selector, reason: data.reason ?? '' }
    : null;
};

const LOCATE_SYSTEM = `You find ONE element on a web page for browser automation.
You get: the project context (what the app is, terms, conventions), the page URL and title, what to find, and a reduced list of the page's interactive elements (no field values).
Reply with JSON only: {"selector": "<locator>", "reason": "<short>"}.
The locator must use one of these forms: xpath=//..., css=..., text=..., role=button[name="..."], testid=..., label=..., placeholder=...
Prefer, in order: testid, role with name, label, an id (css=#id), text, then the css value from the list. Prefer a locator that matches exactly one element.
Use only what is in the list; never invent ids or text. If nothing fits reply {"selector": null, "reason": "..."}.`;

export interface LocateInput { description: string; dom: DomItem[]; context?: string; url?: string; title?: string }

export const locateElement = async (input: LocateInput, opts: AiOptions = {}): Promise<HealSuggestion | null> => {
  const reply = await complete(
    LOCATE_SYSTEM,
    `Project context:\n${input.context?.trim() || '(none)'}\n\nPage: ${input.url ?? ''} | ${input.title ?? ''}\nFind: ${input.description}\nElements: ${JSON.stringify(input.dom)}`,
    opts,
  );
  const data = JSON.parse(extractJson(reply)) as { selector?: string | null; reason?: string };
  return typeof data.selector === 'string' && data.selector.trim()
    ? { selector: data.selector.trim(), reason: data.reason ?? '' }
    : null;
};
