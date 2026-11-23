import { route, clientIp, publicUrl } from './router.js';
import { all, get, run, tx, getSettings, saveSettings, audit, SETTING_DEFAULTS } from './db.js';
import { HttpError, randHex, sha256, hashPassword, verifyPassword, SHELLS, clampInt } from './util.js';
import { queueJobs, isPolling, waitForJob } from './jobs.js';
import { AGENT_VERSIONS } from './agent-routes.js';
import { createRemoteSession } from './remote.js';
import { createTerminalSession } from './terminal.js';
import { getTask, buildTask, baseName } from './task-catalog.js';
import { createTransfer, getTransfer, receiveInto, sendFile, removeTransfer } from './transfers.js';

const SESSION_COOKIE = 'hp_session';
const SESSION_TTL = 12 * 3600 * 1000;
const ROLE_RANK = { viewer: 1, tech: 2, admin: 3 };
const ONLINE_WINDOW = 3 * 60 * 1000;

// ---------- auth helpers ----------

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionUser(req) {
  const tok = parseCookies(req)[SESSION_COOKIE];
  if (!tok) return null;
  const s = get(`SELECT u.id, u.username, u.role, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
                 WHERE s.token_hash=?`, sha256(tok));
  if (!s || s.expires_at < Date.now()) return null;
  // sliding expiry
  if (s.expires_at - Date.now() < SESSION_TTL / 2) run('UPDATE sessions SET expires_at=? WHERE token_hash=?', Date.now() + SESSION_TTL, sha256(tok));
  return { id: s.id, username: s.username, role: s.role };
}

function need(ctx, role = 'viewer') {
  const u = ctx.user;
  if (!u) throw new HttpError(401, 'Not signed in');
  if (ROLE_RANK[u.role] < ROLE_RANK[role]) throw new HttpError(403, `Requires ${role} role`);
  return u;
}

const loginFailures = new Map(); // ip -> {count, until}

function isSecure(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
}

