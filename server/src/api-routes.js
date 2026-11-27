import fs from 'node:fs';
import { route, clientIp, publicUrl } from './router.js';
import { all, get, run, tx, getSettings, saveSettings, audit, SETTING_DEFAULTS } from './db.js';
import { HttpError, randHex, sha256, hashPassword, verifyPassword, SHELLS, clampInt } from './util.js';
import { queueJobs, isPolling, waitForJob } from './jobs.js';
import { AGENT_VERSIONS } from './agent-routes.js';
import { createRemoteSession } from './remote.js';
import { createTerminalSession } from './terminal.js';
import { startLive, readLive } from './live.js';
import { normalizeCidr, presentNetDevice, NET_TYPES } from './netmap.js';
import { ruleCatalog, cleanPolicy, policyTargets } from './policies.js';
import { runPolicy, queueRoleDetect, checkWarranty } from './tasks.js';
import { deviceHistory } from './history.js';
import { createShot, listShots, shotFile, deleteShot } from './screenshots.js';
import { PACKS, roleDashboard, savePackLevels } from './roles.js';
import {
  CATEGORIES, categorize, ukey, listPolicies, presentPolicy as presentPatchPolicy, cleanPatchPolicy, effectivePolicy, approvalFor, manualApprovals,
  setApprovals, approvalQueue, patchDevices, patchDashboard, describeWindow, patchTimeZone,
} from './patching.js';
import { techSend, techRead, conversations, unreadSummary } from './chat.js';
import { getTask, buildTask, baseName, supportsTask } from './task-catalog.js';
import { normMac, isPrivateV4, wakeOnLan, agentWakeTarget } from './wol.js';
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

/** API keys ("Authorization: Bearer hpk_…"): act as their owner, capped at the role chosen for the key. */
function apiKeyUser(tok) {
  const k = get(`SELECT k.id, k.role AS key_role, k.expires_at, k.last_used, u.id AS uid, u.username, u.role FROM api_keys k
                 JOIN users u ON u.id=k.user_id WHERE k.token_hash=?`, sha256(tok));
  if (!k || (k.expires_at && k.expires_at < Date.now())) return null;
  if (!k.last_used || Date.now() - k.last_used > 60000) run('UPDATE api_keys SET last_used=? WHERE id=?', Date.now(), k.id);
  const role = ROLE_RANK[k.key_role] && ROLE_RANK[k.key_role] < ROLE_RANK[k.role] ? k.key_role : k.role;
  return { id: k.uid, username: k.username, role, api_key: k.id };
}

export function sessionUser(req) {
  const auth = String(req.headers.authorization || '');
  if (/^Bearer hpk_[a-f0-9]{40}$/.test(auth)) return apiKeyUser(auth.slice(7));
  const tok = parseCookies(req)[SESSION_COOKIE];
  if (!tok) return null;
  const s = get(`SELECT u.id, u.username, u.role, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
                 WHERE s.token_hash=?`, sha256(tok));
  if (!s || s.expires_at < Date.now()) return null;
  // sliding expiry
  if (s.expires_at - Date.now() < SESSION_TTL / 2) run('UPDATE sessions SET expires_at=? WHERE token_hash=?', Date.now() + SESSION_TTL, sha256(tok));
  return { id: s.id, username: s.username, role: s.role };
}

export function need(ctx, role = 'viewer') {
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

// per-user dashboard layout: [{ id, span }] in display order; null means "use the default layout"
route('GET', '/api/me/dashboard', (ctx) => {
  const u = need(ctx);
  const row = get('SELECT dashboard FROM users WHERE id=?', u.id);
  let layout = null;
  try { layout = row?.dashboard ? JSON.parse(row.dashboard) : null; } catch { layout = null; }
  return { layout };
});
route('PUT', '/api/me/dashboard', (ctx) => {
  const u = need(ctx);
  const raw = ctx.body.layout;
  if (raw === null) { run('UPDATE users SET dashboard=NULL WHERE id=?', u.id); return { layout: null }; }
  if (!Array.isArray(raw) || raw.length > 80) throw new HttpError(400, 'Invalid layout');
  const seen = new Set();
  const layout = raw.map((w) => ({ id: String(w?.id || ''), span: Math.min(4, Math.max(1, Math.round(Number(w?.span) || 1))) }))
    .filter((w) => /^[a-z0-9-]{1,40}$/.test(w.id) && !seen.has(w.id) && seen.add(w.id));
  run('UPDATE users SET dashboard=? WHERE id=?', JSON.stringify(layout), u.id);
  return { layout };
});

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
  const { secret_hash, net_rx_total, net_tx_total, net_ts, chat_token, ...rest } = a;
  const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  return {
    ...rest,
    core_load: json(a.core_load, null),
    services: json(a.services, []),
    device_class: a.device_class || (a.platform === 'linux' || /server/i.test(a.os_name || '') ? 'server' : 'desktop'),
    net_ifaces: a.net_ifaces ? JSON.parse(a.net_ifaces) : null,
    ip_addrs: a.ip_addrs ? JSON.parse(a.ip_addrs) : [],
    disks,
    disk_pct: disks.length ? Math.round(diskMax * 10) / 10 : null,
    online: isPolling(a.id) || (a.last_seen && Date.now() - a.last_seen < ONLINE_WINDOW),
    maintenance: !!a.maintenance,
    update_pending: a.agent_version && AGENT_VERSIONS[a.platform] && a.agent_version !== AGENT_VERSIONS[a.platform],
    roles: json(a.roles, []).map((r) => ({ ...r, label: PACKS[r.id]?.label || r.id })),
    wsus: !!a.wsus,
  };
}

const AGENT_SELECT = `SELECT a.*, c.name AS client_name, ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone,
  (SELECT COUNT(*) FROM alerts al WHERE al.agent_id=a.id AND al.status IN ('open','ack')) AS open_alerts
  FROM agents a LEFT JOIN clients c ON c.id=a.client_id LEFT JOIN contacts ct ON ct.id=a.contact_id`;

export function loadAgent(id) {
  const a = get(`${AGENT_SELECT} WHERE a.id=?`, id);
  if (!a) throw new HttpError(404, 'Device not found');
  return a;
}

// ---------- dashboard ----------

