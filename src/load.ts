import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseMarkdown, MarkdownError } from './markdown.ts';
import { ScenarioSchema, formatIssues, type Scenario, type Step } from './schema.ts';

export class ScenarioFileError extends Error {}

/** Parses scenario text; `ext` is ".json" or ".md". */
export const parseScenarioText = (text: string, ext: string, label = 'scenario'): Scenario => {
  let data: unknown;
  try {
    data = ext === '.md' || ext === '.markdown' ? parseMarkdown(text) : JSON.parse(text);
  } catch (e) {
    const kind = e instanceof MarkdownError ? 'invalid markdown' : 'not valid JSON';
    throw new ScenarioFileError(`${label}: ${kind}: ${(e as Error).message}`);
  }
  const parsed = ScenarioSchema.safeParse(data);
  if (!parsed.success) throw new ScenarioFileError(`${label}:\n${formatIssues(parsed.error)}`);
  return parsed.data;
};

export const loadScenario = async (file: string): Promise<Scenario> => {
  const text = await readFile(file, 'utf8').catch((e: Error) => {
    throw new ScenarioFileError(`${file}: cannot read: ${e.message}`);
  });
  return parseScenarioText(text, path.extname(file).toLowerCase(), file);
};

/** Static check: every `include`/`script file` target exists and stays inside rootDir. */
export const missingReferences = async (scenario: Scenario, baseDir: string, rootDir = baseDir): Promise<string[]> => {
  const problems: string[] = [];
  const walk = async (steps: readonly Step[]): Promise<void> => {
    for (const s of steps) {
      const file = s.action === 'include' ? s.file : s.action === 'script' ? s.file : undefined;
      if (file && !file.includes('{{')) {
        const abs = path.resolve(baseDir, file);
        const rel = path.relative(rootDir, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) problems.push(`${s.action} "${file}" is outside the project directory`);
        else if (!(await stat(abs).catch(() => null))) problems.push(`${s.action} "${file}" does not exist`);
      }
      if (s.action === 'if') { await walk(s.then); await walk(s.else ?? []); }
      if (s.action === 'repeat' || s.action === 'forEach') await walk(s.steps);
    }
  };
  await walk(scenario.steps);
  return problems;
};
