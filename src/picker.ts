import { launch } from 'cloakbrowser';
import type { Browser, Page } from 'playwright-core';

export interface PickCandidate { kind: 'xpath' | 'css' | 'text' | 'role' | 'testid' | 'label' | 'placeholder'; selector: string; matches?: number }
export interface Pick { tag: string; text: string; url: string; candidates: PickCandidate[]; at: string }

/** Runs in every page of the picker browser. Highlights on hover; a click is captured, not delivered to the page. */
const pickerInit = (): void => {
  const w = window as unknown as { __sbPicker?: boolean; __sbPicked?: (json: string) => void };
  if (w.__sbPicker) return;
  w.__sbPicker = true;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2457d6;background:rgba(36,87,214,.15);display:none';
  const mount = () => { if (!box.isConnected && document.documentElement) document.documentElement.appendChild(box); };
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const xcount = (expr: string): number => { try { return document.evaluate(expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength; } catch { return 0; } };
  const ccount = (sel: string): number => { try { return document.querySelectorAll(sel).length; } catch { return 0; } };
  const norm = (t: string | null | undefined) => (t ?? '').trim().replace(/\s+/g, ' ');
  const roleOf = (el: Element): string | undefined => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'button') return 'button';
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (['text', 'email', 'search', 'tel', 'url', 'password'].includes(ty)) return 'textbox';
    }
    return undefined;
  };
  const posXpath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      const same = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur!.tagName) : [cur];
      parts.unshift(same.length > 1 ? `${tag}[${same.indexOf(cur) + 1}]` : tag);
    }
    return '/' + parts.join('/');
  };
  const posCss = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.tagName !== 'HTML' && parts.length < 6; cur = cur.parentElement) {
      if (cur.id && ccount(`#${CSS.escape(cur.id)}`) === 1) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      const tag = cur.tagName.toLowerCase();
      const same = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur!.tagName) : [cur];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    }
    return parts.join(' > ');
  };
  const describe = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const text = norm(el.textContent).slice(0, 80);
    const own = ['input', 'textarea', 'select'].includes(tag) ? '' : text; // never read what the user typed
    const c: { kind: string; selector: string; matches?: number }[] = [];
    const id = el.getAttribute('id'), tid = el.getAttribute('data-testid'), name = el.getAttribute('name');
    const aria = el.getAttribute('aria-label'), ph = el.getAttribute('placeholder');
    const label = norm((el as HTMLInputElement).labels?.[0]?.textContent);
    if (tid) c.push({ kind: 'testid', selector: `testid=${tid}`, matches: ccount(`[data-testid=${q(tid)}]`) });
    const role = roleOf(el); const rname = aria || label || (role === 'button' || role === 'link' || role === 'heading' ? own : '');
    if (role) c.push({ kind: 'role', selector: rname && rname.length <= 60 ? `role=${role}[name=${q(rname)}]` : `role=${role}` });
    if (label) c.push({ kind: 'label', selector: `label=${label}` });
    if (ph) c.push({ kind: 'placeholder', selector: `placeholder=${ph}` });
    if (own && own.length <= 60) c.push({ kind: 'text', selector: `text=${own}` });
    if (id) { const x = `//*[@id=${q(id)}]`; c.push({ kind: 'xpath', selector: `xpath=${x}`, matches: xcount(x) }); }
    if (own && own.length <= 60 && !own.includes('"')) { const x = `//${tag}[normalize-space()=${q(own)}]`; c.push({ kind: 'xpath', selector: `xpath=${x}`, matches: xcount(x) }); }
    if (tid) { const x = `//*[@data-testid=${q(tid)}]`; c.push({ kind: 'xpath', selector: `xpath=${x}`, matches: xcount(x) }); }
    const px = posXpath(el); c.push({ kind: 'xpath', selector: `xpath=${px}`, matches: xcount(px) });
    if (id) c.push({ kind: 'css', selector: `css=#${CSS.escape(id)}`, matches: ccount(`#${CSS.escape(id)}`) });
    if (name) { const s = `${tag}[name=${q(name)}]`; c.push({ kind: 'css', selector: `css=${s}`, matches: ccount(s) }); }
    const pc = posCss(el); c.push({ kind: 'css', selector: `css=${pc}`, matches: ccount(pc) });
    return { tag, text: own.slice(0, 60), url: location.href.split(/[?#]/)[0], candidates: c, at: new Date().toISOString() };
  };
  document.addEventListener('mousemove', (e) => {
    const el = e.target as Element | null; if (!el || el === box) return;
    mount(); const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }, true);
  const swallow = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit', 'auxclick', 'dblclick']) document.addEventListener(t, swallow, true);
  document.addEventListener('click', (e) => {
    swallow(e);
    const el = e.target as Element | null; if (!el || el === box) return;
    w.__sbPicked?.(JSON.stringify(describe(el)));
  }, true);
};

export interface PickerSession {
  page: Page;
  picks: Pick[];
  last(): Pick | undefined;
  close(): Promise<void>;
}

/** Opens a normal Playwright browser on `url`; every click on the page becomes a Pick (with locator suggestions) instead of acting. */
export const startPicker = async (url: string, opts: { headless?: boolean; onPick?: (p: Pick) => void } = {}): Promise<PickerSession> => {
  if (!/^https?:\/\//i.test(url)) throw new Error('the picker only opens http(s) URLs');
  const browser: Browser = await launch({ headless: opts.headless ?? false });
  try {
    const context = await browser.newContext();
    const picks: Pick[] = [];
    await context.exposeBinding('__sbPicked', (_src, json: string) => {
      const p = JSON.parse(json) as Pick;
      picks.push(p); if (picks.length > 50) picks.shift();
      opts.onPick?.(p);
    });
    await context.addInitScript(pickerInit);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { page, picks, last: () => picks.at(-1), close: async () => { await context.close(); await browser.close(); } };
  } catch (e) { await browser.close(); throw e; }
};