route('GET', '/api/dashboard', (ctx) => {
  const u = need(ctx);
  const now = Date.now();
  const since = now - 86400000;
  const s = getSettings();
  const agents = all(AGENT_SELECT).map(presentAgent);
  const online = agents.filter((a) => a.online);
  // the small device summary the dashboard lists use
  const brief = (a, extra = {}) => ({ id: a.id, hostname: a.hostname, platform: a.platform, online: a.online, maintenance: a.maintenance,
    client_name: a.client_name, last_seen: a.last_seen, ...extra });
  const top = (list, key, n = 5) => list.filter((a) => a[key] != null).sort((x, y) => y[key] - x[key]).slice(0, n);
  const count = (list, fn) => list.filter(fn).length;
  const avg = (list, key) => { const v = list.map((a) => a[key]).filter((x) => x != null); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };

  const jobStats = all('SELECT status, COUNT(*) AS n FROM jobs WHERE created_at>? GROUP BY status', since);
  const alertRows = all(`SELECT al.*, a.hostname FROM alerts al JOIN agents a ON a.id=al.agent_id
                         WHERE al.status IN ('open','ack') ORDER BY (al.severity='critical') DESC, al.updated_at DESC`);

  // latest network rate per device (from the last check-in within 10 minutes)
  const net = all(`SELECT m.agent_id, m.net_rx, m.net_tx FROM metrics m
                   JOIN (SELECT agent_id, MAX(ts) AS ts FROM metrics WHERE ts>? AND net_rx IS NOT NULL GROUP BY agent_id) x
                     ON x.agent_id=m.agent_id AND x.ts=m.ts`, now - 600000);
  const netById = new Map(net.map((r) => [r.agent_id, r]));
  const withNet = agents.filter((a) => netById.has(a.id)).map((a) => ({ ...a, net_total: netById.get(a.id).net_rx + netById.get(a.id).net_tx,
    net_rx: netById.get(a.id).net_rx, net_tx: netById.get(a.id).net_tx }));

  // fleet trend: per hour over 24 h, devices reporting + average CPU / memory
  const trend = all(`SELECT (ts/3600000)*3600000 AS ts, COUNT(DISTINCT agent_id) AS devices, AVG(cpu) AS cpu, AVG(mem) AS mem,
                     AVG(net_rx+net_tx) * COUNT(DISTINCT CASE WHEN net_rx IS NOT NULL THEN agent_id END) AS net
                     FROM metrics WHERE ts>? GROUP BY ts/3600000 ORDER BY 1`, since);

  // patching
  const scanned = agents.filter((a) => a.updates_checked_at);
  const staleScan = now - Math.max(1, s.update_scan_hours || 24) * 3 * 3600000;

  // clients
  const clients = all('SELECT id, name FROM clients ORDER BY name COLLATE NOCASE').map((c) => {
    const list = agents.filter((a) => a.client_id === c.id);
    return { id: c.id, name: c.name, devices: list.length, online: count(list, (a) => a.online), alerts: list.reduce((p, a) => p + (a.open_alerts || 0), 0),
      patches: list.reduce((p, a) => p + (a.pending_updates || 0), 0) };
  });
  const unassigned = agents.filter((a) => !a.client_id).length;

  // operating systems
  const osCounts = new Map();
  for (const a of agents) { const k = a.os_name || ({ windows: 'Windows', linux: 'Linux', macos: 'macOS' }[a.platform] || a.platform); osCounts.set(k, (osCounts.get(k) || 0) + 1); }

  // servers vs workstations (Windows Server editions and Linux hosts count as servers)
  const worst = new Map(all(`SELECT agent_id, MAX(CASE WHEN severity='critical' THEN 2 ELSE 1 END) AS lvl FROM alerts
                              WHERE status IN ('open','ack') GROUP BY agent_id`).map((x) => [x.agent_id, x.lvl]));
  const isServer = (a) => a.platform === 'linux' || /server/i.test(a.os_name || '');
  const group = (list) => {
    const failing = count(list, (a) => worst.get(a.id) === 2);
    const warning = count(list, (a) => worst.get(a.id) === 1);
    const days = (a) => (a.boot_time ? (now - a.boot_time) / 86400000 : 0);
    return {
      total: list.length,
      problems: { failing, warning, healthy: list.length - failing - warning },
      status: {
        offline: count(list, (a) => !a.online), reboot: count(list, (a) => a.reboot_required),
        patches: count(list, (a) => a.pending_updates > 0), online: count(list, (a) => a.online),
      },
      uptime: { d30: count(list, (a) => a.online && days(a) > 30), d60: count(list, (a) => a.online && days(a) > 60), d90: count(list, (a) => a.online && days(a) > 90) },
    };
  };
  const servers = group(agents.filter(isServer));
  const workstations = group(agents.filter((a) => !isServer(a)));

  const outdated = agents.filter((a) => a.update_pending);
  const longUp = online.filter((a) => a.boot_time && now - a.boot_time > 30 * 86400000);
  const longOff = agents.filter((a) => !a.online && a.last_seen && now - a.last_seen > 7 * 86400000);

  return {
    generated_at: now,
    totals: {
      devices: agents.length, online: online.length, offline: agents.length - online.length,
      maintenance: count(agents, (a) => a.maintenance), with_alerts: count(agents, (a) => a.open_alerts > 0),
      windows: count(agents, (a) => a.platform === 'windows'), linux: count(agents, (a) => a.platform === 'linux'), macos: count(agents, (a) => a.platform === 'macos'),
      clients: clients.length, unassigned,
      open_alerts: alertRows.length, critical_alerts: count(alertRows, (a) => a.severity === 'critical'),
      users: get('SELECT COUNT(*) AS n FROM users').n, scripts: get('SELECT COUNT(*) AS n FROM scripts').n,
      software_titles: get('SELECT COUNT(DISTINCT name) AS n FROM software').n,
    },
    resources: {
      avg_cpu: avg(online, 'cpu_pct'), avg_mem: avg(online, 'mem_pct'), avg_disk: avg(agents, 'disk_pct'),
      high_cpu: count(online, (a) => a.cpu_pct >= s.cpu_threshold), high_mem: count(online, (a) => a.mem_pct >= s.mem_threshold),
      low_disk: count(agents, (a) => a.disk_pct >= s.disk_threshold),
      thresholds: { cpu: s.cpu_threshold, mem: s.mem_threshold, disk: s.disk_threshold },
      top_cpu: top(online, 'cpu_pct').map((a) => brief(a, { value: a.cpu_pct })),
      top_mem: top(online, 'mem_pct').map((a) => brief(a, { value: a.mem_pct })),
      top_disk: top(agents, 'disk_pct').map((a) => brief(a, { value: a.disk_pct })),
    },
    network: {
      total_rx: withNet.reduce((p, a) => p + a.net_rx, 0), total_tx: withNet.reduce((p, a) => p + a.net_tx, 0), reporting: withNet.length,
      top: top(withNet, 'net_total').map((a) => brief(a, { rx: a.net_rx, tx: a.net_tx })),
    },
    patching: {
      scanned: scanned.length, never_scanned: agents.length - scanned.length,
      stale: count(scanned, (a) => a.updates_checked_at < staleScan),
      pending: agents.reduce((p, a) => p + (a.pending_updates || 0), 0),
      security: agents.reduce((p, a) => p + (a.security_updates || 0), 0),
      devices_pending: count(agents, (a) => a.pending_updates > 0), devices_security: count(agents, (a) => a.security_updates > 0),
      up_to_date: count(scanned, (a) => !a.pending_updates), reboot_required: count(agents, (a) => a.reboot_required),
      top: top(agents, 'pending_updates').filter((a) => a.pending_updates > 0)
        .map((a) => brief(a, { pending: a.pending_updates, security: a.security_updates || 0, reboot: !!a.reboot_required })),
    },
    agents: { current: agents.length - outdated.length, outdated: outdated.length, offline: count(agents, (a) => !a.online) },
    servers, workstations,
    net_devices: all('SELECT type, COUNT(*) AS n, SUM(online) AS online FROM net_devices GROUP BY type'),
    device_classes: ['desktop', 'laptop', 'server', 'vm'].map((c) => ({ class: c, n: count(agents, (a) => a.device_class === c), online: count(agents, (a) => a.device_class === c && a.online) })),
    compliance: (() => {
      const pols = all('SELECT * FROM policies WHERE enabled=1');
      const s = { policies: pols.length, compliant: 0, non_compliant: 0, not_checked: 0 };
      for (const p of pols) { const c = policyCompliance(p); s.compliant += c.compliant; s.non_compliant += c.non_compliant; s.not_checked += c.not_checked; }
      return s;
    })(),
    networks: get('SELECT COUNT(*) AS n FROM networks').n,
    problem_devices: count(agents, (a) => worst.has(a.id) || !a.online),
    health: {
      long_uptime: longUp.sort((x, y) => x.boot_time - y.boot_time).slice(0, 6).map((a) => brief(a, { boot_time: a.boot_time })),
      long_uptime_count: longUp.length,
      long_offline: longOff.sort((x, y) => x.last_seen - y.last_seen).slice(0, 6).map((a) => brief(a)),
      long_offline_count: longOff.length,
      recently_offline: agents.filter((a) => !a.online && !a.maintenance).sort((x, y) => y.last_seen - x.last_seen).slice(0, 6).map((a) => brief(a)),
    },
    os: [...osCounts].map(([name, n]) => ({ name, n })).sort((x, y) => y.n - x.n),
    clients: clients.sort((x, y) => (y.alerts - x.alerts) || (y.devices - x.devices)),
    trend,
    jobs_24h: Object.fromEntries(jobStats.map((r) => [r.status, r.n])),
    recent_alerts: alertRows.slice(0, 8),
    recent_jobs: all(`SELECT j.id, j.batch_id, j.name, j.status, j.created_at, j.created_by, a.hostname, j.agent_id
                      FROM jobs j JOIN agents a ON a.id=j.agent_id ORDER BY j.created_at DESC LIMIT 8`),
    failed_jobs: all(`SELECT j.id, j.name, j.status, j.created_at, a.hostname FROM jobs j JOIN agents a ON a.id=j.agent_id
                      WHERE j.created_at>? AND j.status IN ('failed','timeout','lost') ORDER BY j.created_at DESC LIMIT 5`, since),
    schedules: all(`SELECT s.id, s.name, s.interval_minutes, s.last_run, s.enabled, sc.name AS script FROM schedules s
                    JOIN scripts sc ON sc.id=s.script_id WHERE s.enabled=1`)
      .map((x) => ({ ...x, next_run: (x.last_run || 0) + x.interval_minutes * 60000 }))
      .sort((x, y) => x.next_run - y.next_run).slice(0, 6),
    activity: u.role === 'admin' ? all('SELECT ts, username, action, detail FROM audit ORDER BY id DESC LIMIT 8') : null,
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
  c.contacts = all('SELECT * FROM contacts WHERE client_id=? ORDER BY name COLLATE NOCASE', c.id).map(pubContact);
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
  if (b.contact_id !== undefined) {
    const cid = b.contact_id ? Number(b.contact_id) : null;
    if (cid && !get('SELECT id FROM contacts WHERE id=?', cid)) throw new HttpError(400, 'Unknown contact');
    run('UPDATE agents SET contact_id=? WHERE id=?', cid, a.id);
  }
  for (const k of ['warranty_end', 'purchase_date']) {
    if (b[k] === undefined) continue;
    const v = b[k] ? String(b[k]).slice(0, 10) : null;
    if (v && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)))) throw new HttpError(400, 'Dates must look like 2027-03-31');
    run(`UPDATE agents SET ${k}=? WHERE id=?`, v, a.id);
  }
  if (b.warranty_note !== undefined) run('UPDATE agents SET warranty_note=? WHERE id=?', String(b.warranty_note || '').slice(0, 300), a.id);
  if (b.warranty_end !== undefined) checkWarranty(a.id);
  if (b.patch_override !== undefined) {
    const o = b.patch_override === 'none' ? 'none' : b.patch_override ? String(Number(b.patch_override)) : null;
    if (o && o !== 'none' && !get('SELECT id FROM patch_policies WHERE id=?', Number(o))) throw new HttpError(400, 'Unknown patch policy');
    run('UPDATE agents SET patch_override=? WHERE id=?', o, a.id);
  }
  if (b.watch_services !== undefined) {
    const list = String(b.watch_services || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    if (list.some((x) => !/^[\w.@:+$-]{1,100}$/.test(x))) throw new HttpError(400, 'Service names may only contain letters, digits and . _ - @ : + $');
    run('UPDATE agents SET watch_services=? WHERE id=?', list.join(','), a.id);
    // stop alerting for services that are no longer watched
    for (const al of all("SELECT id, type FROM alerts WHERE agent_id=? AND type LIKE 'service:%' AND status IN ('open','ack')", a.id)) {
      const name = al.type.slice(8);
      const s = getSettings();
      const global = String(s[`watch_services_${a.platform}`] || '').toLowerCase().split(/[,\s]+/);
      if (!list.map((x) => x.toLowerCase()).includes(name) && !global.includes(name)) run("UPDATE alerts SET status='resolved', resolved_at=? WHERE id=?", Date.now(), al.id);
    }
  }
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
  const rows = all('SELECT ts, cpu, mem, disk, net_rx, net_tx FROM metrics WHERE agent_id=? AND ts>? ORDER BY ts', ctx.params.id, since);
  // downsample to <= 300 points
  const step = Math.ceil(rows.length / 300) || 1;
  if (step === 1) return rows;
  const out = [];
  for (let i = 0; i < rows.length; i += step) {
    const chunk = rows.slice(i, i + step);
    const avg = (k) => { const v = chunk.map((r) => r[k]).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    out.push({ ts: chunk[chunk.length - 1].ts, cpu: avg('cpu'), mem: avg('mem'), disk: avg('disk'), net_rx: avg('net_rx'), net_tx: avg('net_tx') });
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
    run('DELETE FROM mobile_devices WHERE user_id=?', target.id);
  }
  audit(u.username, 'user.update', target.username);
  return { ok: true };
});

