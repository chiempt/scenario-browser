#!/usr/bin/env node
import { glob, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateScenario } from './ai.ts';
import { loadScenario } from './load.ts';
import { startPortal } from './server.ts';
import { jsonSchema } from './schema.ts';
import { runScenario } from './runner.ts';

const USAGE = `scenario-browser <command>

  run <file> [--headed] [--heal] [--save-healed] [--launcher mod]   run a .json or .md scenario
  validate <file|dir>...                           check scenarios without a browser
  generate "description" [-o file.json]            AI writes a scenario (needs ANTHROPIC_API_KEY)
  portal [--port 7070]                             local web UI on 127.0.0.1
  schema                                           print the JSON Schema

Only automate sites you own or have permission to automate.`;

const flag = (args: string[], name: string): boolean => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const option = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const expand = async (paths: string[]): Promise<string[]> => {
  const files: string[] = [];
  for (const p of paths) {
    if ((await stat(p).catch(() => null))?.isDirectory()) {
      for await (const f of glob('**/*.{json,md}', { cwd: p })) files.push(path.join(p, f));
    } else files.push(p);
  }
  return files.sort();
};

const main = async (argv: string[]): Promise<number> => {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'validate': {
      const files = await expand(args);
      if (!files.length) { console.error('no files'); return 2; }
      let bad = 0;
      for (const f of files) {
        try { const s = await loadScenario(f); console.log(`ok   ${f} (${s.steps.length} steps)`); }
        catch (e) { bad++; console.error(`FAIL ${(e as Error).message}`); }
      }
      return bad ? 1 : 0;
    }
    case 'run': {
      const headed = flag(args, '--headed'), heal = flag(args, '--heal'), save = flag(args, '--save-healed');
      const launcher = option(args, '--launcher');
      const file = args[0];
      if (!file) { console.error(USAGE); return 2; }
      const report = await runScenario(await loadScenario(file), { headless: !headed, heal, log: console.log, ...(launcher ? { launcher } : {}) });
      if (report.healed && save) {
        if (!file.endsWith('.json')) console.error('--save-healed only writes .json scenarios; healed scenario not saved');
        else { await writeFile(file, JSON.stringify(report.healed, null, 2) + '\n'); console.log(`saved healed selectors to ${file}`); }
      }
      return report.status === 'passed' ? 0 : 1;
    }
    case 'generate': {
      const out = option(args, '-o');
      const description = args.join(' ').trim();
      if (!description) { console.error(USAGE); return 2; }
      const json = JSON.stringify(await generateScenario(description), null, 2) + '\n';
      if (out) { await writeFile(out, json); console.error(`wrote ${out}`); } else process.stdout.write(json);
      return 0;
    }
    case 'portal': {
      const port = Number(option(args, '--port') ?? 7070);
      const srv = await startPortal(port);
      console.log(`portal on http://127.0.0.1:${port}  (Ctrl+C to stop)`);
      await new Promise(() => srv);
      return 0;
    }
    case 'schema': console.log(JSON.stringify(jsonSchema(), null, 2)); return 0;
    default: console.log(USAGE); return cmd ? 2 : 0;
  }
};

main(process.argv.slice(2)).then((c) => process.exit(c), (e: Error) => { console.error(e.message); process.exit(1); });
