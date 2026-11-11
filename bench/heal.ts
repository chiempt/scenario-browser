/** `npm run bench:heal` — runs every case with and without --heal against local fixtures.
 *  Needs ANTHROPIC_API_KEY for the heal run. Without it, only validates fixtures and writes "not measured". */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { parseScenarioText } from '../src/load.ts';
import { runScenario } from '../src/runner.ts';
import { DEFAULT_MODEL } from '../src/ai.ts';
import { cases } from './cases.ts';

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const model = process.env.SCENARIO_MODEL ?? DEFAULT_MODEL;
const runs = Number(process.env.BENCH_RUNS ?? 1);
let current = '';
const site = createServer((req, res) => {
  const [id, v] = (req.url ?? '').slice(1).split('/');
  const c = cases.find((x) => x.id === id);
  res.writeHead(c ? 200 : 404, { 'content-type': 'text/html' });
  res.end(c ? (v === 'before' ? c.before : c.after) : 'nf');
  current = id ?? '';
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

const scn = (c: { steps: unknown[] }, v: 'before' | 'after', steps = c.steps) =>
  parseScenarioText(JSON.stringify({ name: 'bench', timeout: 1500, steps: [{ action: 'goto', url: `${base}/${(c as { id: string }).id}/${v}` }, ...steps] }), '.json');
const run = async (c: (typeof cases)[number], v: 'before' | 'after', heal: boolean, steps = c.steps) => {
  const r = await runScenario(scn(c, v, steps), { heal });
  return { ok: r.status === 'passed', healed: r.steps.find((s) => s.healedSelector)?.healedSelector };
};
const swap = (c: (typeof cases)[number]) => {
  const steps = JSON.parse(JSON.stringify(c.steps)) as Record<string, unknown>[];
  const broken = c.broken ?? steps.find((s) => typeof s.selector === 'string' && s.selector !== '#o')?.selector;
  return steps.map((s) => (s.selector === broken ? { ...s, selector: c.goodSelectors[0] } : s));
};

type Row = { id: string; change: string; fixtureOk: boolean; baseline: boolean; healed?: number; ms?: number; selector?: string };
const rows: Row[] = [];
for (const c of cases) {
  const beforeOk = (await run(c, 'before', false)).ok;
  const brokenOnAfter = !(await run(c, 'after', false)).ok;
  const oracleOk = (await run(c, 'after', false, swap(c))).ok;
  const row: Row = { id: c.id, change: c.change, fixtureOk: beforeOk && brokenOnAfter && oracleOk, baseline: !brokenOnAfter };
  if (hasKey) {
    let pass = 0; const t0 = Date.now();
    for (let i = 0; i < runs; i++) { const r = await run(c, 'after', true); if (r.ok) pass++; row.selector = r.healed ?? row.selector; }
    row.healed = pass / runs; row.ms = Math.round((Date.now() - t0) / runs);
  }
  rows.push(row);
  console.log(`${c.id}: fixture ${row.fixtureOk ? 'ok' : 'BAD'}${hasKey ? `, healed ${row.healed! * 100}%` : ''}`);
}
site.close();

const okFix = rows.filter((r) => r.fixtureOk).length;
const date = new Date().toISOString().slice(0, 10);
const table = rows.map((r) => `| ${r.id} | ${r.change} | ${r.fixtureOk ? 'yes' : 'NO'} | ${hasKey ? `${Math.round(r.healed! * 100)}% (${r.selector ?? 'none'}, ${r.ms} ms)` : 'not measured'} |`).join('\n');
const head = hasKey
  ? `**Measured ${date}** with model \`${model}\`, ${runs} run(s) per case: **${rows.filter((r) => r.healed === 1).length}/${rows.length}** cases healed on every run.`
  : `**Not measured yet: ANTHROPIC_API_KEY was not set when this report was generated (${date}).** The fixtures were validated without the model (below); the heal column is empty on purpose. Run \`ANTHROPIC_API_KEY=... npm run bench:heal\` to fill it in.`;
await writeFile(new URL('../docs/HEAL-BENCH.md', import.meta.url), `# Heal benchmark

${head}

Each case is a local HTML page. The scenario is written against the "before" page; the site then ships the "after" page where the selector changed in a common way. \`--heal\` must make the unchanged scenario pass on "after" (the final \`expect\` is the success check). Cases: ${rows.length}. Fixture validation (scenario passes on "before", fails on "after" without heal, passes on "after" with a known-good selector): ${okFix}/${rows.length}.

| Case | What changed | Fixture valid | Heal pass rate |
|---|---|---|---|
${table}

Limits: ${rows.length} small synthetic pages, one model, tiny DOMs. This measures the repair loop on easy-to-medium breakage, not real-world sites. Re-generate with \`npm run bench:heal\` (set \`BENCH_RUNS=3\` for a pass rate per case).
`);
console.log(`wrote docs/HEAL-BENCH.md (fixtures ok ${okFix}/${rows.length}, heal ${hasKey ? 'measured' : 'not measured'})`);
process.exit(okFix === rows.length ? 0 : 1);
