import { z } from 'zod';

/**
 * The scenario format. One definition serves as runtime validator, TypeScript
 * types, and (via `scenario-browser schema`) the JSON Schema for editors.
 * Every object is strict so a misspelt key is an error, not a silent default.
 *
 * Selectors are strings: CSS, XPath, `xpath=//...`, `css=...`, `text=Login`,
 * `role=button[name="Sign in"]`, `testid=id`, `label=Email`, `placeholder=...`,
 * or `ai=description` (an AI finds the element; see docs/ai-context.md).
 *
 * NOTE: `evaluate`, `script` and `expect js` run JavaScript. A scenario is code.
 */
const selector = z.string().min(1).meta({
  description: 'CSS, XPath (//...), xpath=, css=, text=, role=button[name="X"], testid=, label=, placeholder=, or ai=<describe the element> (AI resolves it; --lock saves the result).',
});
const url = z
  .string()
  .refine((u) => /^https?:\/\//i.test(u) || u.startsWith('/') || u.startsWith('{{'), 'must be http(s)://..., a /path (needs baseUrl), or start with {{var}}')
  .meta({ description: 'Absolute http(s) URL, or a /path joined to baseUrl. {{vars}} are allowed.' });

const common = {
  note: z.string().optional().meta({ description: 'Free-form comment shown in the log.' }),
  continueOnError: z.boolean().optional().meta({ description: 'If this step fails, record it as ignored and carry on.' }),
  retry: z.int().min(0).max(5).optional().meta({ description: 'Extra attempts for a failing step (leaf steps).' }),
  ai: z.string().min(1).optional().meta({ description: 'What the selector is meant to find, in words. Written by --lock next to the selector it found; also read by `explain`.' }),
};

const code = z.string().min(1).meta({ description: 'JavaScript source.' });

export const ConditionSchema = z.union([
  z.strictObject({ js: code.meta({ description: 'Expression run in the page; truthy means true. `vars` is in scope.' }) }),
  z.strictObject({ visible: selector }),
]);

type Common = { note?: string; continueOnError?: boolean; retry?: number; ai?: string };
export type Condition = { js: string } | { visible: string };
type Name = string;
/** Hand-written because the format is recursive (if/repeat/forEach hold steps). */
export type Step = Common & (
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'press'; key: string; selector?: string }
  | { action: 'select'; selector: string; value: string }
  | { action: 'check'; selector: string }
  | { action: 'wait'; ms: number }
  | { action: 'waitFor'; selector: string }
  | { action: 'expect'; kind: 'text' | 'visible' | 'url' | 'title' | 'js'; value?: string; selector?: string }
  | { action: 'extract'; selector: string; as: Name }
  | { action: 'screenshot'; path: string }
  | { action: 'evaluate'; code: string; as?: Name }
  | { action: 'script'; code?: string; file?: string }
  | { action: 'include'; file: string; vars?: Record<string, string> }
  | { action: 'if'; when: Condition; then: Step[]; else?: Step[] }
  | { action: 'repeat'; times: number; as?: Name; steps: Step[] }
  | { action: 'forEach'; items: string | unknown[]; as: Name; steps: Step[] }
);

export const StepSchema: z.ZodType<Step> = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('goto'), url, ...common }),
  z.strictObject({ action: z.literal('click'), selector, ...common }),
  z.strictObject({ action: z.literal('fill'), selector, value: z.string(), ...common }),
  z.strictObject({ action: z.literal('press'), key: z.string().min(1), selector: selector.optional(), ...common }),
  z.strictObject({ action: z.literal('select'), selector, value: z.string(), ...common }),
  z.strictObject({ action: z.literal('check'), selector, ...common }),
  z.strictObject({ action: z.literal('wait'), ms: z.int().min(0).max(60_000), ...common }),
  z.strictObject({ action: z.literal('waitFor'), selector, ...common }),
  z
    .strictObject({
      action: z.literal('expect'),
      kind: z.enum(['text', 'visible', 'url', 'title', 'js']).meta({
        description: 'text: page (or selector) contains value. visible: selector shown. url/title: contains value. js: expression (in the page) is truthy.',
      }),
      value: z.string().optional().meta({ description: 'Expected text/url/title, or the JS expression for kind=js.' }),
      selector: selector.optional(),
      ...common,
    })
    .refine((s) => !(s.kind === 'visible' && !s.selector), { message: 'expect visible needs "selector"' })
    .refine((s) => s.kind === 'visible' || s.value !== undefined, { message: 'expect needs "value" (except kind=visible)' }),
  z.strictObject({ action: z.literal('extract'), selector, as: z.string().regex(/^[A-Za-z_]\w*$/), ...common }),
  z.strictObject({ action: z.literal('screenshot'), path: z.string().min(1), ...common }),
  z.strictObject({
    action: z.literal('evaluate'),
    code: code.meta({ description: 'Function body run inside the page via page.evaluate. `vars` is in scope; use `return` to produce a value.' }),
    as: z.string().regex(/^[A-Za-z_]\w*$/).optional().meta({ description: 'Variable that receives the returned value.' }),
    ...common,
  }),
  z
    .strictObject({
      action: z.literal('script'),
      code: code.optional().meta({ description: 'Inline Node.js (async) body. In scope: page, vars, env, expect, context.' }),
      file: z.string().min(1).optional().meta({ description: 'Script file, relative to the scenario file, must stay inside the project.' }),
      ...common,
    })
    .refine((s) => (s.code === undefined) !== (s.file === undefined), { message: 'script needs exactly one of "code" or "file"' }),
  z.strictObject({
    action: z.literal('include'),
    file: z.string().min(1).meta({ description: 'Another scenario (.json/.md), relative to this file. Its steps run in the same page.' }),
    vars: z.record(z.string(), z.string()).optional().meta({ description: 'Variables passed to the included scenario ({{}} allowed).' }),
    ...common,
  }),
  z.strictObject({
    action: z.literal('if'),
    when: ConditionSchema,
    get then(): z.ZodType<Step[]> { return z.array(StepSchema).min(1); },
    get else(): z.ZodType<Step[] | undefined> { return z.array(StepSchema).optional(); },
    ...common,
  }),
  z.strictObject({
    action: z.literal('repeat'),
    times: z.int().min(1).max(1000),
    as: z.string().regex(/^[A-Za-z_]\w*$/).optional().meta({ description: 'Variable receiving the 0-based iteration number.' }),
    get steps(): z.ZodType<Step[]> { return z.array(StepSchema).min(1); },
    ...common,
  }),
  z.strictObject({
    action: z.literal('forEach'),
    items: z.union([z.string().min(1), z.array(z.json())]).meta({ description: 'An array, or the name of a variable holding an array (or a JSON array string).' }),
    as: z.string().regex(/^[A-Za-z_]\w*$/).meta({ description: 'Variable receiving each item; <as>_index receives the position.' }),
    get steps(): z.ZodType<Step[]> { return z.array(StepSchema).min(1); },
    ...common,
  }),
]);

