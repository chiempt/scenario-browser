import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchContext } from 'cloakbrowser';
import type { BrowserContext, Page } from 'playwright-core';

export interface LaunchOptions { headless: boolean }
/** What a launcher module's exported function may return. */
export type LauncherResult = BrowserContext | Page;
export type LauncherFn = (options: LaunchOptions) => Promise<LauncherResult> | LauncherResult;

export interface Session { page: Page; close(): Promise<void> }

const isPage = (x: unknown): x is Page => typeof (x as Page)?.goto === 'function';
const isContext = (x: unknown): x is BrowserContext => typeof (x as BrowserContext)?.newPage === 'function';

/** Wraps whatever a launcher returned into one page and one close(). */
export const toSession = async (result: unknown): Promise<Session> => {
  if (isPage(result)) {
    const ctx = result.context();
    return { page: result, close: async () => { await ctx.close(); await ctx.browser()?.close(); } };
  }
  if (isContext(result)) {
    const page = result.pages()[0] ?? (await result.newPage());
    return { page, close: async () => { await result.close(); await result.browser()?.close(); } };
  }
  throw new Error('launcher must return a Playwright BrowserContext or Page');
};

/** Loads `--launcher <module>`: a path or package name whose default (or `launch`) export is a function. */
export const loadLauncher = async (spec: string): Promise<LauncherFn> => {
  const target = /^[./]/.test(spec) || path.isAbsolute(spec) ? pathToFileURL(path.resolve(spec)).href : spec;
  const mod = (await import(target)) as { default?: unknown; launch?: unknown };
  const fn = typeof mod.default === 'function' ? mod.default : mod.launch;
  if (typeof fn !== 'function') throw new Error(`launcher ${spec} must export a default function (or "launch")`);
  return fn as LauncherFn;
};

/** Default: CloakBrowser (stealth Chromium, Playwright API). */
export const defaultLauncher: LauncherFn = ({ headless }) => launchContext({ headless });

export const openSession = async (headless: boolean, launcher?: string): Promise<Session> => {
  const fn = launcher ? await loadLauncher(launcher) : defaultLauncher;
  return toSession(await fn({ headless }));
};