route('DELETE', '/api/users/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const target = get('SELECT * FROM users WHERE id=?', Number(ctx.params.id));
  if (!target) throw new HttpError(404, 'User not found');
  if (target.id === u.id) throw new HttpError(400, "You can't delete yourself");
  run('DELETE FROM mobile_devices WHERE user_id=?', target.id);
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
  if (!r.created) throw new HttpError(400, `This action isn't available on ${{ windows: 'Windows', linux: 'Linux', macos: 'macOS' }[a.platform] || a.platform}`);
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
  return sendFile(t, ctx.res, { attachment: true }).then((done) => { if (done) removeTransfer(t); });
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

// ---------- forced agent update ----------

function queueAgentUpdate(u, agents) {
  const r = queueJobs({ agents, name: 'Update agent', shell: '_update', body: '', timeout: 300, createdBy: u.username });
  audit(u.username, 'agent.update', agents.length === 1 ? agents[0].hostname : `${r.created} devices`);
  return r;
}

route('POST', '/api/agents/:id/update-agent', (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  return queueAgentUpdate(u, [a]);
});

route('POST', '/api/agents/update-agent', (ctx) => {
  const u = need(ctx, 'tech');
  const ids = Array.isArray(ctx.body.agent_ids) ? ctx.body.agent_ids.slice(0, 5000).map(String) : [];
  const agents = ids.map((id) => get('SELECT id, hostname, platform FROM agents WHERE id=?', id)).filter(Boolean);
  if (!agents.length) throw new HttpError(400, 'No devices selected');
  return queueAgentUpdate(u, agents);
});

// ---------- chat with the signed-in user (Windows tray icon) ----------

route('GET', '/api/agents/:id/chat', async (ctx) => {
  need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  const msgs = await techRead(a.id, clampInt(ctx.query.get('after'), 0, 1e12, 0), clampInt(ctx.query.get('wait'), 0, 25, 0), ctx.res);
  return { messages: msgs, supported: ['windows', 'linux'].includes(a.platform), tray: !!getSettings().tray_icon, logged_user: a.logged_user };
});
route('POST', '/api/agents/:id/chat', (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  if (!['windows', 'linux'].includes(a.platform)) throw new HttpError(400, 'Chat needs the HostPilot tray icon (Windows or a Linux desktop)');
  const m = techSend(a, u, ctx.body.body);
  audit(u.username, 'chat.send', a.hostname);
  return m;
});
route('GET', '/api/chat/conversations', (ctx) => { need(ctx, 'tech'); return conversations(); });
route('GET', '/api/chat/unread', (ctx) => { need(ctx); return unreadSummary(); });

// ---------- policies (configuration baselines) ----------

function policyCompliance(p) {
  const targets = policyTargets(p);
  const ids = new Set(targets.map((a) => a.id));
  const rows = all('SELECT agent_id, status, checked_at FROM policy_results WHERE policy_id=?', p.id).filter((r) => ids.has(r.agent_id));
  const per = new Map();
  for (const r of rows) {
    const s = per.get(r.agent_id) || { bad: false, fixed: false, at: 0 };
    if (r.status === 'fail' || r.status === 'error') s.bad = true;
    if (r.status === 'fixed') s.fixed = true;
    s.at = Math.max(s.at, r.checked_at);
    per.set(r.agent_id, s);
  }
  const compliant = [...per.values()].filter((s) => !s.bad).length;
  return { targets: targets.length, checked: per.size, compliant, non_compliant: per.size - compliant, not_checked: targets.length - per.size,
    fixed: [...per.values()].filter((s) => s.fixed).length };
}
const presentPolicy = (p) => ({ ...p, enabled: !!p.enabled, enforce: !!p.enforce, target: JSON.parse(p.target), rules: JSON.parse(p.rules) });
const loadPolicy = (id) => { const p = get('SELECT * FROM policies WHERE id=?', Number(id)); if (!p) throw new HttpError(404, 'Policy not found'); return p; };

route('GET', '/api/policy-rules', (ctx) => { need(ctx); return ruleCatalog(); });

route('GET', '/api/policies', (ctx) => {
  need(ctx);
  return all('SELECT * FROM policies ORDER BY name COLLATE NOCASE').map((p) => ({ ...presentPolicy(p), compliance: policyCompliance(p) }));
});

route('GET', '/api/policies/:id', (ctx) => {
  need(ctx);
  const p = loadPolicy(ctx.params.id);
  const targets = policyTargets(p);
  const names = new Map(all('SELECT id, hostname, platform, last_seen, device_class FROM agents').map((a) => [a.id, a]));
  const results = all('SELECT agent_id, rule_key, status, detail, checked_at FROM policy_results WHERE policy_id=?', p.id);
  return {
    ...presentPolicy(p), compliance: policyCompliance(p),
    devices: targets.map((a) => ({ ...names.get(a.id), id: a.id, results: results.filter((r) => r.agent_id === a.id) })),
  };
});

route('POST', '/api/policies', (ctx) => {
  const u = need(ctx, 'admin');
  const v = cleanPolicy(ctx.body);
  const t = Date.now();
  const r = run(`INSERT INTO policies(name, description, enabled, enforce, interval_hours, target, rules, created_by, created_at, updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?)`, v.name, v.description, v.enabled, v.enforce, v.interval_hours, JSON.stringify(v.target), JSON.stringify(v.rules), u.username, t, t);
  const p = loadPolicy(r.lastInsertRowid);
  audit(u.username, 'policy.create', `${p.name}${v.enforce ? ' (enforced)' : ''}`);
  if (v.enabled && ctx.body.run_now !== false) runPolicy(p, u.username);
  return presentPolicy(p);
});

route('PUT', '/api/policies/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const old = loadPolicy(ctx.params.id);
  const v = cleanPolicy(ctx.body);
  run(`UPDATE policies SET name=?, description=?, enabled=?, enforce=?, interval_hours=?, target=?, rules=?, updated_at=? WHERE id=?`,
    v.name, v.description, v.enabled, v.enforce, v.interval_hours, JSON.stringify(v.target), JSON.stringify(v.rules), Date.now(), old.id);
  // results for rules that no longer exist would be misleading
  const keys = new Set(v.rules.map((r) => r.key));
  for (const r of all('SELECT DISTINCT rule_key FROM policy_results WHERE policy_id=?', old.id)) if (!keys.has(r.rule_key)) run('DELETE FROM policy_results WHERE policy_id=? AND rule_key=?', old.id, r.rule_key);
  audit(u.username, 'policy.update', `${v.name}${v.enforce ? ' (enforced)' : ''}`);
  const p = loadPolicy(old.id);
  if (v.enabled && ctx.body.run_now) runPolicy(p, u.username);
  return presentPolicy(p);
});

