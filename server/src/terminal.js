// Linux terminal sessions: browser (WebSocket) <-> device (HTTP: long-lived GET for input, POSTs for output).
import { acceptUpgrade, rejectUpgrade } from './ws.js';
import { randHex, safeEqualHex, HttpError } from './util.js';
import { audit } from './db.js';
import { queueJobs } from './jobs.js';
import { buildTask } from './task-catalog.js';

const sessions = new Map();
const HOST_CONNECT_TIMEOUT = 60_000;

export function createTerminalSession(agent, user) {
  const id = randHex(16);
  const s = {
    id, agent, user, viewerToken: randHex(24), hostToken: randHex(24),
    viewer: null, input: null, pending: [], connectedAt: null, ended: false,
  };
  sessions.set(id, s);
  const q = `token=${s.hostToken}`;
  const r = queueJobs({
    agents: [agent], name: 'Terminal session', task: 'terminal.open', createdBy: user.username, timeout: 12 * 3600,
    build: (a) => buildTask('terminal.open', a.platform, {
      in: `/api/term/${id}/in?${q}`, out: `/api/term/${id}/out?${q}`, close: `/api/term/${id}/close?${q}`,
    }, { allowInternal: true }),
  });
  if (!r.created) { sessions.delete(id); throw new HttpError(400, 'Terminal sessions are available for Linux devices'); }
  audit(user.username, 'terminal.start', agent.hostname);
  s.timer = setTimeout(() => {
    if (!s.input) end(s, "The device didn't start the terminal. Check that it's online and has the 'script' command (util-linux).");
  }, HOST_CONNECT_TIMEOUT);
  return { session: id, token: s.viewerToken };
}

function status(s, state, message = '') {
  if (s.viewer && !s.viewer.closed) s.viewer.send(JSON.stringify({ t: 'status', state, message }));
}

function toHost(s, line) {
  if (s.input && !s.input.writableEnded) s.input.write(line + '\n');
  else if (s.pending.length < 500) s.pending.push(line);
}

function end(s, message) {
  if (s.ended) return;
  s.ended = true;
  sessions.delete(s.id);
  clearTimeout(s.timer);
  clearInterval(s.keepalive);
  if (message) status(s, 'ended', message);
  if (s.viewer) s.viewer.close(1000, 'ended');
  if (s.input && !s.input.writableEnded) { s.input.write('X\n'); s.input.end(); }
  if (s.connectedAt) audit(s.user.username, 'terminal.end', `${s.agent.hostname} (${Math.round((Date.now() - s.connectedAt) / 1000)}s)`);
}

function hostSession(params, query) {
  const s = sessions.get(params.id);
  if (!s || !safeEqualHex(String(query.get('token') || ''), s.hostToken)) throw new HttpError(404, 'Unknown session');
  return s;
}

/** GET /api/term/:id/in — long-lived response carrying keystrokes to the device */
export function hostInput(ctx) {
  const s = hostSession(ctx.params, ctx.query);
  if (s.input) throw new HttpError(409, 'Already connected');
  const res = ctx.res;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  s.input = res;
  s.connectedAt = Date.now();
  clearTimeout(s.timer);
  for (const line of s.pending.splice(0)) res.write(line + '\n');
  s.keepalive = setInterval(() => { if (!res.writableEnded) res.write('P\n'); }, 15000);
  status(s, 'connected');
  return new Promise((resolve) => res.on('close', () => { end(s, 'The terminal session ended on the device.'); resolve(); }));
}

/** POST /api/term/:id/out — a batch of terminal output from the device */
export async function hostOutput(ctx) {
  const s = hostSession(ctx.params, ctx.query);
  const chunks = [];
  let size = 0;
  for await (const c of ctx.req) { size += c.length; if (size > 4 * 1024 * 1024) break; chunks.push(c); }
  if (s.viewer && !s.viewer.closed && s.viewer.buffered < 8 * 1024 * 1024) s.viewer.send(Buffer.concat(chunks), false);
  return { ok: true };
}

/** POST /api/term/:id/close */
export function hostClose(ctx) {
  const s = sessions.get(ctx.params.id);
  if (s && safeEqualHex(String(ctx.query.get('token') || ''), s.hostToken)) end(s, 'The shell exited.');
  return { ok: true };
}

/** WebSocket upgrade for the browser side: /ws/terminal */
export function handleTerminalUpgrade(req, socket, getUser) {
  const url = new URL(req.url, 'http://localhost');
  const s = sessions.get(url.searchParams.get('session') || '');
  if (!s) return rejectUpgrade(socket, 404, 'Not Found');
  const user = getUser(req);
  let sameOrigin = false;
  try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* no/invalid origin */ }
  if (!user || user.id !== s.user.id || !sameOrigin || s.viewer || !safeEqualHex(url.searchParams.get('token') || '', s.viewerToken)) {
    return rejectUpgrade(socket, 403, 'Forbidden');
  }
  const ws = acceptUpgrade(req, socket);
  if (!ws) return;
  s.viewer = ws;
  status(s, s.input ? 'connected' : 'waiting');
  ws.on('message', (data, isText) => {
    if (!isText) return;
    const m = /^(d) ([A-Za-z0-9+/=]{1,200000})$|^(r) (\d{1,4}) (\d{1,4})$/.exec(data);
    if (!m) return;
    if (m[1]) toHost(s, `D ${m[2]}`);
    else toHost(s, `R ${m[4]} ${m[5]}`);
  });
  ws.on('close', () => end(s));
}
