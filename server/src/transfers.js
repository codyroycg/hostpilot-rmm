// File transfers between the browser and devices, staged on the server's data volume.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from './db.js';
import { randHex, safeEqualHex, HttpError } from './util.js';

const DIR = path.join(DATA_DIR, 'transfers');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

export const MAX_TRANSFER = 4 * 1024 * 1024 * 1024; // 4 GB
const TTL = 2 * 3600 * 1000;
const transfers = new Map();

/** direction: 'to-server' (device uploads, browser downloads) or 'to-device' */
export function createTransfer({ agentId, userId, direction, name }) {
  const t = {
    id: randHex(16), token: randHex(24), agentId, userId, direction, name: name || 'download',
    file: null, size: 0, ready: false, createdAt: Date.now(),
  };
  t.file = path.join(DIR, t.id);
  transfers.set(t.id, t);
  return t;
}

export function getTransfer(id) { return transfers.get(id) || null; }

export function checkToken(id, token) {
  const t = transfers.get(id);
  if (!t || !safeEqualHex(String(token || ''), t.token)) throw new HttpError(404, 'Unknown transfer');
  return t;
}

/** Stream an incoming request body into the transfer's file. */
export async function receiveInto(t, req) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_TRANSFER) throw new HttpError(413, 'File too large (max 4 GB)');
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_TRANSFER) req.destroy(new Error('too large'));
  });
  await pipeline(req, fs.createWriteStream(t.file));
  t.size = size;
  t.ready = true;
}

export function sendFile(t, res, { attachment }) {
  if (!t.ready || !fs.existsSync(t.file)) throw new HttpError(409, 'File is not ready yet');
  const safe = t.name.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 150) || 'download';
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(t.file).size, 'Cache-Control': 'no-store' };
  if (attachment) headers['Content-Disposition'] = `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(t.name)}`;
  res.writeHead(200, headers);
  return pipeline(fs.createReadStream(t.file), res).catch(() => {});
}

export function removeTransfer(t) {
  transfers.delete(t.id);
  fs.rm(t.file, { force: true }, () => {});
}

setInterval(() => {
  for (const t of transfers.values()) if (Date.now() - t.createdAt > TTL) removeTransfer(t);
}, 10 * 60 * 1000).unref();