route('DELETE', '/api/policies/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const p = loadPolicy(ctx.params.id);
  run('DELETE FROM policies WHERE id=?', p.id);
  audit(u.username, 'policy.delete', p.name);
  return { ok: true };
});

route('POST', '/api/policies/:id/run', (ctx) => {
  const u = need(ctx, 'tech');
  const p = loadPolicy(ctx.params.id);
  const r = runPolicy(p, u.username, ctx.body.agent_id ? [String(ctx.body.agent_id)] : null);
  audit(u.username, 'policy.run', `${p.name} on ${r.created} device(s)`);
  return r;
});

route('GET', '/api/agents/:id/compliance', (ctx) => {
  need(ctx);
  const a = loadAgent(ctx.params.id);
  return all('SELECT * FROM policies ORDER BY name COLLATE NOCASE').filter((p) => policyTargets(p).some((x) => x.id === a.id)).map((p) => ({
    ...presentPolicy(p), results: all('SELECT rule_key, status, detail, checked_at FROM policy_results WHERE policy_id=? AND agent_id=?', p.id, a.id),
  }));
});

// ---------- network discovery & topology ----------

export function queueNetworkScan(n, createdBy) {
  const a = get('SELECT id, hostname, platform FROM agents WHERE id=?', n.probe_agent_id);
  if (!a) throw new HttpError(400, 'The probe device for this network no longer exists. Edit the network and pick another one.');
  const r = queueJobs({
    agents: [a], name: `Network discovery ${n.subnet}`, task: 'net.scan', timeout: 900, createdBy,
    build: (ag) => buildTask('net.scan', ag.platform, { subnet: n.subnet, community: n.community || '' }, { allowInternal: true }),
  });
  if (!r.created) throw new HttpError(400, 'This device cannot run network discovery');
  run('UPDATE networks SET last_job_id=?, scan_error=NULL WHERE id=?', r.jobs[0].id, n.id);
  return r.jobs[0];
}

function networkSummary(n) {
  const counts = all('SELECT type, COUNT(*) AS c, SUM(online) AS up FROM net_devices WHERE network_id=? GROUP BY type', n.id);
  const job = n.last_job_id ? get('SELECT id, status, created_at, finished_at FROM jobs WHERE id=?', n.last_job_id) : null;
  const probe = n.probe_agent_id ? get('SELECT id, hostname, platform, last_seen FROM agents WHERE id=?', n.probe_agent_id) : null;
  return {
    ...n, community_set: !!n.community, community: undefined, hops: n.hops ? JSON.parse(n.hops) : [],
    probe, job, scanning: !!job && ['queued', 'running'].includes(job.status),
    client_name: n.client_id ? get('SELECT name FROM clients WHERE id=?', n.client_id)?.name : null,
    total: counts.reduce((s, c) => s + c.c, 0), online: counts.reduce((s, c) => s + (c.up || 0), 0),
    by_type: Object.fromEntries(counts.map((c) => [c.type, c.c])),
  };
}

