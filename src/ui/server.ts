import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { UI_HTML } from './page.js';
import { APP_JS } from './app-js.js';
import { PIXEL_BLAST_JS } from './pixel-blast.js';
import { FramerExporter, deriveOutputName } from '../exporter/index.js';
import { collectSummary } from '../exporter/summary.js';
import {
  platformsByCategory,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  isBetaPlatform,
} from '../platforms/index.js';
import type { PlatformType } from '../platforms/types.js';
import { onLog, getLogHistory, clearLogHistory } from '../logger/index.js';
import { onProgress, getProgress } from '../exporter/progress.js';
import { ui } from '../cli/theme.js';

interface ExportRequest {
  url: string;
  platform?: string | null;
  outDir?: string;
  subpages?: boolean;
  prettyPrint?: boolean;
  concurrency?: number;
}

interface RunState {
  state: 'idle' | 'running' | 'done' | 'error';
  outDir?: string;
  serveCommand?: string;
  error?: string;
  summary?: Awaited<ReturnType<typeof collectSummary>>;
}

const clients = new Set<http.ServerResponse>();
let run: RunState = { state: 'idle' };

function isAllowedHost(req: http.IncomingMessage): boolean {
  const host = (req.headers.host || '').toLowerCase();
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

// True same-origin check: the request's Origin (sent by the browser, not
// spoofable by page JS) must match the Host header the request came in on.
// This works regardless of which hostname/IP the server is reached at.
function isSameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = (req.headers.host || '').toLowerCase();
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function resolveOutDir(requested: string | undefined, fallbackName: string): string | null {
  const cwd = process.cwd();
  const target = path.resolve(cwd, requested || './' + fallbackName);
  if (target !== cwd && !target.startsWith(cwd + path.sep)) return null;
  return target;
}

function quoteForShell(name: string): string {
  return '"' + name.replace(/["`$\\\r\n]/g, '') + '"';
}

function sse(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function platformsPayload(): unknown {
  const grouped = platformsByCategory();
  return {
    categories: CATEGORY_ORDER.map((cat) => ({
      id: cat,
      label: CATEGORY_LABELS[cat],
      platforms: grouped[cat].map((h) => ({
        name: h.name,
        displayName: h.displayName,
        beta: isBetaPlatform(h.name),
      })),
    })),
  };
}

async function startExport(body: ExportRequest, outDir: string): Promise<void> {
  run = { state: 'running' };
  clearLogHistory();
  sse('status', run);

  const { CFG } = await import('../config/index.js');
  CFG.concurrency = body.concurrency || 12;

  const exporter = new FramerExporter(
    body.url,
    outDir,
    (body.platform as PlatformType) || undefined
  );
  exporter.prettyPrint = body.prettyPrint !== false;
  exporter.interactive = false;

  try {
    await exporter.run(body.subpages === true);
    run = {
      state: 'done',
      outDir,
      serveCommand: `cd ${quoteForShell(path.basename(outDir))} && node serve.js`,
      summary: await collectSummary(outDir),
    };
  } catch (e) {
    run = { state: 'error', error: (e as Error).message };
  }
  sse('status', run);
}

export interface UiServerHandle {
  port: number;
  close: () => Promise<void>;
}

export function startUiServer(port: number, host: string = '127.0.0.1'): Promise<UiServerHandle> {
  const unsubscribeLog = onLog((record) => sse('log', record));
  const unsubscribeProgress = onProgress((progress) => sse('progress', progress));

  // The Host-header allowlist only makes sense when the socket itself is
  // loopback-only: it's what stops a malicious page (via DNS rebinding)
  // from reaching a server that's otherwise unreachable from the network.
  // Once the caller explicitly binds elsewhere (e.g. --host 0.0.0.0 to
  // publish this through Docker/a cloud box), the server is reachable from
  // the network by design, under whatever hostname/IP the caller reaches
  // it at, so that allowlist can no longer be a fixed localhost pattern.
  // isSameOrigin still applies in both modes as CSRF defense-in-depth.
  const restrictToLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const route = parsed.pathname;

    if ((restrictToLoopback && !isAllowedHost(req)) || !isSameOrigin(req)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }

    if (route === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UI_HTML);
      return;
    }
    if (route === '/app.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(APP_JS);
      return;
    }
    if (route === '/pixel-blast.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(PIXEL_BLAST_JS);
      return;
    }
    if (route === '/api/platforms' && req.method === 'GET') {
      json(res, 200, platformsPayload());
      return;
    }
    if (route === '/api/derive' && req.method === 'GET') {
      const url = parsed.searchParams.get('url') || '';
      const platform = (parsed.searchParams.get('platform') as PlatformType) || null;
      try {
        const { detectPlatform } = await import('../platforms/index.js');
        const name = deriveOutputName(url, platform || detectPlatform(url).name);
        json(res, 200, { name });
      } catch {
        json(res, 400, { error: 'invalid url' });
      }
      return;
    }
    if (route === '/api/status' && req.method === 'GET') {
      json(res, 200, { run, progress: getProgress() });
      return;
    }
    if (route === '/api/log' && req.method === 'GET') {
      const text = getLogHistory()
        .map((r) => `[${r.time}] [${r.level}] ${r.message}`)
        .join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text + '\n');
      return;
    }
    if (route === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: status\ndata: ${JSON.stringify(run)}\n\n`);
      res.write(`event: progress\ndata: ${JSON.stringify(getProgress())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (route === '/api/export' && req.method === 'POST') {
      if (run.state === 'running') {
        json(res, 409, { error: 'an export is already running' });
        return;
      }
      let body: ExportRequest;
      try {
        body = JSON.parse(await readBody(req)) as ExportRequest;
        new URL(body.url);
      } catch {
        json(res, 400, { error: 'invalid request body' });
        return;
      }
      const outDir = resolveOutDir(body.outDir, deriveOutputName(body.url, 'framer'));
      if (!outDir) {
        json(res, 400, { error: 'output directory must stay inside the working directory' });
        return;
      }
      json(res, 202, { started: true });
      void startExport(body, outDir);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  server.on('close', () => {
    unsubscribeLog();
    unsubscribeProgress();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      console.log('');
      console.log(`  ${ui.text.bold('Framer Export UI')}`);
      console.log(`  ${ui.muted('Local')}   ${ui.primary(`http://localhost:${actualPort}`)}`);
      if (!restrictToLoopback) {
        console.log(`  ${ui.muted('Bound')}   ${ui.primary(`${host}:${actualPort}`)} ${ui.muted('(reachable from the network)')}`);
        console.log(
          `  ${ui.warning('⚠')}  ${ui.warning('No login/auth — anyone who can reach this address can trigger exports. Only expose it on a trusted or firewalled network.')}`
        );
      }
      console.log(`  ${ui.muted('Stop')}    ${ui.primary('ctrl+c')}`);
      console.log('');
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((done) => {
            for (const client of clients) client.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
