import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright-core';
import { AiError, locateElement, suggestSelector, type AiOptions } from './ai.ts';
import { loadContext } from './context.ts';
import { reducedDom } from './dom.ts';
import { openSession } from './launch.ts';
import { loadScenario } from './load.ts';
import { unlockedAi, type Scenario, type Step } from './schema.ts';
import { isAiSelector, toLocator } from './selector.ts';
import { interpolate, type Vars } from './template.ts';

export type StepStatus = 'passed' | 'failed' | 'healed' | 'ignored';
export interface StepRecord {
  /** "3", or "3.2" for the second child of step 3. */
  path: string; depth: number; action: string; status: StepStatus; ms: number;
  error?: string; healedSelector?: string; note?: string;
  /** File name of the failure screenshot, inside the run's output dir. */
  screenshot?: string;
}
export interface RunReport {
  scenario: string; file?: string; tags: string[]; status: 'passed' | 'failed';
  startedAt: string; durationMs: number;
  steps: StepRecord[];
  /** Variables created or changed during the run (initial values are not echoed, they may be secrets). */
  vars: Record<string, unknown>;
  error?: string;
  /** Scenario with healed selectors applied; only present if something healed. */
  healed?: Scenario;
  /** Scenario with ai= selectors replaced by what the AI found (for --lock); only present if the AI resolved something. */
  locked?: Scenario;
  /** Each AI resolution, in order. */
  picks?: { ai: string; selector: string; reason: string }[];
}
export interface RunOptions {
  headless?: boolean;
  /** Ask the AI for a replacement selector when a step fails on one. */
  heal?: boolean;
  /** Forbid every AI call: ai= steps must already have a locked selector. */
  noAi?: boolean;
  /** Extra context for ai= selectors (the project's context.md and context field are read from rootDir anyway). */
  context?: string;
  ai?: AiOptions;
  /** Module path/package exporting a function that returns a BrowserContext or Page. */
  launcher?: string;
  log?: (line: string) => void;
  /** Failure screenshots and screenshot steps land here. Default: ./runs/<timestamp> */
  outDir?: string;
  /** Scenario file; relative include/script paths resolve from its directory. */
  file?: string;
  /** Scripts and includes may not leave this directory. Default: the scenario file's directory. */
  rootDir?: string;
  baseUrl?: string;
  /** Lowest-precedence variables (project vars, setup output). Scenario vars override these. */
  baseVars?: Vars;
  /** Highest-precedence variables (--var). */
  overrideVars?: Vars;
  /** Source of {{env.X}}. Default: process.env. */
  env?: Record<string, string | undefined>;
  defaults?: { timeout?: number; headless?: boolean };
}

/** Thrown for a step that has already been recorded (and screenshotted); containers just pass it up. */
class StepError extends Error {}

const SCRIPT_TIMEOUT = 60_000;
const MAX_INCLUDE_DEPTH = 8;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...args: unknown[]) => Promise<unknown>;

const locate = (page: Page, selector: string): Locator => toLocator(page, selector);

const describe = (s: Step): string => {
  const { action, note: _n, continueOnError: _c, retry: _r, ...rest } = s as Step & Record<string, unknown>;
  const text = Object.values(rest).map((v) => (typeof v === 'string' ? JSON.stringify(v.length > 60 ? v.slice(0, 57) + '...' : v) : '...')).join(' ');
  return `${action} ${text}`.trim();
};

const hasSelector = (s: Step): s is Step & { selector: string } => 'selector' in s && typeof s.selector === 'string';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scenario';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms).unref())]);

const resolveUrl = (raw: string, baseUrl: string | undefined): string => {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!baseUrl) throw new Error(`relative URL "${raw}" needs a baseUrl (scenario or project)`);
  return new URL(raw, baseUrl).href;
};

/** Where a script/include path points; refuses anything outside the root. */
const resolveInside = (ctx: Ctx, file: string): string => {
  if (!ctx.baseDir || !ctx.rootDir) throw new Error(`"${file}": file references need the scenario to be run from a file or project`);
  const abs = path.resolve(ctx.baseDir, file);
  const rel = path.relative(ctx.rootDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`"${file}" is outside the project directory`);
  return abs;
};