function networkArgs(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) { out.name = String(b.name || '').trim().slice(0, 100); if (!out.name) throw new HttpError(400, 'Name is required'); }
  if (!partial || b.subnet !== undefined) out.subnet = normalizeCidr(b.subnet);
  if (!partial || b.probe_agent_id !== undefined) {
    const a = get('SELECT id FROM agents WHERE id=?', String(b.probe_agent_id || ''));
    if (!a) throw new HttpError(400, 'Pick a probe device');
    out.probe_agent_id = a.id;
  }
  if (b.client_id !== undefined) out.client_id = b.client_id ? Number(b.client_id) : null;
  if (b.community !== undefined) {
    out.community = String(b.community || '').trim();
    if (out.community && !/^[\w.@#$%^&*!+=-]{1,32}$/.test(out.community)) throw new HttpError(400, 'Invalid SNMP community');
  }
  if (b.scan_hours !== undefined) out.scan_hours = clampInt(b.scan_hours, 0, 24 * 30, 24);
  return out;
}

route('GET', '/api/networks', (ctx) => { need(ctx); return all('SELECT * FROM networks ORDER BY name COLLATE NOCASE').map(networkSummary); });

route('POST', '/api/networks', (ctx) => {
  const u = need(ctx, 'tech');
  const v = networkArgs(ctx.body, false);
  const r = run(`INSERT INTO networks(name, client_id, probe_agent_id, subnet, community, scan_hours, created_at) VALUES(?,?,?,?,?,?,?)`,
    v.name, v.client_id ?? null, v.probe_agent_id, v.subnet, v.community ?? 'public', v.scan_hours ?? 24, Date.now());
  const n = get('SELECT * FROM networks WHERE id=?', r.lastInsertRowid);
  audit(u.username, 'network.create', `${n.name} ${n.subnet}`);
  if (ctx.body.scan_now !== false) queueNetworkScan(n, u.username);
  return networkSummary(get('SELECT * FROM networks WHERE id=?', n.id));
});

const loadNetwork = (id) => { const n = get('SELECT * FROM networks WHERE id=?', Number(id)); if (!n) throw new HttpError(404, 'Network not found'); return n; };

route('GET', '/api/networks/:id', (ctx) => {
  need(ctx);
  const n = loadNetwork(ctx.params.id);
  return { ...networkSummary(n), devices: all('SELECT * FROM net_devices WHERE network_id=? ORDER BY online DESC, ip', n.id).map(presentNetDevice) };
});

route('PUT', '/api/networks/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const n = loadNetwork(ctx.params.id);
  const v = networkArgs(ctx.body, true);
  const keys = Object.keys(v);
  if (keys.length) run(`UPDATE networks SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => v[k]), n.id);
  if (v.subnet && v.subnet !== n.subnet) run('DELETE FROM net_devices WHERE network_id=?', n.id);
  audit(u.username, 'network.update', n.name);
  return networkSummary(loadNetwork(n.id));
});

route('DELETE', '/api/networks/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const n = loadNetwork(ctx.params.id);
  run('DELETE FROM networks WHERE id=?', n.id);
  audit(u.username, 'network.delete', n.name);
  return { ok: true };
});

route('POST', '/api/networks/:id/scan', (ctx) => {
  const u = need(ctx, 'tech');
  const n = loadNetwork(ctx.params.id);
  const s = networkSummary(n);
  if (s.scanning) throw new HttpError(409, 'A scan is already running');
  const job = queueNetworkScan(n, u.username);
  audit(u.username, 'network.scan', `${n.name} ${n.subnet}`);
  return { job };
});

route('PUT', '/api/net-devices/:id', (ctx) => {
  need(ctx, 'tech');
  const d = get('SELECT * FROM net_devices WHERE id=?', Number(ctx.params.id));
  if (!d) throw new HttpError(404, 'Device not found');
  if (ctx.body.name !== undefined) run('UPDATE net_devices SET name=? WHERE id=?', String(ctx.body.name || '').trim().slice(0, 100) || null, d.id);
  if (ctx.body.type !== undefined) {
    if (ctx.body.type === 'auto') run('UPDATE net_devices SET type_manual=0 WHERE id=?', d.id);
    else if (NET_TYPES.includes(ctx.body.type)) run("UPDATE net_devices SET type=?, type_manual=1, reason='Set manually' WHERE id=?", ctx.body.type, d.id);
    else throw new HttpError(400, 'Unknown device type');
  }
  return presentNetDevice(get('SELECT * FROM net_devices WHERE id=?', d.id));
});

route('DELETE', '/api/net-devices/:id', (ctx) => {
  need(ctx, 'tech');
  run('DELETE FROM net_devices WHERE id=?', Number(ctx.params.id));
  return { ok: true };
});

// ---------- Wake-on-LAN ----------


route('POST', '/api/agents/:id/wake', async (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  const t = agentWakeTarget(a);
  if (!t.macs.length) throw new HttpError(400, `HostPilot doesn't know ${a.hostname}'s network adapter MAC address yet. It's recorded the next time the agent checks in.`);
  return wakeOnLan({ ...t, clientId: a.client_id, exclude: a.id, label: a.hostname, user: u });
});

route('POST', '/api/net-devices/:id/wake', async (ctx) => {
  const u = need(ctx, 'tech');
  const d = get('SELECT * FROM net_devices WHERE id=?', Number(ctx.params.id));
  if (!d) throw new HttpError(404, 'Device not found');
  const mac = normMac(d.mac);
  if (!mac) throw new HttpError(400, 'This device has no known MAC address');
  const n = loadNetwork(d.network_id);
  return wakeOnLan({
    macs: [mac], ips: isPrivateV4(d.ip) ? [d.ip] : [], subnets: [n.subnet], prefer: n.probe_agent_id, clientId: n.client_id,
    exclude: d.agent_id, label: d.name || d.hostname || d.ip || mac, user: u,
  });
});

// subnets a device is on (from its IPs), to prefill "Add network"
route('GET', '/api/agents/:id/subnets', (ctx) => {
  need(ctx);
  const a = loadAgent(ctx.params.id);
  return (a.ip_addrs ? JSON.parse(a.ip_addrs) : []).filter((ip) => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip))
    .map((ip) => `${ip.split('.').slice(0, 3).join('.')}.0/24`).filter((v, i, arr) => arr.indexOf(v) === i);
});

// ---------- live performance (1-minute chart) ----------

route('POST', '/api/agents/:id/live', (ctx) => {
  const u = need(ctx);
  const a = loadAgent(ctx.params.id);
  if (!isOnline(a)) throw new HttpError(409, `${a.hostname} is offline`);
  return startLive({ id: a.id, hostname: a.hostname, platform: a.platform }, u);
});

route('GET', '/api/agents/:id/live', (ctx) => { need(ctx); return readLive(ctx.params.id); });

// ---------- terminal (Linux) ----------

route('POST', '/api/agents/:id/terminal', (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  const shell = a.platform === 'windows' ? (ctx.body.shell === 'cmd' ? 'cmd' : 'powershell') : 'bash';
  return createTerminalSession({ id: a.id, hostname: a.hostname, platform: a.platform }, u, shell);
});

// ---------- user preferences: favorites, device list columns, theme ----------

