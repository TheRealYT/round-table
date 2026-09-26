import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Hub } from './hub.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * HTTP for the human app (ADR-0011): static files, `/login`, and nothing else; every operation
 * goes over the /app WebSocket. Only answers requests addressed to 127.0.0.1 or localhost.
 */
export function createHttpServer(hub: Hub, options: { appDir?: string } = {}): Server {
  const appDir = options.appDir && existsSync(join(options.appDir, 'index.html')) ? resolve(options.appDir) : undefined;
  return createServer((req, res) => {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'Round Table only answers on 127.0.0.1');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'GET only');
    if (url.pathname === '/login') return login(hub, url, res);
    if (url.pathname === '/healthz') return send(res, 200, 'application/json', JSON.stringify({ ok: true, hubId: hub.hubId }));
    if (!appDir) {
      return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><title>Round Table</title><p>The hub is running, but the app is not built. Run <code>pnpm --filter @round-table/app build</code> and restart the hub.</p>');
    }
    serveStatic(appDir, url.pathname, req, res);
  });
}

function login(hub: Hub, url: URL, res: ServerResponse): void {
  const session = hub.redeemLoginToken(url.searchParams.get('t') ?? '');
  if (!session) return send(res, 403, 'text/plain', 'This login link has expired or was already used. Restart `rt hub start` to get a new one.');
  res.writeHead(302, {
    'Set-Cookie': `rt_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/`,
    Location: '/',
  });
  res.end();
}

function serveStatic(root: string, pathname: string, _req: IncomingMessage, res: ServerResponse): void {
  const candidate = normalize(join(root, decodeURIComponent(pathname)));
  const file = candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html');
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'max-age=3600' });
  res.end(readFileSync(file));
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