interface Ctx {
  page: Page; context: BrowserContext; vars: Vars; env: Record<string, string | undefined>;
  baseUrl?: string; baseDir?: string; rootDir?: string; timeout: number; outDir: string;
  log: (l: string) => void; heal: boolean; noAi: boolean; aiContext: string; picks: { ai: string; selector: string; reason: string }[]; lockedRoot: boolean; ai?: AiOptions;
  records: StepRecord[]; slug: string; includeStack: string[]; healedRoot: boolean; fileDepth: number;
}

const evalBody = (page: Page, code: string, vars: Vars): Promise<unknown> =>
  page.evaluate(`((vars) => {\n${code}\n})(${JSON.stringify(vars)})`);
const evalExpr = (page: Page, expr: string, vars: Vars): Promise<unknown> =>
  page.evaluate(`((vars) => (${expr}))(${JSON.stringify(vars)})`);

const makeExpect = () =>
  Object.assign(
    (value: unknown, message?: string) => { if (!value) throw new Error(message ?? 'expect failed: value is falsy'); },
    { equal: (a: unknown, b: unknown, message?: string) => assert.deepStrictEqual(a, b, message), contains: (h: string, n: string) => assert.ok(String(h).includes(n), `expected "${h}" to contain "${n}"`) },
  );

const poll = async (page: Page, timeout: number, fn: () => Promise<{ ok: boolean; why: string }>): Promise<void> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const r = await fn();
    if (r.ok) return;
    if (Date.now() > deadline) throw new Error(r.why);
    await page.waitForTimeout(100);
  }
};

const asArray = (items: unknown, vars: Vars): unknown[] => {
  let v = typeof items === 'string' ? vars[items] : items;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { v = JSON.parse(v); } catch { /* fall through */ } }
  if (!Array.isArray(v)) throw new Error(`forEach items "${String(items)}" is not an array`);
  return v;
};

const evalCondition = async (ctx: Ctx, when: { js: string } | { visible: string }): Promise<boolean> =>
  'js' in when
    ? Boolean(await evalExpr(ctx.page, when.js, ctx.vars))
    : locate(ctx.page, interpolate(when.visible, ctx.vars, ctx.env)).first().isVisible();

/** One leaf action. Container steps are handled in runStep. */
const executeLeaf = async (ctx: Ctx, step: Step): Promise<void> => {
  const { page, timeout: t, vars, env } = ctx;
  const v = (x: string) => interpolate(x, vars, env);
  switch (step.action) {
    case 'goto': await page.goto(resolveUrl(v(step.url), ctx.baseUrl), { timeout: t, waitUntil: 'domcontentloaded' }); break;
    case 'click': await locate(page, v(step.selector)).first().click({ timeout: t }); break;
    case 'fill': await locate(page, v(step.selector)).first().fill(v(step.value), { timeout: t }); break;
    case 'select': await locate(page, v(step.selector)).first().selectOption(v(step.value), { timeout: t }); break;
    case 'check': await locate(page, v(step.selector)).first().check({ timeout: t }); break;
    case 'press':
      if (step.selector) await locate(page, v(step.selector)).first().press(step.key, { timeout: t });
      else await page.keyboard.press(step.key);
      break;
    case 'wait': await page.waitForTimeout(step.ms); break;
    case 'waitFor': await locate(page, v(step.selector)).first().waitFor({ timeout: t }); break;
    case 'extract': vars[step.as] = (await locate(page, v(step.selector)).first().innerText({ timeout: t })).trim(); break;
    case 'screenshot':
      await mkdir(ctx.outDir, { recursive: true });
      await page.screenshot({ path: path.join(ctx.outDir, path.basename(v(step.path))), fullPage: true });
      break;
    case 'evaluate': {
      const out = await evalBody(page, step.code, vars);
      if (step.as) vars[step.as] = out === undefined ? null : out;
      break;
    }
    case 'script': {
      const source = step.code ?? (await readFile(resolveInside(ctx, step.file!), 'utf8'));
      const fn = new AsyncFunction('page', 'vars', 'env', 'expect', 'context', source);
      await withTimeout(fn(page, vars, env, makeExpect(), ctx.context), SCRIPT_TIMEOUT, 'script');
      break;
    }
    case 'expect': {
      const want = step.value === undefined ? '' : v(step.value);
      if (step.kind === 'visible') await locate(page, v(step.selector!)).first().waitFor({ state: 'visible', timeout: t });
      else if (step.kind === 'text') {
        const target = step.selector ? locate(page, v(step.selector)).first() : page.locator('body');
        await poll(page, t, async () => ({ ok: (await target.innerText({ timeout: t })).includes(want), why: `expected text "${want}" not found` }));
      } else if (step.kind === 'js') {
        const expr = step.value!;
        let last: unknown;
        await poll(page, t, async () => { last = await evalExpr(page, expr, vars); return { ok: Boolean(last), why: `expected js to be truthy: ${expr} (got ${JSON.stringify(last)})` }; });
      } else {
        await poll(page, t, async () => {
          const got = step.kind === 'url' ? page.url() : await page.title();
          return { ok: got.includes(want), why: `expected ${step.kind} to contain "${want}", got "${got}"` };
        });
      }
      break;
    }
    default: throw new Error(`internal: ${step.action} is not a leaf step`);
  }
};

