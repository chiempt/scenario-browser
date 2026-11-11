import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { openSession } from './launch.ts';
import { suggestSelector, type AiOptions } from './ai.ts';
import { reducedDom } from './dom.ts';
import type { Scenario, Step } from './schema.ts';
import { interpolate } from './template.ts';

export interface StepRecord {
  index: number; action: string; status: 'passed' | 'failed' | 'healed';
  ms: number; error?: string; healedSelector?: string; note?: string;
}
export interface RunReport {
  scenario: string; status: 'passed' | 'failed'; durationMs: number;
  steps: StepRecord[]; vars: Record<string, string>; error?: string;
  /** Scenario with healed selectors applied; only present if something healed. */
  healed?: Scenario;
}
export interface RunOptions {
  headless?: boolean;
  /** Ask the AI for a replacement selector when a step fails on one. */
  heal?: boolean;
  ai?: AiOptions;
  /** Module path/package exporting a function that returns a BrowserContext or Page. */
  launcher?: string;
  log?: (line: string) => void;
  /** Where screenshots land. Default: ./runs/<timestamp> */
  outDir?: string;
}

const locate = (page: Page, selector: string): Locator =>
  selector.startsWith('label=') ? page.getByLabel(selector.slice(6)) : page.locator(selector);

const describe = (s: Step): string => {
  const { action, note: _n, ...rest } = s as Step & { note?: string };
  return `${action} ${Object.values(rest).map((v) => JSON.stringify(v)).join(' ')}`;
};

const hasSelector = (s: Step): s is Step & { selector: string } => 'selector' in s && typeof s.selector === 'string';

const execute = async (page: Page, step: Step, vars: Record<string, string>, t: number, outDir: string): Promise<void> => {
  const v = (x: string) => interpolate(x, vars);
  switch (step.action) {
    case 'goto': await page.goto(v(step.url), { timeout: t, waitUntil: 'domcontentloaded' }); break;
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
    case 'extract': {
      const text = await locate(page, v(step.selector)).first().innerText({ timeout: t });
      vars[step.as] = text.trim();
      break;
    }
    case 'screenshot': {
      await mkdir(outDir, { recursive: true });
      await page.screenshot({ path: path.join(outDir, path.basename(v(step.path))), fullPage: true });
      break;
    }
    case 'expect': {
      const want = step.value === undefined ? '' : v(step.value);
      if (step.kind === 'visible') {
        await locate(page, v(step.selector!)).first().waitFor({ state: 'visible', timeout: t });
      } else if (step.kind === 'text') {
        const target = step.selector ? locate(page, v(step.selector)).first() : page.locator('body');
        const deadline = Date.now() + t;
        let got = '';
        for (;;) {
          got = await target.innerText({ timeout: t });
          if (got.includes(want)) break;
          if (Date.now() > deadline) throw new Error(`expected text "${want}" not found`);
          await page.waitForTimeout(100);
        }
      } else {
        const deadline = Date.now() + t;
        for (;;) {
          const got = step.kind === 'url' ? page.url() : await page.title();
          if (got.includes(want)) break;
          if (Date.now() > deadline) throw new Error(`expected ${step.kind} to contain "${want}", got "${got}"`);
          await page.waitForTimeout(100);
        }
      }
      break;
    }
  }
};

export const runScenario = async (scenario: Scenario, opts: RunOptions = {}): Promise<RunReport> => {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const timeout = scenario.timeout ?? 10_000;
  const vars: Record<string, string> = { ...(scenario.vars ?? {}) };
  const outDir = opts.outDir ?? path.join('runs', new Date().toISOString().replace(/[:.]/g, '-'));
  const working: Step[] = structuredClone(scenario.steps);
  const records: StepRecord[] = [];
  let healedAny = false;

  const session = await openSession(opts.headless ?? scenario.headless ?? true, opts.launcher);
  try {
    const page = session.page;
    log(`run "${scenario.name}" (${working.length} steps)`);
    for (let i = 0; i < working.length; i++) {
      let step = working[i]!;
      const t0 = Date.now();
      const rec: StepRecord = { index: i + 1, action: step.action, status: 'passed', ms: 0, ...(step.note ? { note: step.note } : {}) };
      try {
        try {
          await execute(page, step, vars, timeout, outDir);
        } catch (err) {
          if (!opts.heal || !hasSelector(step)) throw err;
          log(`  step ${i + 1} failed on selector, asking the model to repair it`);
          const sug = await suggestSelector(step, (err as Error).message, await reducedDom(page), opts.ai);
          if (!sug) throw err;
          const fixed = { ...step, selector: sug.selector } as Step;
          await execute(page, fixed, vars, timeout, outDir);
          log(`  healed: ${JSON.stringify((step as { selector: string }).selector)} -> ${JSON.stringify(sug.selector)} (${sug.reason})`);
          working[i] = fixed; step = fixed; healedAny = true;
          rec.status = 'healed'; rec.healedSelector = sug.selector;
        }
        rec.ms = Date.now() - t0;
        records.push(rec);
        log(`  ok ${i + 1}. ${describe(step)} (${rec.ms}ms)`);
      } catch (err) {
        rec.status = 'failed'; rec.ms = Date.now() - t0; rec.error = (err as Error).message.split('\n')[0]!;
        records.push(rec);
        log(`  FAIL ${i + 1}. ${describe(step)}: ${rec.error}`);
        return {
          scenario: scenario.name, status: 'failed', durationMs: Date.now() - started, steps: records, vars,
          error: `step ${i + 1} (${step.action}): ${rec.error}`,
          ...(healedAny ? { healed: { ...scenario, steps: working } } : {}),
        };
      }
    }
    log('passed');
    return {
      scenario: scenario.name, status: 'passed', durationMs: Date.now() - started, steps: records, vars,
      ...(healedAny ? { healed: { ...scenario, steps: working } } : {}),
    };
  } finally {
    await session.close();
  }
};
