import { chromium } from 'playwright';
export default async (opts) => {
  globalThis.__launcherCalls = [...(globalThis.__launcherCalls ?? []), opts];
  const browser = await chromium.launch({ headless: opts.headless });
  const page = await (await browser.newContext({ extraHTTPHeaders: { 'x-from-launcher': '1' } })).newPage();
  return page; // a Page is accepted too
};
