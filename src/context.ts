import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_CONTEXT = 8000;

/**
 * Project context for ai= selectors: the `context` field of scenario.project.json
 * plus context.md next to it. Sent to the model, so keep secrets out of it.
 */
export const loadContext = async (dir: string | undefined): Promise<string> => {
  if (!dir) return '';
  const parts: string[] = [];
  const proj = await readFile(path.join(dir, 'scenario.project.json'), 'utf8').catch(() => '');
  try {
    const c = (JSON.parse(proj) as { context?: unknown }).context;
    if (typeof c === 'string' && c.trim()) parts.push(c.trim());
  } catch { /* an invalid project file is reported elsewhere */ }
  const md = await readFile(path.join(dir, 'context.md'), 'utf8').catch(() => '');
  if (md.trim()) parts.push(md.trim());
  return parts.join('\n\n').slice(0, MAX_CONTEXT);
};
