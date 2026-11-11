import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseMarkdown, MarkdownError } from './markdown.ts';
import { ScenarioSchema, formatIssues, type Scenario } from './schema.ts';

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
