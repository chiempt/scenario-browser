import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunReport } from './runner.ts';

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Markdown: `click ai="x"` becomes `click "<selector>" <!-- ai="x" -->`, one pick per matching token, in order. */
export const lockMarkdown = (text: string, picks: { ai: string; selector: string }[]): { text: string; applied: number } => {
  let out = text, applied = 0;
  for (const p of picks) {
    const token = `ai="${esc(p.ai)}"`;
    const lines = out.split('\n');
    const i = lines.findIndex((l) => /^\s*[-*]\s/.test(l) && l.includes(token) && !l.includes('<!-- ai='));
    if (i < 0) continue;
    lines[i] = lines[i]!.replace(token, `"${esc(p.selector)}"`).trimEnd() + ` <!-- ai="${esc(p.ai)}" -->`;
    out = lines.join('\n');
    applied++;
  }
  return { text: out, applied };
};

/** Writes what the AI found back into the scenario file. Returns a one-line note, or undefined if nothing to save. */
export const applyLock = async (file: string, report: Pick<RunReport, 'locked' | 'picks'>): Promise<string | undefined> => {
  if (!report.locked || !report.picks?.length) return undefined;
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    const current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const { steps } = report.locked;
    await writeFile(file, JSON.stringify({ ...current, steps }, null, 2) + '\n');
    return `locked ${report.picks.length} selector(s) in ${file}`;
  }
  if (ext === '.md' || ext === '.markdown') {
    const { text, applied } = lockMarkdown(await readFile(file, 'utf8'), report.picks);
    if (applied) await writeFile(file, text);
    return `locked ${applied}/${report.picks.length} selector(s) in ${file}${applied < report.picks.length ? ' (the rest are inside include files or dynamic; lock those files directly)' : ''}`;
  }
  return undefined;
};
