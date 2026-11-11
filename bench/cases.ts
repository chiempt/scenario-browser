/** Heal benchmark cases. Each scenario is written against `before`; the site then ships `after`.
 *  `oracle` is a selector known to work on `after` (used to validate the fixture, never shown to the model). */
export interface Case { id: string; change: string; before: string; after: string; steps: unknown[]; goodSelectors: string[]; broken?: string }

const page = (body: string) => `<!doctype html><title>Bench</title>${body}`;

export const cases: Case[] = [
  {
    id: 'id-renamed', change: 'button id renamed',
    before: page(`<input id="q"><button id="search" onclick="o.textContent='Found '+q.value">Search</button><p id="o"></p>`),
    after: page(`<input id="q"><button id="btn-search-v2" onclick="o.textContent='Found '+q.value">Search</button><p id="o"></p>`),
    steps: [{ action: 'fill', selector: '#q', value: 'cats' }, { action: 'click', selector: '#search' }, { action: 'expect', kind: 'text', selector: '#o', value: 'Found cats' }],
    goodSelectors: ['#btn-search-v2', 'text=Search'], broken: '#search',
  },
  {
    id: 'input-id-renamed', change: 'input id renamed, label kept',
    before: page(`<label for="email">Email</label><input id="email"><button onclick="o.textContent='Hi '+document.querySelector('input').value">Go</button><p id="o"></p>`),
    after: page(`<label for="user-email-field">Email</label><input id="user-email-field"><button onclick="o.textContent='Hi '+document.querySelector('input').value">Go</button><p id="o"></p>`),
    steps: [{ action: 'fill', selector: '#email', value: 'a@b.co' }, { action: 'click', selector: 'text=Go' }, { action: 'expect', kind: 'text', selector: '#o', value: 'Hi a@b.co' }],
    goodSelectors: ['#user-email-field', 'label=Email'],
  },
  {
    id: 'class-renamed', change: 'CSS class renamed',
    before: page(`<button class="btn-primary" onclick="o.textContent='Saved'">Save</button><p id="o"></p>`),
    after: page(`<button class="c-button c-button--accent" onclick="o.textContent='Saved'">Save</button><p id="o"></p>`),
    steps: [{ action: 'click', selector: '.btn-primary' }, { action: 'expect', kind: 'text', selector: '#o', value: 'Saved' }],
    goodSelectors: ['.c-button', 'text=Save'],
  },
  {
    id: 'text-changed', change: 'button text changed',
    before: page(`<button id="b" onclick="o.textContent='Done'">Submit</button><p id="o"></p>`),
    after: page(`<button id="b2" onclick="o.textContent='Done'">Send now</button><p id="o"></p>`),
    steps: [{ action: 'click', selector: 'text=Submit' }, { action: 'expect', kind: 'text', selector: '#o', value: 'Done' }],
    goodSelectors: ['text=Send now', '#b2'],
  },
  {
    id: 'wrapped-div', change: 'extra wrapper divs, structural selector',
    before: page(`<div class="form"><button onclick="o.textContent='OK'">Confirm</button></div><p id="o"></p>`),
    after: page(`<div class="form"><div class="row"><div class="cell"><button onclick="o.textContent='OK'">Confirm</button></div></div></div><p id="o"></p>`),
    steps: [{ action: 'click', selector: '.form > button' }, { action: 'expect', kind: 'text', selector: '#o', value: 'OK' }],
    goodSelectors: ['.cell > button', 'text=Confirm'],
  },
  {
    id: 'select-renamed', change: 'select id renamed',
    before: page(`<select id="country" onchange="o.textContent='Picked '+this.value"><option value="">-</option><option value="vn">vn</option><option value="us">us</option></select><p id="o"></p>`),
    after: page(`<select id="ctry-select" aria-label="Country" onchange="o.textContent='Picked '+this.value"><option value="">-</option><option value="vn">vn</option><option value="us">us</option></select><p id="o"></p>`),
    steps: [{ action: 'select', selector: '#country', value: 'vn' }, { action: 'expect', kind: 'text', selector: '#o', value: 'Picked vn' }],
    goodSelectors: ['#ctry-select', 'select'],
  },
  {
    id: 'checkbox-moved', change: 'checkbox id renamed and moved into a label',
    before: page(`<input type="checkbox" id="agree" onchange="o.textContent=this.checked?'Agreed':'No'"><span>I agree</span><p id="o"></p>`),
    after: page(`<label class="tos"><input type="checkbox" id="tos-accept" onchange="o.textContent=this.checked?'Agreed':'No'"> I agree</label><p id="o"></p>`),
    steps: [{ action: 'check', selector: '#agree' }, { action: 'expect', kind: 'text', selector: '#o', value: 'Agreed' }],
    goodSelectors: ['#tos-accept', 'label=I agree'],
  },
  {
    id: 'data-attr', change: 'data-testid renamed',
    before: page(`<button data-testid="buy-now" onclick="o.textContent='Bought'">Buy</button><p id="o"></p>`),
    after: page(`<button data-qa="purchase-cta" onclick="o.textContent='Bought'">Buy</button><p id="o"></p>`),
    steps: [{ action: 'click', selector: '[data-testid="buy-now"]' }, { action: 'expect', kind: 'text', selector: '#o', value: 'Bought' }],
    goodSelectors: ['[data-qa="purchase-cta"]', 'text=Buy'],
  },
  {
    id: 'waitfor-heading', change: 'heading id renamed (waitFor + extract)',
    before: page(`<h1 id="title">Dashboard</h1>`),
    after: page(`<header><h1 id="page-heading">Dashboard</h1></header>`),
    steps: [{ action: 'waitFor', selector: '#title' }, { action: 'extract', selector: '#title', as: 't' }, { action: 'expect', kind: 'text', value: '{{t}}' }],
    goodSelectors: ['#page-heading', 'h1'],
  },
  {
    id: 'ambiguous-twins', change: 'two similar buttons, ids renamed (harder: pick the right one)',
    before: page(`<button id="save" onclick="o.textContent='Saved'">Save</button><button id="cancel" onclick="o.textContent='Cancelled'">Cancel</button><p id="o"></p>`),
    after: page(`<button id="act-1" onclick="o.textContent='Saved'">Save</button><button id="act-2" onclick="o.textContent='Cancelled'">Cancel</button><p id="o"></p>`),
    steps: [{ action: 'click', selector: '#save' }, { action: 'expect', kind: 'text', selector: '#o', value: 'Saved' }],
    goodSelectors: ['#act-1', 'text=Save'],
  },
];
