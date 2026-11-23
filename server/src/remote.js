// Remote-control sessions: relays a browser viewer <-> the Windows remote helper over WebSockets.
import { acceptUpgrade, rejectUpgrade } from './ws.js';
import { randHex, safeEqualHex } from './util.js';
import { audit } from './db.js';
import { queueJobs } from './jobs.js';

const sessions = new Map();
const HOST_CONNECT_TIMEOUT = 60_000;

export function createRemoteSession(agent, user) {
  const id = randHex(16);
  const s = {
    id, agent, user, viewerToken: randHex(24), hostToken: randHex(24),
    viewer: null, host: null, createdAt: Date.now(), connectedAt: null,
  };
  sessions.set(id, s);
  queueJobs({
    agents: [agent], name: 'Remote control session', shell: '_remote',
    body: JSON.stringify({ session: id, token: s.hostToken }), timeout: 60, createdBy: user.username,
  });
  audit(user.username, 'remote.start', agent.hostname);
  s.timer = setTimeout(() => {
    if (!s.host) end(s, "The device didn't start a remote session. Check that it's online and someone (or the login screen) is on the console.");
  }, HOST_CONNECT_TIMEOUT);
  return { session: id, token: s.viewerToken };
}

function status(s, state, message = '') {
  if (s.viewer && !s.viewer.closed) s.viewer.send(JSON.stringify({ t: 'status', state, message }));
}

function end(s, message) {
  if (!sessions.has(s.id)) return;
  sessions.delete(s.id);
  clearTimeout(s.timer);
  if (message) status(s, 'ended', message);
  if (s.viewer) s.viewer.close(1000, 'ended');
  if (s.host) { if (!s.host.closed) s.host.send('bye', true); s.host.close(1000, 'ended'); }
  if (s.connectedAt) {
    audit(s.user.username, 'remote.end', `${s.agent.hostname} (${Math.round((Date.now() - s.connectedAt) / 1000)}s)`);
  }
}

/** HTTP 'upgrade' handler. getUser(req) resolves the logged-in console user from the session cookie. */
export function handleUpgrade(req, socket, getUser) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws/remote') return rejectUpgrade(socket, 404, 'Not Found');
  const s = sessions.get(url.searchParams.get('session') || '');
  const token = url.searchParams.get('token') || '';
  const role = url.searchParams.get('role');
  if (!s) return rejectUpgrade(socket, 404, 'Not Found');

  if (role === 'host') {
    if (s.host || !safeEqualHex(token, s.hostToken)) return rejectUpgrade(socket, 403, 'Forbidden');
    const ws = acceptUpgrade(req, socket);
    if (!ws) return;
    s.host = ws;
    s.connectedAt = Date.now();
    clearTimeout(s.timer);
    status(s, 'connected');
    ws.on('message', (data, isText) => {
      if (!s.viewer || s.viewer.closed) return;
      // drop video if the browser is far behind (the helper's ack window normally prevents this)
      if (!isText && s.viewer.buffered > 32 * 1024 * 1024) return;
      s.viewer.send(data, isText);
    });
    ws.on('close', () => end(s, 'The remote session ended on the device.'));
    return;
  }

  // viewer: must be the console user who created the session, from the same origin
  const user = getUser(req);
  const origin = req.headers.origin;
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
  if (!user || user.id !== s.user.id || !sameOrigin || s.viewer || !safeEqualHex(token, s.viewerToken)) {
    return rejectUpgrade(socket, 403, 'Forbidden');
  }
  const ws = acceptUpgrade(req, socket);
  if (!ws) return;
  s.viewer = ws;
  status(s, s.host ? 'connected' : 'waiting');
  ws.on('message', (data, isText) => {
    if (isText && s.host && !s.host.closed) s.host.send(data, true);
  });
  ws.on('close', () => end(s));
}
