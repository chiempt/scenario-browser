#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ScenarioFileError, missingReferences, parseScenarioText } from './load.ts';
import { runScenario, type RunReport } from './runner.ts';
import { hasJs, jsonSchema, type Scenario, type Step } from './schema.ts';

export interface McpOptions {
  /** Directory that scenario paths and includes must stay inside. Default: process.cwd(). */
  workDir?: string;
}

const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

const insideDir = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return !(rel.startsWith('..') || path.isAbsolute(rel));
};

/** Looks for JS in the scenario and in every file it includes. Templated include paths cannot be checked, so they count as JS. */
const findJs = async (steps: readonly Step[], baseDir: string, root: string, depth = 0): Promise<string | undefined> => {
  if (depth > 8) return 'include nesting too deep to check';
  if (hasJs(steps)) return 'it has a JavaScript step (evaluate, script, expect js, if js)';
  for (const s of steps) {
    if (s.action === 'include') {
      if (s.file.includes('{{')) return `include "${s.file}" has a templated path`;
      const abs = path.resolve(baseDir, s.file);
      if (!insideDir(root, abs)) return `include "${s.file}" is outside the working directory`;
      const text = await readFile(abs, 'utf8').catch(() => undefined);
      if (text === undefined) continue; // reported separately as a missing reference
      let sub: Scenario;
      try { sub = parseScenarioText(text, path.extname(abs).toLowerCase(), s.file); } catch { continue; }
      const hit = await findJs(sub.steps, path.dirname(abs), root, depth + 1);
      if (hit) return `included file "${s.file}": ${hit}`;
    }
    if (s.action === 'if') {
      const hit = (await findJs(s.then, baseDir, root, depth + 1)) ?? (await findJs(s.else ?? [], baseDir, root, depth + 1));
      if (hit) return hit;
    }
    if (s.action === 'repeat' || s.action === 'forEach') {
      const hit = await findJs(s.steps, baseDir, root, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
};

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const formatFor = (source: string): '.json' | '.md' => (source.trimStart().startsWith('{') ? '.json' : '.md');

export const createServer = (options: McpOptions = {}): McpServer => {
  const root = path.resolve(options.workDir ?? process.cwd());
  const server = new McpServer({ name: 'scenario-browser', version: '0.2.0' });

  server.registerTool('validate', {
    description: 'Check a scenario (JSON or Markdown text) against the schema. Does not open a browser or run anything.',
    inputSchema: { scenario: z.string().describe('Scenario source, JSON or Markdown'), format: z.enum(['json', 'markdown']).optional().describe('Default: guessed from the text') },
  }, async ({ scenario, format }) => {
    try {
      const ext = format === 'markdown' ? '.md' : format === 'json' ? '.json' : formatFor(scenario);
      const s = parseScenarioText(scenario, ext);
      return text({ ok: true, name: s.name, steps: s.steps.length, hasJs: hasJs(s.steps) });
    } catch (e) {
      return text({ ok: false, error: (e as Error).message });
    }
  });

  server.registerTool('get_schema', {
    description: 'Return the JSON Schema for scenarios.',
    inputSchema: {},
  }, async () => text(jsonSchema()));

  server.registerTool('run', {
    description: 'Run a scenario in a headless browser and return a per-step report. Scenarios are code: only run ones you trust. JavaScript steps are refused unless allowScript is true.',
    inputSchema: {
      scenario: z.string().optional().describe('Scenario source, JSON or Markdown. Give this or path.'),
      path: z.string().optional().describe('Scenario file inside the working directory. Give this or scenario.'),
      format: z.enum(['json', 'markdown']).optional(),
      vars: z.record(z.string(), z.string()).optional().describe('Variable overrides'),
      timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe(`Whole-run limit, default ${DEFAULT_TIMEOUT_MS}`),
      allowScript: z.boolean().optional().describe('Allow JavaScript steps. Default false. Scripts run in Node with your user rights.'),
    },
  }, async ({ scenario, path: file, format, vars, timeoutMs, allowScript }) => {
    if ((scenario === undefined) === (file === undefined)) return text('Give exactly one of scenario or path.', true);
    let parsed: Scenario; let baseDir = root; let abs: string | undefined;
    try {
      if (file !== undefined) {
        abs = path.resolve(root, file);
        if (!insideDir(root, abs)) return text(`path is outside the working directory (${root})`, true);
        parsed = parseScenarioText(await readFile(abs, 'utf8'), path.extname(abs).toLowerCase(), file);
        baseDir = path.dirname(abs);
      } else {
        const ext = format === 'markdown' ? '.md' : format === 'json' ? '.json' : formatFor(scenario!);
        parsed = parseScenarioText(scenario!, ext);
      }
      const problems = await missingReferences(parsed, baseDir, root);
      if (problems.length) return text(`Invalid references:\n${problems.join('\n')}`, true);
      if (!allowScript) {
        const hit = await findJs(parsed.steps, baseDir, root);
        if (hit) return text(`Refused: ${hit}. Set allowScript to true to run JavaScript steps, only for scenarios you trust.`, true);
      }
    } catch (e) {
      const msg = e instanceof ScenarioFileError ? e.message : `cannot load scenario: ${(e as Error).message}`;
      return text(msg, true);
    }

    const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const report = await Promise.race<RunReport>([
        runScenario(parsed, {
          headless: true, rootDir: root, ...(abs ? { file: abs } : { file: path.join(root, 'inline-scenario.json') }),
          ...(vars ? { overrideVars: vars } : {}), defaults: { headless: true },
        }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`run exceeded ${limit} ms`)), limit); }),
      ]);
      return text(report, report.status !== 'passed');
    } catch (e) {
      return text(`run failed: ${(e as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
  });

  return server;
};

const main = async (): Promise<void> => {
  const server = createServer();
  await server.connect(new StdioServerTransport());
};

if (process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, '.js') === path.resolve(new URL(import.meta.url).pathname).replace(/\.ts$/, '.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
