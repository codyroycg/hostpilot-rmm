import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { match, readBody, sendJson } from './router.js';
import { HttpError } from './util.js';
import './db.js';
import './agent-routes.js';
import { sessionUser, ensureAdmin } from './api-routes.js';
import { startBackgroundTasks } from './tasks.js';
import { handleUpgrade } from './remote.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8080);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
const csp = (host) => `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; `
  + `connect-src 'self' ws://${host} wss://${host}; frame-ancestors 'none'`;

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=300',
  });
  res.end(data);
  return true;
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.setHeader('Content-Security-Policy', csp(String(req.headers.host || '').replace(/[^\w.:[\]-]/g, '')));
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    const m = match(req.method, pathname);
    if (!m) {
      if (req.method === 'GET' && !pathname.startsWith('/api/') && serveStatic(req, res, pathname)) return;
      throw new HttpError(404, 'Not found');
    }
    const ctx = {
      req, res, params: m.params, query: url.searchParams,
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {},
      user: pathname.startsWith('/api/') && !pathname.startsWith('/api/agent/') ? sessionUser(req) : null,
    };
    // Basic CSRF defence for cookie-authenticated mutations: require same-origin JSON requests.
    if (ctx.user && req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
      throw new HttpError(415, 'Expected application/json');
    }
    const result = await m.handler(ctx);
    if (res.headersSent || res.destroyed) return;
    sendJson(res, 200, result ?? { ok: true });
  } catch (e) {
    if (res.headersSent || res.destroyed) return;
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(`[${req.method} ${pathname}]`, e);
    sendJson(res, status, { error: status === 500 ? 'Internal server error' : e.message });
  }
});

server.on('upgrade', (req, socket) => {
  socket.on('error', () => {});
  try { handleUpgrade(req, socket, sessionUser); }
  catch (e) { console.error('[upgrade]', e); socket.destroy(); }
});

server.keepAliveTimeout = 65_000;
server.requestTimeout = 120_000;

ensureAdmin();
startBackgroundTasks();
server.listen(PORT, () => console.log(`HostPilot RMM listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('shutting down'); server.close(); process.exit(0); });
}