const THEMES = ['auto', 'light', 'dark'];
function readPrefs(userId) {
  let p = {};
  try { p = JSON.parse(get('SELECT prefs FROM users WHERE id=?', userId)?.prefs || '{}') || {}; } catch { p = {}; }
  return { favorites: Array.isArray(p.favorites) ? p.favorites : [], columns: Array.isArray(p.columns) ? p.columns : null,
    theme: THEMES.includes(p.theme) ? p.theme : 'auto', show_ids: !!p.show_ids };
}
route('GET', '/api/me/prefs', (ctx) => readPrefs(need(ctx).id));
route('PUT', '/api/me/prefs', (ctx) => {
  const u = need(ctx);
  const b = ctx.body, cur = readPrefs(u.id);
  if (b.favorites !== undefined) {
    if (!Array.isArray(b.favorites)) throw new HttpError(400, 'Bad favorites');
    cur.favorites = b.favorites.slice(0, 40).map((f) => ({ href: String(f?.href || ''), label: String(f?.label || '').slice(0, 80) }))
      .filter((f) => /^#\/[\w/.-]{0,200}$/.test(f.href) && f.label);
  }
  if (b.columns !== undefined) cur.columns = b.columns === null ? null : (Array.isArray(b.columns) ? b.columns : []).map(String).filter((c) => /^[a-z_]{1,30}$/.test(c)).slice(0, 40);
  if (b.theme !== undefined) cur.theme = THEMES.includes(b.theme) ? b.theme : 'auto';
  if (b.show_ids !== undefined) cur.show_ids = !!b.show_ids;
  run('UPDATE users SET prefs=? WHERE id=?', JSON.stringify(cur), u.id);
  return cur;
});

// ---------- notification bell: jobs you started that finished ----------

route('GET', '/api/me/notifications', (ctx) => {
  const u = need(ctx);
  const since = clampInt(ctx.query.get('since'), 0, Number.MAX_SAFE_INTEGER, Date.now() - 86400000);
  const items = all(`SELECT j.id, j.name, j.status, j.finished_at, j.agent_id, a.hostname FROM jobs j JOIN agents a ON a.id=j.agent_id
                     WHERE j.created_by=? AND j.finished_at > ? AND j.status NOT IN ('queued','running')
                       AND COALESCE(j.task,'') NOT IN ('metrics.live','terminal.open','files.list','users.list','software.search','proc.list','svc.list','reg.list','fw.list')
                       AND j.shell!='_remote' ORDER BY j.finished_at DESC LIMIT 30`, u.username, since);
  return { now: Date.now(), items };
});

// ---------- global search (devices by name / ID / IP / serial / user, clients, scripts, contacts) ----------

route('GET', '/api/search', (ctx) => {
  need(ctx);
  const q = String(ctx.query.get('q') || '').trim().toLowerCase().slice(0, 100);
  if (!q) return { devices: [], clients: [], scripts: [], contacts: [] };
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const devices = all(`${AGENT_SELECT} WHERE lower(a.hostname) LIKE ? OR lower(a.id) LIKE ? OR a.ip_addrs LIKE ? OR lower(COALESCE(a.serial,'')) LIKE ?
                         OR lower(COALESCE(a.logged_user,'')) LIKE ? OR lower(COALESCE(a.public_ip,'')) LIKE ? OR lower(COALESCE(a.model,'')) LIKE ?
                       ORDER BY (lower(a.hostname)=?) DESC, a.hostname COLLATE NOCASE LIMIT 12`, like, like, like, like, like, like, like, q)
    .map((a) => { const p = presentAgent(a); return { id: p.id, hostname: p.hostname, client_name: p.client_name, platform: p.platform, online: p.online, ip: p.ip_addrs[0] || '', logged_user: p.logged_user }; });
  return {
    devices,
    clients: all('SELECT id, name FROM clients WHERE lower(name) LIKE ? ORDER BY name LIMIT 6', like),
    scripts: all('SELECT id, name, category, shell FROM scripts WHERE lower(name) LIKE ? OR lower(description) LIKE ? ORDER BY name LIMIT 8', like, like),
    contacts: all(`SELECT ct.id, ct.name, ct.email, ct.client_id, c.name AS client_name FROM contacts ct LEFT JOIN clients c ON c.id=ct.client_id
                   WHERE lower(ct.name) LIKE ? OR lower(COALESCE(ct.email,'')) LIKE ? ORDER BY ct.name LIMIT 6`, like, like),
  };
});

// ---------- contacts (people at a client; a device can be assigned to one) ----------

/** contacts as the console sees them: never the portal password hash */
export const pubContact = ({ portal_hash, ...c }) => ({ ...c, portal: !!portal_hash, portal_all: !!c.portal_all });
function cleanContact(b) {
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Name is required');
  const email = String(b.email || '').trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address looks wrong');
  return { name, email, phone: String(b.phone || '').trim().slice(0, 50), title: String(b.title || '').trim().slice(0, 100), notes: String(b.notes || '').slice(0, 2000) };
}
route('GET', '/api/contacts', (ctx) => {
  need(ctx);
  const cid = ctx.query.get('client_id');
  return all(`SELECT ct.*, c.name AS client_name, (SELECT COUNT(*) FROM agents a WHERE a.contact_id=ct.id) AS devices FROM contacts ct
              LEFT JOIN clients c ON c.id=ct.client_id ${cid ? 'WHERE ct.client_id=?' : ''} ORDER BY ct.name COLLATE NOCASE`, ...(cid ? [Number(cid)] : [])).map(pubContact);
});
route('POST', '/api/contacts', (ctx) => {
  const u = need(ctx, 'tech');
  const v = cleanContact(ctx.body);
  const clientId = Number(ctx.body.client_id);
  if (!get('SELECT id FROM clients WHERE id=?', clientId)) throw new HttpError(400, 'Pick a client');
  const r = run('INSERT INTO contacts(client_id, name, email, phone, title, notes, created_at) VALUES(?,?,?,?,?,?,?)', clientId, v.name, v.email, v.phone, v.title, v.notes, Date.now());
  audit(u.username, 'contact.create', v.name);
  return pubContact(get('SELECT * FROM contacts WHERE id=?', r.lastInsertRowid));
});
route('PUT', '/api/contacts/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const c = get('SELECT * FROM contacts WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Contact not found');
  const v = cleanContact({ ...c, ...ctx.body });
  run('UPDATE contacts SET name=?, email=?, phone=?, title=?, notes=? WHERE id=?', v.name, v.email, v.phone, v.title, v.notes, c.id);
  audit(u.username, 'contact.update', v.name);
  return pubContact(get('SELECT * FROM contacts WHERE id=?', c.id));
});
route('DELETE', '/api/contacts/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const c = get('SELECT * FROM contacts WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Contact not found');
  run('UPDATE agents SET contact_id=NULL WHERE contact_id=?', c.id);
  run('DELETE FROM contacts WHERE id=?', c.id);
  audit(u.username, 'contact.delete', c.name);
  return { ok: true };
});

// ---------- device history ----------

route('GET', '/api/agents/:id/history', (ctx) => {
  need(ctx);
  const a = loadAgent(ctx.params.id);
  const kinds = ctx.query.get('kinds') ? String(ctx.query.get('kinds')).split(',') : null;
  return deviceHistory(a, { before: clampInt(ctx.query.get('before'), 0, Number.MAX_SAFE_INTEGER, Date.now() + 1), limit: 300, kinds });
});

// ---------- screenshots ----------

