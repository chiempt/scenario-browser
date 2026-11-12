import type { Page } from 'playwright-core';

export interface DomItem {
  tag: string; id?: string; name?: string; type?: string; role?: string; text?: string;
  placeholder?: string; ariaLabel?: string; labelText?: string; testId?: string; href?: string; css: string;
}

/**
 * A compact view of what a person could interact with, for the AI to pick a
 * replacement selector from. Never includes field values (no passwords/PII),
 * and caps size so the prompt stays small.
 */
export const reducedDom = async (page: Page, max = 80): Promise<DomItem[]> =>
  page.evaluate((limit) => {
    const sel = 'a,button,input,select,textarea,[role],[data-testid],h1,h2,h3,label';
    const out: DomItem[] = [];
    const cssOf = (el: Element): string => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.tagName !== 'BODY' && parts.length < 4) {
        const parent: Element | null = cur.parentElement;
        const tag = cur.tagName.toLowerCase();
        const idx = parent ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName).indexOf(cur) + 1 : 1;
        parts.unshift(`${tag}:nth-of-type(${idx})`);
        cur = parent;
      }
      return parts.join(' > ');
    };
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') continue;
      const g = (a: string) => el.getAttribute(a) ?? undefined;
      const item: DomItem = { tag: el.tagName.toLowerCase(), css: cssOf(el) };
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (el.id) item.id = el.id;
      if (g('name')) item.name = g('name')!;
      if (g('type')) item.type = g('type')!;
      if (g('role')) item.role = g('role')!;
      // Never read text of form controls: a textarea's textContent is its value, a select lists options.
      if (text && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) item.text = text;
      const lbl = (el as HTMLInputElement).labels?.[0]?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60);
      if (lbl) item.labelText = lbl;
      if (g('placeholder')) item.placeholder = g('placeholder')!;
      if (g('aria-label')) item.ariaLabel = g('aria-label')!;
      if (g('data-testid')) item.testId = g('data-testid')!;
      if (el.tagName === 'A' && g('href')) item.href = g('href')!.split(/[?#]/)[0]!.slice(0, 80);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }, max);