route('POST', '/api/login', (ctx) => {
  const ip = clientIp(ctx.req);
  const f = loginFailures.get(ip);
  if (f && f.count >= 8 && f.until > Date.now()) throw new HttpError(429, 'Too many failed logins. Try again in 15 minutes.');
  const { username, password } = ctx.body;
  const u = get('SELECT * FROM users WHERE username=?', String(username || ''));
  if (!u || !verifyPassword(password || '', u.password_hash)) {
    const cur = f && f.until > Date.now() ? f : { count: 0 };
    loginFailures.set(ip, { count: cur.count + 1, until: Date.now() + 15 * 60000 });
    audit(String(username || '?'), 'login.failed', ip);
    throw new HttpError(401, 'Invalid username or password');
  }
  loginFailures.delete(ip);
  const tok = randHex(32);
  run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)', sha256(tok), u.id, Date.now() + SESSION_TTL);
  run('UPDATE users SET last_login=? WHERE id=?', Date.now(), u.id);
  audit(u.username, 'login', ip);
  ctx.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict${isSecure(ctx.req) ? '; Secure' : ''}; Max-Age=${SESSION_TTL / 1000}`);
  return { id: u.id, username: u.username, role: u.role };
});

route('POST', '/api/logout', (ctx) => {
  const tok = parseCookies(ctx.req)[SESSION_COOKIE];
  if (tok) run('DELETE FROM sessions WHERE token_hash=?', sha256(tok));
  ctx.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return { ok: true };
});

route('GET', '/api/me', (ctx) => need(ctx));

route('POST', '/api/me/password', (ctx) => {
  const u = need(ctx);
  const { current, password } = ctx.body;
  const row = get('SELECT password_hash FROM users WHERE id=?', u.id);
  if (!verifyPassword(current || '', row.password_hash)) throw new HttpError(400, 'Current password is wrong');
  if (!password || password.length < 10) throw new HttpError(400, 'New password must be at least 10 characters');
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), u.id);
  audit(u.username, 'password.change');
  return { ok: true };
});

// ---------- agent presentation ----------

function presentAgent(a) {
  const disks = a.disks ? JSON.parse(a.disks) : [];
  const diskMax = disks.reduce((m, d) => (d.total > 0 ? Math.max(m, ((d.total - d.free) / d.total) * 100) : m), 0);
  const { secret_hash, ...rest } = a;
  return {
    ...rest,
    ip_addrs: a.ip_addrs ? JSON.parse(a.ip_addrs) : [],
    disks,
    disk_pct: disks.length ? Math.round(diskMax * 10) / 10 : null,
    online: isPolling(a.id) || (a.last_seen && Date.now() - a.last_seen < ONLINE_WINDOW),
    maintenance: !!a.maintenance,
    update_pending: a.agent_version && AGENT_VERSIONS[a.platform] && a.agent_version !== AGENT_VERSIONS[a.platform],
  };
}

const AGENT_SELECT = `SELECT a.*, c.name AS client_name,
  (SELECT COUNT(*) FROM alerts al WHERE al.agent_id=a.id AND al.status IN ('open','ack')) AS open_alerts
  FROM agents a LEFT JOIN clients c ON c.id=a.client_id`;

function loadAgent(id) {
  const a = get(`${AGENT_SELECT} WHERE a.id=?`, id);
  if (!a) throw new HttpError(404, 'Device not found');
  return a;
}

// ---------- dashboard ----------

route('GET', '/api/dashboard', (ctx) => {
  need(ctx);
  const agents = all(AGENT_SELECT).map(presentAgent);
  const since = Date.now() - 86400000;
  const jobStats = all('SELECT status, COUNT(*) AS n FROM jobs WHERE created_at>? GROUP BY status', since);
  return {
    totals: {
      devices: agents.length,
      online: agents.filter((a) => a.online).length,
      offline: agents.filter((a) => !a.online).length,
      windows: agents.filter((a) => a.platform === 'windows').length,
      linux: agents.filter((a) => a.platform === 'linux').length,
      clients: get('SELECT COUNT(*) AS n FROM clients').n,
      open_alerts: get("SELECT COUNT(*) AS n FROM alerts WHERE status IN ('open','ack')").n,
    },
    jobs_24h: Object.fromEntries(jobStats.map((r) => [r.status, r.n])),
    top_cpu: agents.filter((a) => a.online && a.cpu_pct != null).sort((x, y) => y.cpu_pct - x.cpu_pct).slice(0, 5),
    top_disk: agents.filter((a) => a.disk_pct != null).sort((x, y) => y.disk_pct - x.disk_pct).slice(0, 5),
    recent_alerts: all(`SELECT al.*, a.hostname FROM alerts al JOIN agents a ON a.id=al.agent_id
                        WHERE al.status IN ('open','ack') ORDER BY al.updated_at DESC LIMIT 8`),
    recent_jobs: all(`SELECT j.id, j.batch_id, j.name, j.status, j.created_at, j.created_by, a.hostname, j.agent_id
                      FROM jobs j JOIN agents a ON a.id=j.agent_id ORDER BY j.created_at DESC LIMIT 8`),
  };
});

// ---------- clients & enrollment ----------

route('GET', '/api/clients', (ctx) => {
  need(ctx);
  const rows = all(`SELECT c.*, (SELECT COUNT(*) FROM agents a WHERE a.client_id=c.id) AS device_count
                    FROM clients c ORDER BY c.name COLLATE NOCASE`);
  const online = all('SELECT client_id, last_seen, id FROM agents');
  for (const c of rows) {
    c.online_count = online.filter((a) => a.client_id === c.id && (isPolling(a.id) || Date.now() - a.last_seen < ONLINE_WINDOW)).length;
  }
  return rows;
});

route('POST', '/api/clients', (ctx) => {
  const u = need(ctx, 'tech');
  const name = String(ctx.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Name is required');
  if (get('SELECT id FROM clients WHERE name=?', name)) throw new HttpError(409, 'A client with that name exists');
  const r = run('INSERT INTO clients(name, notes, created_at) VALUES(?,?,?)', name, String(ctx.body.notes || ''), Date.now());
  audit(u.username, 'client.create', name);
  return get('SELECT * FROM clients WHERE id=?', r.lastInsertRowid);
});

route('GET', '/api/clients/:id', (ctx) => {
  need(ctx);
  const c = get('SELECT * FROM clients WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Client not found');
  c.devices = all(`${AGENT_SELECT} WHERE a.client_id=? ORDER BY a.hostname COLLATE NOCASE`, c.id).map(presentAgent);
  c.tokens = ROLE_RANK[ctx.user.role] >= ROLE_RANK.tech
    ? all('SELECT * FROM enroll_tokens WHERE client_id=? ORDER BY created_at DESC', c.id) : [];
  c.server_url = publicUrl(ctx.req);
  return c;
});

route('PUT', '/api/clients/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const c = get('SELECT * FROM clients WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Client not found');
  const name = String(ctx.body.name ?? c.name).trim();
  if (!name) throw new HttpError(400, 'Name is required');
  run('UPDATE clients SET name=?, notes=? WHERE id=?', name, String(ctx.body.notes ?? c.notes), c.id);
  audit(u.username, 'client.update', name);
  return { ok: true };
});

route('DELETE', '/api/clients/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const c = get('SELECT * FROM clients WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Client not found');
  run('DELETE FROM clients WHERE id=?', c.id);
  audit(u.username, 'client.delete', c.name);
  return { ok: true };
});

route('POST', '/api/clients/:id/tokens', (ctx) => {
  const u = need(ctx, 'tech');
  const c = get('SELECT * FROM clients WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Client not found');
  const days = clampInt(ctx.body.expires_days, 0, 3650, 30);
  const token = randHex(20);
  run('INSERT INTO enroll_tokens(token, client_id, label, created_at, expires_at) VALUES(?,?,?,?,?)',
    token, c.id, String(ctx.body.label || '').slice(0, 100), Date.now(), days ? Date.now() + days * 86400000 : null);
  audit(u.username, 'token.create', `${c.name} (${days ? days + 'd' : 'no expiry'})`);
  return get('SELECT * FROM enroll_tokens WHERE token=?', token);
});

route('DELETE', '/api/tokens/:token', (ctx) => {
  const u = need(ctx, 'tech');
  run('DELETE FROM enroll_tokens WHERE token=?', ctx.params.token);
  audit(u.username, 'token.revoke', ctx.params.token.slice(0, 8) + '…');
  return { ok: true };
});

// ---------- devices ----------

route('GET', '/api/agents', (ctx) => {
  need(ctx);
  return all(`${AGENT_SELECT} ORDER BY a.hostname COLLATE NOCASE`).map(presentAgent);
});

route('GET', '/api/agents/:id', (ctx) => {
  need(ctx);
  return { ...presentAgent(loadAgent(ctx.params.id)), latest_version: null };
});

route('PUT', '/api/agents/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  const b = ctx.body;
  const clientId = b.client_id === undefined ? a.client_id : (b.client_id ? Number(b.client_id) : null);
  if (clientId && !get('SELECT id FROM clients WHERE id=?', clientId)) throw new HttpError(400, 'Unknown client');
  run('UPDATE agents SET client_id=?, notes=?, maintenance=? WHERE id=?', clientId,
    b.notes === undefined ? a.notes : String(b.notes), b.maintenance === undefined ? a.maintenance : (b.maintenance ? 1 : 0), a.id);
  if (b.maintenance) run("UPDATE alerts SET status='resolved', resolved_at=? WHERE agent_id=? AND status IN ('open','ack')", Date.now(), a.id);
  audit(u.username, 'device.update', a.hostname);
  return { ok: true };
});

route('DELETE', '/api/agents/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const a = loadAgent(ctx.params.id);
  if (ctx.query.get('uninstall') === '1') {
    queueJobs({ agents: [a], name: 'Uninstall agent', shell: '_uninstall', body: '', timeout: 60, createdBy: u.username });
    audit(u.username, 'device.uninstall', a.hostname);
    return { ok: true, queued: true };
  }
  run('DELETE FROM agents WHERE id=?', a.id);
  audit(u.username, 'device.delete', a.hostname);
  return { ok: true };
});

route('POST', '/api/agents/:id/remote', (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  if (a.platform !== 'windows') throw new HttpError(400, 'Remote control is available for Windows devices');
  return createRemoteSession({ id: a.id, hostname: a.hostname, platform: a.platform }, u);
});

route('POST', '/api/agents/:id/inventory', (ctx) => {
  need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  run('UPDATE agents SET want_inventory=1 WHERE id=?', a.id);
  return { ok: true };
});

route('GET', '/api/agents/:id/metrics', (ctx) => {
  need(ctx);
  const hours = clampInt(ctx.query.get('hours'), 1, 24 * 30, 24);
  const since = Date.now() - hours * 3600000;
  const rows = all('SELECT ts, cpu, mem, disk FROM metrics WHERE agent_id=? AND ts>? ORDER BY ts', ctx.params.id, since);
  // downsample to <= 300 points
  const step = Math.ceil(rows.length / 300) || 1;
  if (step === 1) return rows;
  const out = [];
  for (let i = 0; i < rows.length; i += step) {
    const chunk = rows.slice(i, i + step);
    const avg = (k) => { const v = chunk.map((r) => r[k]).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    out.push({ ts: chunk[chunk.length - 1].ts, cpu: avg('cpu'), mem: avg('mem'), disk: avg('disk') });
  }
  return out;
});

route('GET', '/api/agents/:id/software', (ctx) => {
  need(ctx);
  return all('SELECT name, version, publisher FROM software WHERE agent_id=? ORDER BY name COLLATE NOCASE', ctx.params.id);
});

route('GET', '/api/agents/:id/jobs', (ctx) => {
  need(ctx);
  return all(`SELECT id, batch_id, name, shell, status, exit_code, created_by, created_at, sent_at, finished_at
              FROM jobs WHERE agent_id=? ORDER BY created_at DESC LIMIT 100`, ctx.params.id);
});

route('GET', '/api/agents/:id/alerts', (ctx) => {
  need(ctx);
  return all('SELECT * FROM alerts WHERE agent_id=? ORDER BY created_at DESC LIMIT 100', ctx.params.id);
});

route('GET', '/api/software', (ctx) => {
  need(ctx);
  const q = `%${String(ctx.query.get('q') || '').trim()}%`;
  return all(`SELECT s.name, s.version, s.publisher, a.id AS agent_id, a.hostname, c.name AS client_name
              FROM software s JOIN agents a ON a.id=s.agent_id LEFT JOIN clients c ON c.id=a.client_id
              WHERE s.name LIKE ? ORDER BY s.name COLLATE NOCASE, a.hostname LIMIT 1000`, q);
});

// ---------- jobs ----------

route('POST', '/api/jobs', (ctx) => {
  const u = need(ctx, 'tech');
  const b = ctx.body;
  const ids = Array.isArray(b.agent_ids) ? b.agent_ids.map(String) : [];
  if (!ids.length) throw new HttpError(400, 'Select at least one device');
  const agents = ids.map((id) => get('SELECT id, hostname, platform FROM agents WHERE id=?', id)).filter(Boolean);
  let name, shell, body, timeout, scriptId = null;
  if (b.script_id) {
    const s = get('SELECT * FROM scripts WHERE id=?', Number(b.script_id));
    if (!s) throw new HttpError(404, 'Script not found');
    ({ name, shell, body, timeout } = s);
    scriptId = s.id;
    if (b.timeout) timeout = clampInt(b.timeout, 5, 86400, timeout);
  } else {
    shell = String(b.shell || '');
    body = String(b.body || '');
    if (!SHELLS[shell]) throw new HttpError(400, 'Unknown shell');
    if (!body.trim()) throw new HttpError(400, 'Command is empty');
    name = String(b.name || body.split('\n')[0]).slice(0, 120);
    timeout = clampInt(b.timeout, 5, 86400, 300);
  }
  const r = queueJobs({ agents, name, shell, body, timeout, scriptId, createdBy: u.username });
  audit(u.username, 'job.run', `${name} on ${r.created} device(s)`);
  return r;
});

route('GET', '/api/jobs', (ctx) => {
  need(ctx);
  const batch = ctx.query.get('batch');
  const limit = clampInt(ctx.query.get('limit'), 1, 1000, 200);
  const where = batch ? 'WHERE j.batch_id=?' : '';
  const params = batch ? [batch, limit] : [limit];
  return all(`SELECT j.id, j.batch_id, j.agent_id, j.name, j.shell, j.status, j.exit_code, j.created_by, j.created_at,
              j.sent_at, j.finished_at, a.hostname FROM jobs j JOIN agents a ON a.id=j.agent_id ${where}
              ORDER BY j.created_at DESC LIMIT ?`, ...params);
});

route('GET', '/api/jobs/:id', (ctx) => {
  need(ctx);
  const j = get('SELECT j.*, a.hostname FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE j.id=?', ctx.params.id);
  if (!j) throw new HttpError(404, 'Job not found');
  if (j.display_body != null) j.body = j.display_body; // never show injected secrets
  delete j.display_body;
  return j;
});

route('POST', '/api/jobs/:id/cancel', (ctx) => {
  const u = need(ctx, 'tech');
  const r = run("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status='queued'", Date.now(), ctx.params.id);
  if (!r.changes) throw new HttpError(409, 'Only queued jobs can be cancelled');
  audit(u.username, 'job.cancel', ctx.params.id);
  return { ok: true };
});

// ---------- scripts ----------

function validateScript(b) {
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'Name is required');
  if (!SHELLS[b.shell]) throw new HttpError(400, 'Unknown shell');
  if (!String(b.body || '').trim()) throw new HttpError(400, 'Script body is empty');
  return {
    name, shell: b.shell, body: String(b.body), description: String(b.description || ''),
    category: String(b.category || 'General').trim() || 'General', timeout: clampInt(b.timeout, 5, 86400, 300),
  };
}

route('GET', '/api/scripts', (ctx) => {
  need(ctx);
  return all('SELECT * FROM scripts ORDER BY category COLLATE NOCASE, name COLLATE NOCASE');
});

route('GET', '/api/scripts/:id', (ctx) => {
  need(ctx);
  const s = get('SELECT * FROM scripts WHERE id=?', Number(ctx.params.id));
  if (!s) throw new HttpError(404, 'Script not found');
  return s;
});

route('POST', '/api/scripts', (ctx) => {
  const u = need(ctx, 'tech');
  const s = validateScript(ctx.body);
  const r = run('INSERT INTO scripts(name, description, category, shell, body, timeout, created_by, updated_at) VALUES(?,?,?,?,?,?,?,?)',
    s.name, s.description, s.category, s.shell, s.body, s.timeout, u.username, Date.now());
  audit(u.username, 'script.create', s.name);
  return get('SELECT * FROM scripts WHERE id=?', r.lastInsertRowid);
});

route('PUT', '/api/scripts/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const s = validateScript(ctx.body);
  const r = run('UPDATE scripts SET name=?, description=?, category=?, shell=?, body=?, timeout=?, updated_at=? WHERE id=?',
    s.name, s.description, s.category, s.shell, s.body, s.timeout, Date.now(), Number(ctx.params.id));
  if (!r.changes) throw new HttpError(404, 'Script not found');
  audit(u.username, 'script.update', s.name);
  return get('SELECT * FROM scripts WHERE id=?', Number(ctx.params.id));
});

route('DELETE', '/api/scripts/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const s = get('SELECT name FROM scripts WHERE id=?', Number(ctx.params.id));
  if (!s) throw new HttpError(404, 'Script not found');
  run('DELETE FROM scripts WHERE id=?', Number(ctx.params.id));
  audit(u.username, 'script.delete', s.name);
  return { ok: true };
});

// ---------- schedules (automation) ----------

function validateSchedule(b) {
  const script = get('SELECT id FROM scripts WHERE id=?', Number(b.script_id));
  if (!script) throw new HttpError(400, 'Pick a script');
  if (!['all', 'client', 'agent', 'platform'].includes(b.target_type)) throw new HttpError(400, 'Bad target');
  if (b.target_type !== 'all' && !b.target_id) throw new HttpError(400, 'Pick a target');
  return {
    name: String(b.name || '').trim() || 'Scheduled task', script_id: script.id, target_type: b.target_type,
    target_id: b.target_type === 'all' ? null : String(b.target_id),
    interval_minutes: clampInt(b.interval_minutes, 5, 525600, 1440), enabled: b.enabled === false ? 0 : 1,
  };
}

route('GET', '/api/schedules', (ctx) => {
  need(ctx);
  return all(`SELECT s.*, sc.name AS script_name, sc.shell FROM schedules s JOIN scripts sc ON sc.id=s.script_id ORDER BY s.name`);
});

route('POST', '/api/schedules', (ctx) => {
  const u = need(ctx, 'tech');
  const s = validateSchedule(ctx.body);
  run(`INSERT INTO schedules(name, script_id, target_type, target_id, interval_minutes, enabled, created_by)
       VALUES(?,?,?,?,?,?,?)`, s.name, s.script_id, s.target_type, s.target_id, s.interval_minutes, s.enabled, u.username);
  audit(u.username, 'schedule.create', s.name);
  return { ok: true };
});

route('PUT', '/api/schedules/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const s = validateSchedule(ctx.body);
  run('UPDATE schedules SET name=?, script_id=?, target_type=?, target_id=?, interval_minutes=?, enabled=? WHERE id=?',
    s.name, s.script_id, s.target_type, s.target_id, s.interval_minutes, s.enabled, Number(ctx.params.id));
  audit(u.username, 'schedule.update', s.name);
  return { ok: true };
});

route('POST', '/api/schedules/:id/run', (ctx) => {
  need(ctx, 'tech');
  run('UPDATE schedules SET last_run=NULL WHERE id=?', Number(ctx.params.id));
  return { ok: true };
});

route('DELETE', '/api/schedules/:id', (ctx) => {
  const u = need(ctx, 'tech');
  run('DELETE FROM schedules WHERE id=?', Number(ctx.params.id));
  audit(u.username, 'schedule.delete', ctx.params.id);
  return { ok: true };
});

// ---------- alerts ----------

route('GET', '/api/alerts', (ctx) => {
  need(ctx);
  const status = ctx.query.get('status') || 'active';
  const where = status === 'active' ? "WHERE al.status IN ('open','ack')" : status === 'all' ? '' : 'WHERE al.status=?';
  const params = status === 'active' || status === 'all' ? [] : [status];
  return all(`SELECT al.*, a.hostname, c.name AS client_name FROM alerts al JOIN agents a ON a.id=al.agent_id
              LEFT JOIN clients c ON c.id=a.client_id ${where} ORDER BY al.updated_at DESC LIMIT 500`, ...params);
});

route('POST', '/api/alerts/:id/:action', (ctx) => {
  const u = need(ctx, 'tech');
  const { id, action } = ctx.params;
  if (action === 'ack') run("UPDATE alerts SET status='ack', updated_at=? WHERE id=? AND status='open'", Date.now(), Number(id));
  else if (action === 'resolve') run("UPDATE alerts SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", Date.now(), Date.now(), Number(id));
  else throw new HttpError(400, 'Unknown action');
  audit(u.username, `alert.${action}`, id);
  return { ok: true };
});

// ---------- settings, users, audit ----------

route('GET', '/api/settings', (ctx) => {
  need(ctx, 'admin');
  return { settings: getSettings(), defaults: SETTING_DEFAULTS, agent_versions: AGENT_VERSIONS };
});

route('PUT', '/api/settings', (ctx) => {
  const u = need(ctx, 'admin');
  saveSettings(ctx.body || {});
  audit(u.username, 'settings.update', Object.keys(ctx.body || {}).join(', '));
  return getSettings();
});

route('POST', '/api/settings/test-webhook', async (ctx) => {
  need(ctx, 'admin');
  const { webhook_url } = getSettings();
  if (!webhook_url) throw new HttpError(400, 'No webhook URL configured');
  const text = 'HostPilot RMM test notification';
  const r = await fetch(webhook_url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10000),
  }).catch((e) => ({ ok: false, status: e.message }));
  if (!r.ok) throw new HttpError(502, `Webhook failed: ${r.status}`);
  return { ok: true };
});

route('GET', '/api/users', (ctx) => {
  need(ctx, 'admin');
  return all('SELECT id, username, role, created_at, last_login FROM users ORDER BY username');
});

route('POST', '/api/users', (ctx) => {
  const u = need(ctx, 'admin');
  const { username, password, role } = ctx.body;
  if (!/^[\w.@-]{3,64}$/.test(username || '')) throw new HttpError(400, 'Username: 3-64 chars, letters/numbers/._@-');
  if (!password || password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  if (!ROLE_RANK[role]) throw new HttpError(400, 'Bad role');
  if (get('SELECT id FROM users WHERE username=?', username)) throw new HttpError(409, 'Username taken');
  run('INSERT INTO users(username, password_hash, role, created_at) VALUES(?,?,?,?)', username, hashPassword(password), role, Date.now());
  audit(u.username, 'user.create', `${username} (${role})`);
  return { ok: true };
});

route('PUT', '/api/users/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const target = get('SELECT * FROM users WHERE id=?', Number(ctx.params.id));
  if (!target) throw new HttpError(404, 'User not found');
  const { role, password } = ctx.body;
  if (role) {
    if (!ROLE_RANK[role]) throw new HttpError(400, 'Bad role');
    if (target.role === 'admin' && role !== 'admin' && get("SELECT COUNT(*) AS n FROM users WHERE role='admin'").n <= 1) {
      throw new HttpError(400, 'Cannot demote the last admin');
    }
    run('UPDATE users SET role=? WHERE id=?', role, target.id);
  }
  if (password) {
    if (password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), target.id);
    run('DELETE FROM sessions WHERE user_id=?', target.id);
  }
  audit(u.username, 'user.update', target.username);
  return { ok: true };
});

route('DELETE', '/api/users/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const target = get('SELECT * FROM users WHERE id=?', Number(ctx.params.id));
  if (!target) throw new HttpError(404, 'User not found');
  if (target.id === u.id) throw new HttpError(400, "You can't delete yourself");
  run('DELETE FROM users WHERE id=?', target.id);
  audit(u.username, 'user.delete', target.username);
  return { ok: true };
});

route('GET', '/api/audit', (ctx) => {
  need(ctx, 'admin');
  return all('SELECT * FROM audit ORDER BY id DESC LIMIT 500');
});

// ---------- device tasks (files, updates, software, users) ----------

function jobView(id) {
  const j = get(`SELECT id, batch_id, agent_id, name, task, shell, status, exit_code, stdout, stderr, created_at, sent_at, finished_at
                 FROM jobs WHERE id=?`, id);
  return j;
}

const isOnline = (a) => isPolling(a.id) || (a.last_seen && Date.now() - a.last_seen < ONLINE_WINDOW);

async function runTask(u, a, task, args, { wait = true, allowInternal = false } = {}) {
  const def = getTask(task, { allowInternal });
  if (def.wait && wait && !isOnline(a)) throw new HttpError(409, `${a.hostname} is offline`);
  let title = task;
  const r = queueJobs({
    agents: [a], name: task, task, timeout: def.timeout, createdBy: u.username,
    build: (ag) => { const b = buildTask(task, ag.platform, args, { allowInternal }); if (b) title = b.name; return b; },
  });
  if (!r.created) throw new HttpError(400, `This action isn't available on ${a.platform}`);
  const jobId = r.jobs[0].id;
  if (!/^(files\.list|users\.list|software\.search)$/.test(task)) audit(u.username, `task.${task}`, `${a.hostname}: ${title}`);
  if (wait && def.wait) await waitForJob(jobId, def.wait * 1000);
  return jobView(jobId);
}