route('POST', '/api/agents/:id/screenshot', async (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  if (a.platform !== 'windows') throw new HttpError(400, 'Screenshots are available on Windows devices');
  if (!isOnline(a)) throw new HttpError(409, `${a.hostname} is offline`);
  const s = createShot(a.id, u.username);
  const job = await runTask(u, a, 'screenshot.take', { url: `/api/screenshot-upload/${s.id}?token=${s.token}` }, { wait: false, allowInternal: true });
  return { id: s.id, job };
});
route('GET', '/api/agents/:id/screenshots', (ctx) => { need(ctx, 'tech'); return listShots(loadAgent(ctx.params.id).id); });
route('GET', '/api/screenshots/:id/image', (ctx) => {
  need(ctx, 'tech');
  const s = get("SELECT * FROM screenshots WHERE id=? AND status='ready'", String(ctx.params.id));
  if (!s || !fs.existsSync(shotFile(s))) throw new HttpError(404, 'Screenshot not found');
  ctx.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400',
    ...(ctx.query.get('download') ? { 'Content-Disposition': `attachment; filename="screenshot-${new Date(s.created_at).toISOString().slice(0, 19).replace(/[T:]/g, '-')}.jpg"` } : {}) });
  ctx.res.end(fs.readFileSync(shotFile(s)));
});
route('DELETE', '/api/screenshots/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const s = get('SELECT * FROM screenshots WHERE id=?', String(ctx.params.id));
  if (!s) throw new HttpError(404, 'Screenshot not found');
  deleteShot(s);
  audit(u.username, 'screenshot.delete', s.agent_id);
  return { ok: true };
});

// ---------- role monitoring ----------

route('GET', '/api/roles', (ctx) => { need(ctx); return roleDashboard(isOnline); });
route('PUT', '/api/roles/levels', (ctx) => {
  const u = need(ctx, 'admin');
  const levels = savePackLevels(ctx.body.levels);
  audit(u.username, 'roles.levels', JSON.stringify(levels));
  return { levels };
});
route('POST', '/api/roles/detect', (ctx) => {
  const u = need(ctx, 'tech');
  const ids = Array.isArray(ctx.body.agent_ids) ? ctx.body.agent_ids.map(String) : null;
  const agents = (ids ? ids.map((id) => get('SELECT id, hostname, platform, last_seen FROM agents WHERE id=?', id)).filter(Boolean)
    : all('SELECT id, hostname, platform, last_seen FROM agents')).filter(isOnline);
  const r = queueRoleDetect(agents, u.username);
  return { created: r.created, batch_id: r.batch_id };
});

// ---------- patch manager ----------

route('GET', '/api/patch/meta', (ctx) => { need(ctx); return { categories: CATEGORIES, timezone: patchTimeZone() }; });
route('GET', '/api/patch/dashboard', (ctx) => { need(ctx); return patchDashboard(); });
route('GET', '/api/patch/devices', (ctx) => { need(ctx); return patchDevices(); });
route('GET', '/api/patch/approvals', (ctx) => { need(ctx); return approvalQueue(); });
route('POST', '/api/patch/approvals', (ctx) => {
  const u = need(ctx, 'tech');
  if (!Array.isArray(ctx.body.keys)) throw new HttpError(400, 'Pick some updates');
  return { changed: setApprovals(ctx.body.keys.map(String), String(ctx.body.status), u.username) };
});
route('GET', '/api/patch/policies', (ctx) => {
  need(ctx);
  return listPolicies().map((p) => ({ ...p, window: describeWindow(p),
    devices: all('SELECT id, platform, client_id, device_class, patch_override FROM agents').filter((a) => effectivePolicy(a).policy?.id === p.id).length }));
});
route('POST', '/api/patch/policies', (ctx) => {
  const u = need(ctx, 'admin');
  const v = cleanPatchPolicy(ctx.body);
  const pos = (get('SELECT MAX(position) AS m FROM patch_policies').m ?? -1) + 1;
  const r = run('INSERT INTO patch_policies(name, position, enabled, target, schedule, options, reboot, approval, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    v.name, pos, v.enabled, JSON.stringify(v.target), JSON.stringify(v.schedule), JSON.stringify(v.options), JSON.stringify(v.reboot), JSON.stringify(v.approval), Date.now(), Date.now());
  audit(u.username, 'patch.policy.create', v.name);
  return presentPatchPolicy(get('SELECT * FROM patch_policies WHERE id=?', r.lastInsertRowid));
});
route('PUT', '/api/patch/policies/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const p = get('SELECT * FROM patch_policies WHERE id=?', Number(ctx.params.id));
  if (!p) throw new HttpError(404, 'Patch policy not found');
  const v = cleanPatchPolicy(ctx.body);
  run('UPDATE patch_policies SET name=?, enabled=?, target=?, schedule=?, options=?, reboot=?, approval=?, updated_at=? WHERE id=?',
    v.name, v.enabled, JSON.stringify(v.target), JSON.stringify(v.schedule), JSON.stringify(v.options), JSON.stringify(v.reboot), JSON.stringify(v.approval), Date.now(), p.id);
  audit(u.username, 'patch.policy.update', v.name);
  return presentPatchPolicy(get('SELECT * FROM patch_policies WHERE id=?', p.id));
});
route('DELETE', '/api/patch/policies/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const p = get('SELECT * FROM patch_policies WHERE id=?', Number(ctx.params.id));
  if (!p) throw new HttpError(404, 'Patch policy not found');
  run('UPDATE agents SET patch_override=NULL WHERE patch_override=?', String(p.id));
  run('DELETE FROM patch_policies WHERE id=?', p.id);
  audit(u.username, 'patch.policy.delete', p.name);
  return { ok: true };
});
route('POST', '/api/patch/policies/order', (ctx) => {
  const u = need(ctx, 'admin');
  const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(Number);
  tx(() => ids.forEach((id, i) => run('UPDATE patch_policies SET position=? WHERE id=?', i, id)));
  audit(u.username, 'patch.policy.order', ids.join(','));
  return { ok: true };
});
route('GET', '/api/agents/:id/patch', (ctx) => {
  need(ctx);
  const a = loadAgent(ctx.params.id);
  const eff = effectivePolicy(a);
  const manual = manualApprovals();
  return {
    override: a.patch_override, source: eff.source, wsus: !!a.wsus,
    policy: eff.policy ? { id: eff.policy.id, name: eff.policy.name, schedule: eff.policy.schedule, reboot: eff.policy.reboot, options: eff.policy.options, approval: eff.policy.approval, window: describeWindow(eff.policy) } : null,
    policies: listPolicies().map((p) => ({ id: p.id, name: p.name })),
    updates: all('SELECT uid, kb, title, severity, category, size FROM updates WHERE agent_id=? ORDER BY title', a.id)
      .map((u) => ({ ...u, key: ukey(a.platform, u), group: categorize(u), ...approvalFor(u, a.platform, eff.policy, manual) })),
  };
});
route('POST', '/api/agents/:id/patch/install-approved', async (ctx) => {
  const u = need(ctx, 'tech');
  const a = loadAgent(ctx.params.id);
  const eff = effectivePolicy(a);
  const manual = manualApprovals();
  const ids = all('SELECT uid, kb, title, severity, category FROM updates WHERE agent_id=?', a.id)
    .filter((x) => approvalFor(x, a.platform, eff.policy, manual).status === 'approved').map((x) => x.uid);
  if (!ids.length) throw new HttpError(400, 'No approved updates are waiting on this device');
  const mode = eff.policy?.reboot?.mode;
  return runTask(u, a, 'updates.install', { ids, reboot: mode === 'auto' || mode === 'notify', reboot_delay: mode === 'notify' ? eff.policy.reboot.delay : 2, restore: !!eff.policy?.options?.restore_point }, { wait: false });
});

