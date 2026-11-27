// Technician <-> end-user chat. The Windows tray icon (HostPilotTray.exe, running as the signed-in user) talks to
// /api/chat/device/* with a per-device chat token that the agent publishes in HKLM\SOFTWARE\HostPilot\ChatToken.
// That token only grants access to this device's conversation.
import { all, get, run } from './db.js';
import { HttpError, randHex } from './util.js';

const MAX_LEN = 4000;
const deviceWaiters = new Map(); // agentId -> Set<fn>
const techWaiters = new Map();   // agentId -> Set<fn>   ('*' = any device, for the unread badge)

function wake(map, key) { const s = map.get(key); if (s) for (const fn of [...s]) fn(); }
function wait(map, key, ms, res) {
  return new Promise((resolve) => {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    const done = () => { clearTimeout(t); set.delete(done); if (!set.size) map.delete(key); resolve(); };
    const t = setTimeout(done, ms);
    set.add(done);
    res?.on('close', done);
  });
}

export function chatTokenFor(agentId) {
  const a = get('SELECT chat_token FROM agents WHERE id=?', agentId);
  if (a?.chat_token) return a.chat_token;
  const token = randHex(24);
  run('UPDATE agents SET chat_token=? WHERE id=?', token, agentId);
  return token;
}

const cleanBody = (b) => {
  const s = String(b ?? '').replace(/\r\n/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '').trim();
  if (!s) throw new HttpError(400, 'Message is empty');
  return s.slice(0, MAX_LEN);
};
const list = (agentId, after) => all(`SELECT id, direction, author, body, created_at, read_at FROM chat_messages WHERE agent_id=? AND id>? ORDER BY id LIMIT 200`, agentId, after);
const recent = (agentId) => all(`SELECT * FROM (SELECT id, direction, author, body, created_at, read_at FROM chat_messages WHERE agent_id=? ORDER BY id DESC LIMIT 50) ORDER BY id`, agentId);

// ---------- technician side ----------
export function techSend(agent, user, body) {
  const t = Date.now();
  const r = run('INSERT INTO chat_messages(agent_id, direction, author, body, created_at) VALUES(?,?,?,?,?)', agent.id, 'tech', user.username, cleanBody(body), t);
  wake(deviceWaiters, agent.id); wake(techWaiters, agent.id);
  return get('SELECT id, direction, author, body, created_at, read_at FROM chat_messages WHERE id=?', r.lastInsertRowid);
}

export async function techRead(agentId, after, waitSec, res) {
  let msgs = after ? list(agentId, after) : recent(agentId);
  if (!msgs.length && waitSec > 0) { await wait(techWaiters, agentId, waitSec * 1000, res); msgs = list(agentId, after); }
  run("UPDATE chat_messages SET read_at=? WHERE agent_id=? AND direction='user' AND read_at IS NULL", Date.now(), agentId);
  return msgs;
}

export function unreadSummary() {
  return all(`SELECT m.agent_id, a.hostname, COUNT(*) AS unread, MAX(m.created_at) AS last_at,
              (SELECT body FROM chat_messages x WHERE x.agent_id=m.agent_id ORDER BY id DESC LIMIT 1) AS last_body
              FROM chat_messages m JOIN agents a ON a.id=m.agent_id WHERE m.direction='user' AND m.read_at IS NULL GROUP BY m.agent_id ORDER BY last_at DESC`);
}
export function conversations() {
  return all(`SELECT m.agent_id, a.hostname, a.logged_user, MAX(m.created_at) AS last_at, COUNT(*) AS total,
              SUM(CASE WHEN m.direction='user' AND m.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
              (SELECT body FROM chat_messages x WHERE x.agent_id=m.agent_id ORDER BY id DESC LIMIT 1) AS last_body,
              (SELECT direction FROM chat_messages x WHERE x.agent_id=m.agent_id ORDER BY id DESC LIMIT 1) AS last_dir
              FROM chat_messages m JOIN agents a ON a.id=m.agent_id GROUP BY m.agent_id ORDER BY last_at DESC LIMIT 200`);
}

// ---------- device (tray icon) side ----------
export function deviceAgent(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw new HttpError(401, 'Invalid chat token');
  const a = get('SELECT id, hostname, client_id, contact_id FROM agents WHERE chat_token=?', token);
  if (!a) throw new HttpError(401, 'Invalid chat token');
  return a;
}

export async function devicePoll(token, after, waitSec, res) {
  const a = deviceAgent(token);
  let msgs = after ? list(a.id, after) : recent(a.id);
  if (!msgs.length && waitSec > 0) { await wait(deviceWaiters, a.id, waitSec * 1000, res); msgs = list(a.id, after); }
  if (res?.destroyed) return null;
  const now = Date.now();
  run("UPDATE chat_messages SET read_at=? WHERE agent_id=? AND direction='tech' AND read_at IS NULL", now, a.id);
  if (msgs.some((m) => m.direction === 'tech' && !m.read_at)) wake(techWaiters, a.id); // tell the technician it was delivered
  return { hostname: a.hostname, messages: msgs };
}

export function deviceSend(token, author, body) {
  const a = deviceAgent(token);
  const r = run('INSERT INTO chat_messages(agent_id, direction, author, body, created_at) VALUES(?,?,?,?,?)', a.id, 'user', String(author || 'User').slice(0, 100), cleanBody(body), Date.now());
  wake(techWaiters, a.id); wake(techWaiters, '*');
  return { id: Number(r.lastInsertRowid) };
}

export const waitAnyUserMessage = (ms, res) => wait(techWaiters, '*', ms, res);
