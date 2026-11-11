import { z } from 'zod';

/**
 * The scenario format. One definition serves as runtime validator, TypeScript
 * types, and (via `scenario-browser schema`) the JSON Schema for editors.
 * Every object is strict so a misspelt key is an error, not a silent default.
 *
 * Selectors are strings: CSS, XPath, any Playwright selector (`text=Login`),
 * or `label=Email` (matched with getByLabel).
 */
const selector = z.string().min(1).meta({
  description: 'CSS, XPath, Playwright selector (text=Login), or label=Field label.',
});
const httpUrl = z
  .string()
  .refine((u) => /^https?:\/\//i.test(u) || u.startsWith('{{'), 'must start with http:// or https://')
  .meta({ description: 'Absolute http(s) URL. {{vars}} are allowed.' });
const note = z.string().optional().meta({ description: 'Free-form comment shown in the log.' });

export const StepSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('goto'), url: httpUrl, note }),
  z.strictObject({ action: z.literal('click'), selector, note }),
  z.strictObject({ action: z.literal('fill'), selector, value: z.string(), note }),
  z.strictObject({ action: z.literal('press'), key: z.string().min(1), selector: selector.optional(), note }),
  z.strictObject({ action: z.literal('select'), selector, value: z.string(), note }),
  z.strictObject({ action: z.literal('check'), selector, note }),
  z.strictObject({ action: z.literal('wait'), ms: z.int().min(0).max(60_000), note }),
  z.strictObject({ action: z.literal('waitFor'), selector, note }),
  z.strictObject({
    action: z.literal('expect'),
    kind: z.enum(['text', 'visible', 'url', 'title']).meta({
      description: 'text: page (or selector) contains value. visible: selector shown. url/title: contains value.',
    }),
    value: z.string().optional().meta({ description: 'Expected text/url/title. Not used by kind=visible.' }),
    selector: selector.optional(),
    note,
  }),
  z.strictObject({ action: z.literal('extract'), selector, as: z.string().regex(/^[A-Za-z_]\w*$/), note }),
  z.strictObject({ action: z.literal('screenshot'), path: z.string().min(1), note }),
]);
export type Step = z.infer<typeof StepSchema>;

export const ScenarioSchema = z
  .strictObject({
    $schema: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    headless: z.boolean().optional().meta({ description: 'Default true.' }),
    timeout: z.int().min(100).max(120_000).optional().meta({ description: 'Per-step timeout in ms. Default 10000.' }),
    vars: z.record(z.string(), z.string()).optional().meta({ description: 'Values for {{name}} placeholders.' }),
    steps: z.array(StepSchema).min(1),
  })
  .superRefine((s, ctx) => {
    s.steps.forEach((step, i) => {
      if (step.action === 'expect') {
        if (step.kind === 'visible' && !step.selector)
          ctx.addIssue({ code: 'custom', path: ['steps', i], message: 'expect visible needs "selector"' });
        if (step.kind !== 'visible' && step.value === undefined)
          ctx.addIssue({ code: 'custom', path: ['steps', i], message: `expect ${step.kind} needs "value"` });
      }
    });
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

export const formatIssues = (error: z.ZodError): string =>
  error.issues.map((i) => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('\n');

export const jsonSchema = (): unknown => z.toJSONSchema(ScenarioSchema, { io: 'input' });