/** Turns an ai= selector into a real one using the live page, the project context and the AI. */
const resolveAi = async (ctx: Ctx, step: Step & { selector: string }, pad: string, p: string): Promise<Step> => {
  if (!isAiSelector(step.selector)) return step;
  const raw = step.selector.slice(3).trim();
  const dynamic = raw.includes('{{');
  const description = interpolate(raw, ctx.vars, ctx.env);
  if (ctx.noAi) throw new Error(`step ${p} has ai="${description}" but no locked selector and --no-ai is set; run once with --lock`);
  ctx.log(`${pad}step ${p}: asking the model to find "${description}"`);
  const sug = await locateElement({
    description, dom: await reducedDom(ctx.page, 150), context: ctx.aiContext, url: ctx.page.url().split(/[?#]/)[0]!, title: await ctx.page.title(),
  }, ctx.ai);
  if (!sug) throw new Error(`the model could not find an element for "${description}"`);
  if (isAiSelector(sug.selector)) throw new Error(`the model returned an unusable selector for "${description}"`);
  if ((await locate(ctx.page, sug.selector).count()) === 0) throw new Error(`the model's selector ${JSON.stringify(sug.selector)} matches nothing on the page ("${description}")`);
  ctx.picks.push({ ai: description, selector: sug.selector, reason: sug.reason });
  ctx.log(`${pad}found: ${JSON.stringify(sug.selector)} (${sug.reason})`);
  const fixed = { ...step, selector: sug.selector, ai: description } as Step;
  if (!dynamic) { Object.assign(step, { selector: sug.selector, ai: description }); if (ctx.fileDepth === 0) ctx.lockedRoot = true; }
  return fixed;
};

const runChildren = async (ctx: Ctx, steps: readonly Step[], prefix: string, depth: number): Promise<void> => {
  for (let i = 0; i < steps.length; i++) await runStep(ctx, steps[i]!, `${prefix}${i + 1}`, depth);
};

const runContainer = async (ctx: Ctx, step: Step, p: string, depth: number): Promise<void> => {
  const v = (x: string) => interpolate(x, ctx.vars, ctx.env);
  switch (step.action) {
    case 'if': {
      const branch = (await evalCondition(ctx, step.when)) ? step.then : step.else;
      if (branch) await runChildren(ctx, branch, `${p}.`, depth + 1);
      return;
    }
    case 'repeat':
      for (let n = 0; n < step.times; n++) {
        if (step.as) ctx.vars[step.as] = n;
        await runChildren(ctx, step.steps, `${p}.`, depth + 1);
      }
      return;
    case 'forEach': {
      const items = asArray(step.items, ctx.vars);
      for (let n = 0; n < items.length; n++) {
        ctx.vars[step.as] = items[n];
        ctx.vars[`${step.as}_index`] = n;
        await runChildren(ctx, step.steps, `${p}.`, depth + 1);
      }
      return;
    }
    case 'include': {
      const file = resolveInside(ctx, v(step.file));
      if (ctx.includeStack.includes(file) || ctx.includeStack.length >= MAX_INCLUDE_DEPTH) throw new Error(`include cycle or too deep: ${step.file}`);
      const child = await loadScenario(file);
      for (const [k, val] of Object.entries(child.vars ?? {})) if (!(k in ctx.vars)) ctx.vars[k] = val;
      for (const [k, val] of Object.entries(step.vars ?? {})) ctx.vars[k] = v(val);
      const saved = { baseDir: ctx.baseDir, fileDepth: ctx.fileDepth };
      ctx.baseDir = path.dirname(file); ctx.fileDepth++; ctx.includeStack.push(file);
      try { await runChildren(ctx, child.steps, `${p}.`, depth + 1); }
      finally { ctx.includeStack.pop(); Object.assign(ctx, saved); }
      return;
    }
    default: throw new Error(`internal: ${step.action} is not a container`);
  }
};

const CONTAINERS = new Set(['if', 'repeat', 'forEach', 'include']);

const runStep = async (ctx: Ctx, step: Step, p: string, depth: number): Promise<void> => {
  const rec: StepRecord = { path: p, depth, action: step.action, status: 'passed', ms: 0, ...(step.note ? { note: step.note } : {}) };
  ctx.records.push(rec);
  const t0 = Date.now();
  const pad = '  '.repeat(depth + 1);
  const container = CONTAINERS.has(step.action);
  try {
    if (container) {
      ctx.log(`${pad}${p}. ${describe(step)}`);
      await runContainer(ctx, step, p, depth);
    } else {
      const attempts = (step.retry ?? 0) + 1;
      const exec = hasSelector(step) ? await resolveAi(ctx, step, pad, p) : step;
      for (let a = 1; ; a++) {
        try {
          try {
            await executeLeaf(ctx, exec);
          } catch (err) {
            if (!ctx.heal || ctx.noAi || !hasSelector(step)) throw err;
            ctx.log(`${pad}step ${p} failed on selector, asking the model to repair it`);
            const old = step.selector!;
            const sug = await suggestSelector(step, (err as Error).message, await reducedDom(ctx.page), ctx.ai);
            if (!sug) throw err;
            const fixed = { ...step, selector: sug.selector } as Step;
            await executeLeaf(ctx, fixed);
            Object.assign(step, { selector: sug.selector });
            if (ctx.fileDepth === 0) ctx.healedRoot = true;
            rec.status = 'healed'; rec.healedSelector = sug.selector;
            ctx.log(`${pad}healed: ${JSON.stringify(old)} -> ${JSON.stringify(sug.selector)} (${sug.reason})`);
          }
          break;
        } catch (err) {
          if (a >= attempts) throw err;
          ctx.log(`${pad}${p}. attempt ${a}/${attempts} failed: ${(err as Error).message.split('\n')[0]}; retrying`);
          await sleep(300);
        }
      }
      rec.ms = Date.now() - t0;
      ctx.log(`${pad}ok ${p}. ${describe(step)} (${rec.ms}ms)`);
      return;
    }
    rec.ms = Date.now() - t0;
  } catch (err) {
    rec.ms = Date.now() - t0;
    rec.error = err instanceof StepError ? 'a child step failed' : (err as Error).message.split('\n')[0]!;
    if (!(err instanceof StepError)) {
      const file = `${ctx.slug}-${p.replace(/\./g, '-')}-fail.png`;
      try { await mkdir(ctx.outDir, { recursive: true }); await ctx.page.screenshot({ path: path.join(ctx.outDir, file), fullPage: true }); rec.screenshot = file; } catch { /* page may be gone */ }
    }
    if (step.continueOnError) {
      rec.status = 'ignored';
      ctx.log(`${pad}ignored failure ${p}. ${describe(step)}: ${rec.error}`);
      return;
    }
    rec.status = 'failed';
    ctx.log(`${pad}FAIL ${p}. ${describe(step)}: ${rec.error}`);
    throw err instanceof StepError ? err : new StepError(rec.error);
  }
};

export const runScenario = async (scenario: Scenario, opts: RunOptions = {}): Promise<RunReport> => {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const working: Step[] = structuredClone(scenario.steps);
  const initial: Vars = { ...(opts.baseVars ?? {}), ...(scenario.vars ?? {}), ...(opts.overrideVars ?? {}) };
  const vars: Vars = structuredClone(initial);
  const baseDir = opts.file ? path.dirname(path.resolve(opts.file)) : opts.rootDir;
  const rootDir = opts.rootDir ?? baseDir;
  const headless = opts.headless ?? scenario.headless ?? opts.defaults?.headless ?? true;

  // Fail before a browser opens if the scenario needs AI and cannot have it.
  const pending = unlockedAi(working);
  if (pending.length) {
    if (opts.noAi) throw new AiError(`--no-ai is set but ${pending.length} step(s) still use ai= without a locked selector (${pending.map((d) => `"${d}"`).join(', ')}). Run once with --lock.`);
    if (!(opts.ai?.apiKey ?? process.env.ANTHROPIC_API_KEY)) throw new AiError(`${pending.length} step(s) use ai= selectors but ANTHROPIC_API_KEY is not set. Export it, or lock the selectors earlier with --lock.`);
  }
  const aiContext = pending.length
    ? [await loadContext(opts.rootDir ?? baseDir), opts.context ?? '', scenario.context ?? ''].filter((x) => x.trim()).join('\n\n')
    : '';

  const session = await openSession(headless, opts.launcher);
  const ctx: Ctx = {
    page: session.page, context: session.page.context(), vars, env: opts.env ?? process.env,
    ...((scenario.baseUrl ?? opts.baseUrl) ? { baseUrl: (scenario.baseUrl ?? opts.baseUrl)! } : {}),
    ...(baseDir ? { baseDir } : {}), ...(rootDir ? { rootDir } : {}),
    timeout: scenario.timeout ?? opts.defaults?.timeout ?? 10_000,
    outDir: opts.outDir ?? path.join('runs', startedAt.replace(/[:.]/g, '-')),
    log, heal: opts.heal === true, noAi: opts.noAi === true, aiContext: '', picks: [], lockedRoot: false, ...(opts.ai ? { ai: opts.ai } : {}),
    records: [], slug: slug(scenario.name), includeStack: opts.file ? [path.resolve(opts.file)] : [], healedRoot: false, fileDepth: 0,
  };

  const report = (error?: string): RunReport => {
    const changed: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(vars)) if (JSON.stringify(val) !== JSON.stringify(initial[k])) changed[k] = val;
    return {
      scenario: scenario.name, ...(opts.file ? { file: opts.file } : {}), tags: scenario.tags ?? [],
      status: error ? 'failed' : 'passed', startedAt, durationMs: Date.now() - started,
      steps: ctx.records, vars: changed, ...(error ? { error } : {}),
      ...(ctx.healedRoot ? { healed: { ...scenario, steps: working } } : {}),
      ...(ctx.lockedRoot ? { locked: { ...scenario, steps: working } } : {}),
      ...(ctx.picks.length ? { picks: ctx.picks } : {}),
    };
  };

  ctx.aiContext = aiContext;
  try {
    log(`run "${scenario.name}" (${working.length} steps)`);
    try {
      await runChildren(ctx, working, '', 0);
    } catch (err) {
      const failed = ctx.records.find((r) => r.status === 'failed' && !r.path.includes('.')) ?? ctx.records.find((r) => r.status === 'failed');
      return report(failed ? `step ${failed.path} (${failed.action}): ${failed.error}` : (err as Error).message);
    }
    log('passed');
    return report();
  } finally {
    await session.close();
  }
};