// ---------- executive report ----------

route('GET', '/api/reports/executive', (ctx) => {
  need(ctx);
  const cid = ctx.query.get('client_id') ? Number(ctx.query.get('client_id')) : null;
  const client = cid ? get('SELECT id, name FROM clients WHERE id=?', cid) : null;
  if (cid && !client) throw new HttpError(404, 'Client not found');
  const s = getSettings();
  const agents = all(`${AGENT_SELECT} ${cid ? 'WHERE a.client_id=?' : ''} ORDER BY a.hostname COLLATE NOCASE`, ...(cid ? [cid] : [])).map(presentAgent);
  const ids = new Set(agents.map((a) => a.id));
  const inSet = (rows) => rows.filter((r) => ids.has(r.agent_id));
  const since30 = Date.now() - 30 * 86400000;
  const alerts30 = inSet(all('SELECT agent_id, severity, type, status FROM alerts WHERE created_at > ?', since30));
  const openAlerts = inSet(all("SELECT agent_id, severity, message, created_at FROM alerts WHERE status IN ('open','ack')"));
  const pd = patchDevices().filter((d) => ids.has(d.id));
  const scanned = pd.filter((d) => d.updates_checked_at);
  const pr = inSet(all('SELECT agent_id, status FROM policy_results'));
  const prPass = pr.filter((r) => r.status === 'pass' || r.status === 'fixed').length, prFail = pr.filter((r) => r.status === 'fail' || r.status === 'error').length;
  const roles = roleDashboard(isOnline).packs.map((p) => ({ ...p, devices: p.devices.filter((d) => ids.has(d.id)) })).filter((p) => p.devices.length);
  const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    generated_at: Date.now(), client: client || null,
    devices: {
      total: agents.length, online: agents.filter((a) => a.online).length,
      by_class: count(agents, (a) => a.device_class), by_platform: count(agents, (a) => a.platform),
      stale: agents.filter((a) => !a.online && a.last_seen < Date.now() - 30 * 86400000).length,
    },
    alerts: { last_30_days: alerts30.length, by_severity_30: count(alerts30, (a) => a.severity), open: openAlerts.length, open_by_severity: count(openAlerts, (a) => a.severity) },
    patching: {
      compliance: scanned.length ? Math.round((scanned.filter((d) => d.compliant).length / scanned.length) * 100) : null,
      scanned: scanned.length, security_pending: pd.reduce((n, d) => n + (d.security_updates || 0), 0),
      pending: pd.reduce((n, d) => n + (d.pending_updates || 0), 0), reboot_required: pd.filter((d) => d.reboot_required).length,
      no_policy: pd.filter((d) => !d.policy).length,
    },
    policies: { checks: pr.length, passed: prPass, failed: prFail, compliance: pr.length ? Math.round((prPass / pr.length) * 100) : null },
    disks: agents.flatMap((a) => (a.disks || []).filter((d) => d.total > 0 && (d.total - d.free) / d.total * 100 >= s.disk_threshold)
      .map((d) => ({ hostname: a.hostname, mount: d.mount, pct: Math.round(((d.total - d.free) / d.total) * 100), free: d.free }))),
    roles: roles.map((p) => ({ id: p.id, label: p.label, devices: p.devices.length, failed: p.devices.filter((d) => d.state === 'failed').length })),
    top_alerts: Object.entries(count(openAlerts, (a) => a.agent_id)).sort((x, y) => y[1] - x[1]).slice(0, 10)
      .map(([id, n]) => ({ id, hostname: agents.find((a) => a.id === id)?.hostname || id, open: n })),
    inventory: agents.map((a) => ({ hostname: a.hostname, client: a.client_name, class: a.device_class, os: a.os_name, model: [a.manufacturer, a.model].filter(Boolean).join(' '),
      serial: a.serial, online: a.online, last_seen: a.last_seen, user: a.logged_user, contact: a.contact_name })),
  };
});

// ---------- Android app ----------
// The app signs in through the normal console (WebView), then registers for a notification token.
// That token can only read the notification feed below, so a lost phone can't drive devices with it.

function mobileDevice(ctx) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(String(ctx.req.headers.authorization || ''));
  const d = m && get(`SELECT d.token_hash, u.id, u.username, u.role FROM mobile_devices d JOIN users u ON u.id=d.user_id
                      WHERE d.token_hash=?`, sha256(m[1]));
  if (!d) throw new HttpError(401, 'This phone is no longer registered. Open the app and sign in again.');
  run('UPDATE mobile_devices SET last_seen=? WHERE token_hash=?', Date.now(), d.token_hash);
  return d;
}

route('POST', '/api/mobile/register', (ctx) => {
  const u = need(ctx);
  const name = String(ctx.body.name || 'Android phone').replace(/[\r\n\t]/g, ' ').slice(0, 80);
  const tok = randHex(32);
  // one token per phone: re-registering the same phone (same install id) replaces its old token
  const install = String(ctx.body.install_id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (install) run('DELETE FROM mobile_devices WHERE user_id=? AND name LIKE ?', u.id, `%[${install}]`);
  run('INSERT INTO mobile_devices(token_hash, user_id, name, created_at, last_seen) VALUES(?,?,?,?,?)',
    sha256(tok), u.id, install ? `${name} [${install}]` : name, Date.now(), Date.now());
  audit(u.username, 'mobile.register', name);
  const lastAlert = get('SELECT MAX(id) AS n FROM alerts').n || 0;
  const lastChat = get('SELECT MAX(id) AS n FROM chat_messages').n || 0;
  return { token: tok, alerts_after: lastAlert, chat_after: lastChat };
});

route('DELETE', '/api/mobile/register', (ctx) => {
  const d = mobileDevice(ctx);
  run('DELETE FROM mobile_devices WHERE token_hash=?', d.token_hash);
  return { ok: true };
});

route('GET', '/api/mobile/notifications', (ctx) => {
  mobileDevice(ctx);
  const alertsAfter = clampInt(ctx.query.get('alerts_after'), 0, Number.MAX_SAFE_INTEGER, 0);
  const chatAfter = clampInt(ctx.query.get('chat_after'), 0, Number.MAX_SAFE_INTEGER, 0);
  const alerts = all(`SELECT al.id, al.agent_id, a.hostname, al.severity, al.type, al.message, al.created_at
                      FROM alerts al JOIN agents a ON a.id=al.agent_id
                      WHERE al.id>? AND al.status='open' ORDER BY al.id LIMIT 20`, alertsAfter);
  const chat = all(`SELECT m.id, m.agent_id, a.hostname, m.author, m.body, m.created_at
                    FROM chat_messages m JOIN agents a ON a.id=m.agent_id
                    WHERE m.id>? AND m.direction='user' AND m.read_at IS NULL ORDER BY m.id LIMIT 20`, chatAfter);
  return {
    alerts, chat,
    alerts_after: Math.max(alertsAfter, ...alerts.map((x) => x.id)),
    chat_after: Math.max(chatAfter, ...chat.map((x) => x.id)),
    open_alerts: get("SELECT COUNT(*) AS n FROM alerts WHERE status='open'").n,
    unread_chat: get("SELECT COUNT(*) AS n FROM chat_messages WHERE direction='user' AND read_at IS NULL").n,
  };
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
