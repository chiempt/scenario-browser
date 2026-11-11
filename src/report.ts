import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunReport } from './runner.ts';

export interface ProjectReport {
  project: string; startedAt: string; durationMs: number;
  status: 'passed' | 'failed';
  counts: { total: number; passed: number; failed: number };
  scenarios: (RunReport & { phase: 'setup' | 'test' | 'teardown' })[];
  /** Set when the run stopped before the tests (e.g. setup failed). */
  note?: string;
}

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const renderHtml = (r: ProjectReport): string => {
  const rows = r.scenarios.map((s) => {
    const steps = s.steps.map((st) => `<tr class="${st.status}">
<td>${esc(st.path)}</td><td style="padding-left:${8 + st.depth * 16}px">${esc(st.action)}${st.note ? ` <i>${esc(st.note)}</i>` : ''}</td>
<td>${esc(st.status)}</td><td>${st.ms}ms</td>
<td>${st.error ? esc(st.error) : ''}${st.healedSelector ? `healed to <code>${esc(st.healedSelector)}</code>` : ''}${st.screenshot ? ` <a href="shots/${encodeURIComponent(st.screenshot)}"><img alt="failure screenshot" src="shots/${encodeURIComponent(st.screenshot)}" loading="lazy"></a>` : ''}</td></tr>`).join('\n');
    return `<details ${s.status === 'failed' ? 'open' : ''}><summary class="${s.status}">${esc(s.status.toUpperCase())} &middot; ${esc(s.scenario)}
<small>${esc(s.phase)} &middot; ${s.durationMs}ms${s.tags.length ? ' &middot; ' + s.tags.map(esc).join(', ') : ''}${s.file ? ' &middot; ' + esc(s.file) : ''}</small></summary>
${s.error ? `<p class="failed">${esc(s.error)}</p>` : ''}
<table><thead><tr><th>#</th><th>step</th><th>status</th><th>time</th><th>detail</th></tr></thead><tbody>${steps}</tbody></table></details>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.project)} test report</title><style>
:root{color-scheme:light dark;--ok:#1a8f3c;--bad:#d33;--mut:#777;--bd:#8884}
body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin:8px 0}
td,th{border-bottom:1px solid var(--bd);padding:4px 8px;text-align:left;vertical-align:top}
tr.failed,summary.failed,p.failed{color:var(--bad)}summary.passed,tr.passed{color:inherit}tr.ignored{color:var(--mut)}tr.healed{color:#b80}
summary{cursor:pointer;font-weight:600;padding:6px 0}summary small{font-weight:400;color:var(--mut);margin-left:8px}
img{max-width:240px;display:block;border:1px solid var(--bd);margin-top:4px}.pass{color:var(--ok)}.fail{color:var(--bad)}
</style></head><body>
<h1>${esc(r.project)} <span class="${r.status === 'passed' ? 'pass' : 'fail'}">${esc(r.status)}</span></h1>
<p>${r.counts.passed}/${r.counts.total} passed, ${r.counts.failed} failed &middot; ${r.durationMs}ms &middot; ${esc(r.startedAt)}${r.note ? `<br><b>${esc(r.note)}</b>` : ''}</p>
${rows}</body></html>`;
};

/** Writes report.json + report.html into dir; failure screenshots go in dir/shots (cleared first). */
export const prepareReportDir = async (dir: string): Promise<string> => {
  await rm(path.join(dir, 'shots'), { recursive: true, force: true });
  await mkdir(path.join(dir, 'shots'), { recursive: true });
  return path.join(dir, 'shots');
};

export const writeReport = async (dir: string, report: ProjectReport): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(dir, 'report.html'), renderHtml(report));
};
