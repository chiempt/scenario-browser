import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateScenario } from './ai.ts';
import { parseScenarioText } from './load.ts';
import { startPicker, type PickerSession } from './picker.ts';
import { listProject, runProject, type LoadedProject } from './project.ts';
import { runScenario } from './runner.ts';
import { hasJs } from './schema.ts';

const PAGE = fileURLToPath(new URL('../portal/index.html', import.meta.url));
const MAX_BODY = 256 * 1024;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/**
 * Local-only portal. Because it can run scenario JavaScript, requests are
 * guarded three ways: it binds 127.0.0.1, it rejects non-local Host headers
 * (DNS rebinding), and POSTs must be application/json from a same-origin page
 * (a cross-site form or fetch cannot satisfy that, so other websites open in
 * your browser cannot drive it).
 */
export const startPortal = (port: number, host = '127.0.0.1', project?: LoadedProject): Promise<Server> =>
  new Promise((resolve, reject) => {
    let busy = false;
    let picker: PickerSession | undefined;
    const stopPicker = async () => { const p = picker; picker = undefined; await p?.close().catch(() => {}); };
    const server = createServer(async (req, res) => {
      const send = (code: number, body: unknown, type = 'application/json') => {
        res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
      };
      try {
        const hostHeader = req.headers.host ?? '';
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(hostHeader)) return send(403, { error: 'forbidden host' });
        const url = new URL(req.url ?? '/', 'http://local');

        if (req.method === 'GET') {
          if (url.pathname === '/') return send(200, await readFile(PAGE, 'utf8'), 'text/html; charset=utf-8');
          if (url.pathname === '/api/pick/last') {
            return send(200, { active: Boolean(picker), count: picker?.picks.length ?? 0, pick: picker?.last() ?? null });
          }
          if (url.pathname === '/api/project') {
            if (!project) return send(200, { project: null });
            return send(200, { project: { name: project.project.name, scenarios: await listProject(project) } });
          }
          if (project && url.pathname.startsWith('/reports/')) {
            const root = path.resolve(project.dir, project.project.reportDir ?? 'reports');
            const abs = path.resolve(root, decodeURIComponent(url.pathname.slice('/reports/'.length)));
            if (path.relative(root, abs).startsWith('..') || !TYPES[path.extname(abs)]) return send(404, { error: 'not found' });
            if (!(await stat(abs).catch(() => null))?.isFile()) return send(404, { error: 'not found' });
            return send(200, await readFile(abs), TYPES[path.extname(abs)]);
          }
          return send(404, { error: 'not found' });
        }
        if (req.method !== 'POST') return send(404, { error: 'not found' });
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'content-type must be application/json' });
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== hostHeader) return send(403, { error: 'cross-origin request refused' });

        const body = JSON.parse((await readBody(req)) || '{}') as {
          text?: string; format?: string; description?: string; heal?: boolean; confirmJs?: boolean; tags?: string[]; grep?: string; url?: string;
        };
        const ext = body.format === 'md' ? '.md' : '.json';
        if (req.url === '/api/validate') {
          const s = parseScenarioText(body.text ?? '', ext, 'scenario');
          return send(200, { ok: true, name: s.name, steps: s.steps.length, hasJs: hasJs(s.steps) });
        }
        if (req.url === '/api/run') {
          const s = parseScenarioText(body.text ?? '', ext, 'scenario');
          if (hasJs(s.steps) && body.confirmJs !== true) {
            return send(409, { ok: false, needsConfirm: true, error: 'This scenario contains JavaScript (evaluate/script/expect js). It runs with your user rights. Confirm to run.' });
          }
          if (busy) return send(409, { ok: false, error: 'a run is already in progress' });
          busy = true;
          try {
            const log: string[] = [];
            const report = await runScenario(s, {
              headless: true, heal: body.heal === true, log: (l) => log.push(l),
              ...(project ? { rootDir: project.dir, baseUrl: project.project.baseUrl, baseVars: project.project.vars ?? {} } : {}),
            });
            return send(200, { ok: report.status === 'passed', report, log });
          } finally { busy = false; }
        }
        if (req.url === '/api/project/run') {
          if (!project) return send(400, { ok: false, error: 'portal was not started with a project' });
          if (busy) return send(409, { ok: false, error: 'a run is already in progress' });
          busy = true;
          try {
            const log: string[] = [];
            const report = await runProject(project, {
              tags: body.tags ?? [], ...(body.grep ? { grep: body.grep } : {}), heal: body.heal === true, log: (l) => log.push(l),
            });
            return send(200, { ok: report.status === 'passed', counts: report.counts, status: report.status, note: report.note, log });
          } finally { busy = false; }
        }
        if (req.url === '/api/pick/start') {
          await stopPicker();
          picker = await startPicker(body.url ?? '', { headless: false });
          picker.page.on('close', () => { picker = undefined; });
          return send(200, { ok: true });
        }
        if (req.url === '/api/pick/stop') { await stopPicker(); return send(200, { ok: true }); }
        if (req.url === '/api/generate') {
          if (!body.description) return send(400, { error: 'description required' });
          return send(200, { ok: true, scenario: await generateScenario(body.description) });
        }
        return send(404, { error: 'not found' });
      } catch (e) {
        return send(400, { ok: false, error: (e as Error).message });
      }
    });
    server.on('close', () => { void stopPicker(); });
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