route('POST', '/api/agents/:id/task', async (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  return runTask(u, a, String(ctx.body.task || ''), ctx.body.args || {}, { wait: ctx.body.wait !== false });
});

// Same task on many devices (no waiting) -> batch page
route('POST', '/api/tasks', (ctx) => {
  const u = need(ctx, 'tech');
  const { task, args = {} } = ctx.body;
  const def = getTask(String(task || ''));
  const ids = Array.isArray(ctx.body.agent_ids) ? ctx.body.agent_ids.map(String) : [];
  const agents = ids.map((id) => get('SELECT id, hostname, platform FROM agents WHERE id=?', id)).filter(Boolean);
  if (!agents.length) throw new HttpError(400, 'Select at least one device');
  // validate once per platform up front so errors surface instead of silently skipping
  for (const p of new Set(agents.map((a) => a.platform))) buildTask(task, p, args);
  let name = task;
  const r = queueJobs({
    agents, name, task, timeout: def.timeout, createdBy: u.username,
    build: (a) => { const b = buildTask(task, a.platform, args); if (b) name = b.name; return b; },
  });
  audit(u.username, `task.${task}`, `${name} on ${r.created} device(s)`);
  return r;
});

// ---------- files ----------

route('POST', '/api/agents/:id/files/download', async (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  const p = String(ctx.body.path || '');
  if (!p) throw new HttpError(400, 'Path is required');
  let name = baseName(p).replace(/:$/, '');
  if (ctx.body.is_dir) name += a.platform === 'windows' ? '.zip' : '.tar.gz';
  const t = createTransfer({ agentId: a.id, userId: u.id, direction: 'to-server', name });
  const job = await runTask(u, a, 'files.get', { path: p, url: `/api/transfer/${t.id}?token=${t.token}` }, { wait: false, allowInternal: true });
  return { transfer_id: t.id, job };
});

