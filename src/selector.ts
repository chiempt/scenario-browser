import type { Locator, Page } from 'playwright-core';

/**
 * Selector strings. A prefix picks the strategy; no prefix means "whatever
 * Playwright understands" (CSS, or XPath when it starts with // or (//).
 *
 *   xpath=//button[@id="go"]      css=.card > a       text=Login
 *   role=button[name="Sign in"]   testid=login-btn    label=Email
 *   placeholder=Search            ai=the Sign in button in the top right
 */
export const SELECTOR_KINDS = ['xpath', 'css', 'text', 'role', 'testid', 'label', 'placeholder', 'ai'] as const;
export const KIND_PREFIX = /^(xpath|css|text|role|testid|label|placeholder|ai)=/i;

export const isAiSelector = (selector: string): boolean => /^ai=/i.test(selector);

const ROLE = /^role=([A-Za-z-]+)(?:\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(.*?))\])?$/i;

export const parseRole = (selector: string): { role: string; name?: string } | null => {
  const m = ROLE.exec(selector.trim());
  if (!m) return null;
  const raw = m[2] ?? m[3] ?? m[4];
  return { role: m[1]!.toLowerCase(), ...(raw === undefined ? {} : { name: raw.replace(/\\(.)/g, '$1') }) };
};

export const toLocator = (page: Page, selector: string): Locator => {
  const s = selector.trim();
  const m = KIND_PREFIX.exec(s);
  if (!m) return page.locator(s);
  const kind = m[1]!.toLowerCase();
  const rest = s.slice(m[0].length);
  switch (kind) {
    case 'label': return page.getByLabel(rest);
    case 'placeholder': return page.getByPlaceholder(rest);
    case 'testid': return page.getByTestId(rest);
    case 'role': {
      const r = parseRole(s);
      if (!r) throw new Error(`bad role selector "${s}", use role=button[name="Sign in"]`);
      return page.getByRole(r.role as Parameters<Page['getByRole']>[0], r.name === undefined ? {} : { name: r.name });
    }
    case 'ai': throw new Error(`"${s}" is an AI target that was not resolved (needs ANTHROPIC_API_KEY, or lock it with --lock)`);
    default: return page.locator(s); // xpath=, css=, text= are native Playwright engines
  }
};
