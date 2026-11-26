// Screenshots of a device's console session, taken in the background (Windows), kept on the data volume.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, DATA_DIR } from './db.js';
import { HttpError, randHex, safeEqualHex } from './util.js';

const DIR = path.join(DATA_DIR, 'screenshots');
fs.mkdirSync(DIR, { recursive: true });
const MAX = 15 * 1024 * 1024;
const KEEP_PER_DEVICE = 50;

export const shotFile = (s) => path.join(DIR, `${s.id}.jpg`);

export function createShot(agentId, username) {
  const s = { id: randHex(12), token: randHex(24) };
  run("INSERT INTO screenshots(id, agent_id, created_at, created_by, token, status) VALUES(?,?,?,?,?, 'pending')", s.id, agentId, Date.now(), username, s.token);
  return s;
}

/** PUT from the device: the JPEG body. */
export async function receiveShot(id, token, req) {
  const s = get('SELECT * FROM screenshots WHERE id=?', id);
  if (!s || s.status !== 'pending' || !safeEqualHex(String(token || ''), s.token)) throw new HttpError(404, 'Unknown screenshot');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX) throw new HttpError(413, 'Screenshot too large');
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new HttpError(400, 'Not a JPEG image');
  fs.writeFileSync(shotFile(s), buf);
  run("UPDATE screenshots SET status='ready', size=?, token=NULL WHERE id=?", buf.length, s.id);
  // keep the newest KEEP_PER_DEVICE
  for (const old of all("SELECT id FROM screenshots WHERE agent_id=? AND status='ready' ORDER BY created_at DESC LIMIT -1 OFFSET ?", s.agent_id, KEEP_PER_DEVICE)) {
    fs.rmSync(shotFile(old), { force: true });
    run('DELETE FROM screenshots WHERE id=?', old.id);
  }
  return { ok: true, size: buf.length };
}

export const listShots = (agentId) => all("SELECT id, created_at, created_by, size, status FROM screenshots WHERE agent_id=? ORDER BY created_at DESC LIMIT 100", agentId);

export function deleteShot(s) {
  fs.rmSync(shotFile(s), { force: true });
  run('DELETE FROM screenshots WHERE id=?', s.id);
}

/** Requests that never got an image (device offline, locked screen…) are marked failed after 10 minutes. */
export function expireShots() {
  run("UPDATE screenshots SET status='failed', token=NULL WHERE status='pending' AND created_at < ?", Date.now() - 10 * 60000);
}