const baseUrl = z.string().regex(/^https?:\/\//i, 'must start with http:// or https://');

export const ScenarioSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  context: z.string().max(8000).optional().meta({ description: 'Context for ai= selectors: what the page is, terms, conventions. Added after the project context.' }),
  tags: z.array(z.string().min(1)).optional().meta({ description: 'Labels for `project run --tag`.' }),
  baseUrl: baseUrl.optional().meta({ description: 'Joined to /path URLs. Overrides the project baseUrl.' }),
  headless: z.boolean().optional().meta({ description: 'Default true.' }),
  timeout: z.int().min(100).max(120_000).optional().meta({ description: 'Per-step timeout in ms. Default 10000.' }),
  vars: z.record(z.string(), z.json()).optional().meta({ description: 'Values for {{name}} placeholders (strings, numbers, arrays...).' }),
  steps: z.array(StepSchema).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ProjectSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().min(1),
  baseUrl: baseUrl.optional(),
  context: z.string().max(8000).optional().meta({ description: 'Project context for ai= selectors: what the app is, terms, conventions. A context.md next to this file is read too.' }),
  vars: z.record(z.string(), z.json()).optional(),
  envFile: z.string().optional().meta({ description: 'Dotenv file read for {{env.X}}. Default ".env". Real environment variables win.' }),
  defaults: z
    .strictObject({
      timeout: z.int().min(100).max(120_000).optional(),
      headless: z.boolean().optional(),
      launcher: z.string().optional().meta({ description: 'Launcher module, relative to the project.' }),
    })
    .optional(),
  scenarios: z.array(z.string()).optional().meta({ description: 'Globs relative to the project. Default ["scenarios/**/*.{json,md}"].' }),
  setup: z.array(z.string()).optional().meta({ description: 'Scenarios run first. A failure stops the run. Their extracted vars flow into later scenarios.' }),
  teardown: z.array(z.string()).optional().meta({ description: 'Scenarios always run last.' }),
  reportDir: z.string().optional().meta({ description: 'Default "reports".' }),
});
export type Project = z.infer<typeof ProjectSchema>;

export const formatIssues = (error: z.ZodError): string =>
  error.issues.map((i) => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('\n');

export const jsonSchema = (): unknown => z.toJSONSchema(ScenarioSchema, { io: 'input' });
export const projectJsonSchema = (): unknown => z.toJSONSchema(ProjectSchema, { io: 'input' });

/** True if the scenario runs author-supplied JavaScript (evaluate, script, expect js, if js). */
export const hasJs = (steps: readonly Step[]): boolean =>
  steps.some((s) => {
    switch (s.action) {
      case 'evaluate': case 'script': return true;
      case 'expect': return s.kind === 'js';
      case 'if': return 'js' in s.when || hasJs(s.then) || (s.else ? hasJs(s.else) : false);
      case 'repeat': case 'forEach': return hasJs(s.steps);
      default: return false;
    }
  });

const selectorOf = (s: Step): string | undefined => ('selector' in s && typeof s.selector === 'string' ? s.selector : undefined);

/** Descriptions of ai= selectors that are not locked yet (anywhere in the tree, includes not followed). */
export const unlockedAi = (steps: readonly Step[]): string[] =>
  steps.flatMap((s): string[] => {
    const own = selectorOf(s);
    const here = own && /^ai=/i.test(own) ? [own.slice(3).trim()] : [];
    if (s.action === 'if') return [...here, ...unlockedAi(s.then), ...(s.else ? unlockedAi(s.else) : [])];
    if (s.action === 'repeat' || s.action === 'forEach') return [...here, ...unlockedAi(s.steps)];
    return here;
  });