route('GET', '/api/transfers/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const t = getTransfer(ctx.params.id);
  if (!t || t.userId !== u.id || t.direction !== 'to-server') throw new HttpError(404, 'Transfer not found');
  if (!t.ready) return { ready: false };
  if (ctx.query.get('check') === '1') return { ready: true, size: t.size, name: t.name };
  return sendFile(t, ctx.res, { attachment: true }).then(() => removeTransfer(t));
});

route('POST', '/api/agents/:id/files/upload', async (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  const dest = String(ctx.query.get('path') || '');
  if (!dest) throw new HttpError(400, 'Destination path is required');
  const t = createTransfer({ agentId: a.id, userId: u.id, direction: 'to-device', name: baseName(dest) });
  await receiveInto(t, ctx.req);
  const job = await runTask(u, a, 'files.put', { path: dest, url: `/api/transfer/${t.id}?token=${t.token}` }, { wait: false, allowInternal: true });
  setTimeout(() => removeTransfer(t), 3 * 3600 * 1000).unref();
  return { job, size: t.size };
}, { raw: true });

// ---------- OS updates / patching ----------

route('GET', '/api/agents/:id/updates', (ctx) => {
  need(ctx);
  const a = loadAgent(ctx.params.id);
  const running = get(`SELECT id, task, status FROM jobs WHERE agent_id=? AND task IN ('updates.scan','updates.install')
                       AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, a.id);
  return {
    checked_at: a.updates_checked_at, reboot_required: !!a.reboot_required, running: running || null,
    updates: all('SELECT uid, kb, title, severity, category, size FROM updates WHERE agent_id=? ORDER BY severity DESC, title', a.id),
  };
});

route('GET', '/api/patching', (ctx) => {
  need(ctx);
  const busy = new Map(all(`SELECT agent_id, task FROM jobs WHERE task IN ('updates.scan','updates.install')
                            AND status IN ('queued','running')`).map((r) => [r.agent_id, r.task]));
  return all(`${AGENT_SELECT} ORDER BY a.hostname COLLATE NOCASE`).map((a) => {
    const p = presentAgent(a);
    return {
      id: p.id, hostname: p.hostname, client_name: p.client_name, platform: p.platform, os_name: p.os_name, online: p.online,
      maintenance: p.maintenance, updates_checked_at: p.updates_checked_at, pending_updates: p.pending_updates,
      security_updates: p.security_updates, reboot_required: !!p.reboot_required, busy: busy.get(p.id) || null,
    };
  });
});

// ---------- terminal (Linux) ----------

route('POST', '/api/agents/:id/terminal', (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  if (a.platform !== 'linux') throw new HttpError(400, 'Terminal sessions are available for Linux devices');
  return createTerminalSession({ id: a.id, hostname: a.hostname, platform: a.platform }, u);
});

// Bootstrap the first admin account.
export function ensureAdmin() {
  if (get('SELECT COUNT(*) AS n FROM users').n > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  const generated = !password;
  if (generated) password = randHex(9);
  tx(() => run('INSERT INTO users(username, password_hash, role, created_at) VALUES(?,?,?,?)', username, hashPassword(password), 'admin', Date.now()));
  console.log('==========================================================');
  console.log(` Created admin user "${username}"`);
  if (generated) console.log(` Generated password: ${password}   (change it after login)`);
  console.log('==========================================================');
}
