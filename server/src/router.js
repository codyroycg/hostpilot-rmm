import { HttpError } from './util.js';

const routes = [];

export function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
}

export function match(method, pathname) {
  let methodMismatch = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    if (r.method !== method) { methodMismatch = true; continue; }
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params };
  }
  if (methodMismatch) throw new HttpError(405, 'Method not allowed');
  return null;
}

const MAX_BODY = 25 * 1024 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': buf.length });
  res.end(buf);
}

export function clientIp(req) {
  if (process.env.TRUST_PROXY !== 'false') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).toString().split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
