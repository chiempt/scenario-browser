import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { generateScenario } from './ai.ts';
import { parseScenarioText } from './load.ts';
import { runScenario } from './runner.ts';

const PAGE = fileURLToPath(new URL('../portal/index.html', import.meta.url));
const MAX_BODY = 256 * 1024;

const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/** Local-only portal. Binds 127.0.0.1 and rejects requests whose Host is not local (DNS-rebinding guard). */
export const startPortal = (port: number, host = '127.0.0.1'): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const send = (code: number, body: unknown, type = 'application/json') => {
        res.writeHead(code, { 'content-type': type });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      try {
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(403, { error: 'forbidden host' });
        if (req.method === 'GET' && req.url === '/') return send(200, await readFile(PAGE, 'utf8'), 'text/html; charset=utf-8');
        if (req.method !== 'POST') return send(404, { error: 'not found' });
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: string; format?: string; description?: string; heal?: boolean };
        const ext = body.format === 'md' ? '.md' : '.json';
        if (req.url === '/api/validate') {
          const s = parseScenarioText(body.text ?? '', ext, 'scenario');
          return send(200, { ok: true, name: s.name, steps: s.steps.length });
        }
        if (req.url === '/api/run') {
          const s = parseScenarioText(body.text ?? '', ext, 'scenario');
          const log: string[] = [];
          const report = await runScenario(s, { headless: true, heal: body.heal === true, log: (l) => log.push(l) });
          return send(200, { ok: report.status === 'passed', report, log });
        }
        if (req.url === '/api/generate') {
          if (!body.description) return send(400, { error: 'description required' });
          return send(200, { ok: true, scenario: await generateScenario(body.description) });
        }
        return send(404, { error: 'not found' });
      } catch (e) {
        return send(400, { ok: false, error: (e as Error).message });
      }
    });
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
