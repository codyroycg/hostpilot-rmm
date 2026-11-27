// Console API for ticketing, custom monitors, IT documentation & password vault, warranty tracking, API keys
// and end-user portal access.
import { route } from './router.js';
import { all, get, run, audit } from './db.js';
import { HttpError, randHex, sha256, hashPassword } from './util.js';
import { need, loadAgent, pubContact } from './api-routes.js';
import { STATUSES, PRIORITIES, createTicket, addComment, updateTicket, listTickets, getTicket, ticketCounts } from './tickets.js';
import { TYPES, SEVERITIES, TEMPLATES, cleanMonitor, monitorOverview, deleteMonitor, presentMonitor } from './monitors.js';
import { seal, open } from './vault.js';
import { checkWarranty } from './tasks.js';

const ROLE_RANK = { viewer: 1, tech: 2, admin: 3 };
const optInt = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// ---------- tickets ----------

route('GET', '/api/tickets/meta', (ctx) => {
  const u = need(ctx);
  return { statuses: STATUSES, priorities: PRIORITIES, technicians: all("SELECT username FROM users WHERE role IN ('tech','admin') ORDER BY username").map((r) => r.username), counts: ticketCounts(u.username) };
});
route('GET', '/api/tickets', (ctx) => {
  const u = need(ctx);
  const q = ctx.query;
  return listTickets({ status: q.get('status') || 'active', client_id: q.get('client_id'), agent_id: q.get('agent_id'),
    assignee: q.get('assignee') === 'me' ? u.username : q.get('assignee'), q: String(q.get('q') || '').slice(0, 100) });
});
route('POST', '/api/tickets', (ctx) => {
  const u = need(ctx, 'tech');
  const b = ctx.body;
  const id = createTicket({ subject: b.subject, body: b.body, client_id: optInt(b.client_id), agent_id: b.agent_id ? String(b.agent_id) : null,
    contact_id: optInt(b.contact_id), priority: b.priority, assignee: b.assignee === 'me' ? u.username : b.assignee || null, source: 'tech', created_by: u.username });
  audit(u.username, 'ticket.create', `#${id} ${String(b.subject || '').slice(0, 100)}`);
  return getTicket(id);
});
route('GET', '/api/tickets/:id', (ctx) => { need(ctx); return getTicket(ctx.params.id); });
route('PUT', '/api/tickets/:id', (ctx) => {
  const u = need(ctx, 'tech');
  updateTicket(Number(ctx.params.id), ctx.body, u.username);
  return getTicket(ctx.params.id);
});
route('POST', '/api/tickets/:id/comments', (ctx) => {
  const u = need(ctx, 'tech');
  addComment(Number(ctx.params.id), { author: u.username, author_kind: 'tech', body: ctx.body.body, internal: !!ctx.body.internal });
  if (ctx.body.status) updateTicket(Number(ctx.params.id), { status: ctx.body.status }, u.username);
  return getTicket(ctx.params.id);
});
route('DELETE', '/api/tickets/:id', (ctx) => {
  const u = need(ctx, 'admin');
  const tk = getTicket(ctx.params.id);
  run('DELETE FROM tickets WHERE id=?', tk.id);
  audit(u.username, 'ticket.delete', `#${tk.id} ${tk.subject}`);
  return { ok: true };
});
route('POST', '/api/tickets/from-alert/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const al = get('SELECT al.*, a.hostname, a.client_id FROM alerts al JOIN agents a ON a.id=al.agent_id WHERE al.id=?', Number(ctx.params.id));
  if (!al) throw new HttpError(404, 'Alert not found');
  const existing = get('SELECT id FROM tickets WHERE alert_id=?', al.id);
  if (existing) return getTicket(existing.id);
  const id = createTicket({ subject: `${al.hostname}: ${al.message}`, body: `Created from a ${al.severity} alert raised ${new Date(al.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.\n\n${al.message}`,
    agent_id: al.agent_id, priority: al.severity === 'critical' ? 'high' : 'normal', source: 'alert', alert_id: al.id, created_by: u.username, assignee: u.username });
  audit(u.username, 'ticket.create', `#${id} from alert ${al.id}`);
  return getTicket(id);
});

// ---------- custom monitors ----------

route('GET', '/api/monitors', (ctx) => {
  need(ctx);
  return { types: TYPES, severities: SEVERITIES, templates: TEMPLATES, monitors: monitorOverview() };
});
function saveMonitor(ctx, id) {
  const u = need(ctx, 'admin');
  const v = cleanMonitor(ctx.body);
  const t = Date.now();
  if (id) {
    const m = get('SELECT * FROM monitors WHERE id=?', Number(id));
    if (!m) throw new HttpError(404, 'Monitor not found');
    run('UPDATE monitors SET name=?, type=?, enabled=?, severity=?, target=?, params=?, actions=?, updated_at=? WHERE id=?', v.name, v.type, v.enabled, v.severity, v.target, v.params, v.actions, t, m.id);
    // condition or targets changed: start fresh (open alerts close, devices are re-checked)
    if (m.type !== v.type || m.params !== v.params || m.target !== v.target || !v.enabled) {
      run("UPDATE alerts SET status='resolved', resolved_at=?, updated_at=? WHERE type=? AND status IN ('open','ack')", t, t, `monitor:${m.id}`);
      run('DELETE FROM monitor_state WHERE monitor_id=?', m.id);
    }
    audit(u.username, 'monitor.update', v.name);
    return presentMonitor(get('SELECT * FROM monitors WHERE id=?', m.id));
  }
  const r = run('INSERT INTO monitors(name, type, enabled, severity, target, params, actions, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    v.name, v.type, v.enabled, v.severity, v.target, v.params, v.actions, u.username, t, t);
  audit(u.username, 'monitor.create', v.name);
  return presentMonitor(get('SELECT * FROM monitors WHERE id=?', r.lastInsertRowid));
}
route('POST', '/api/monitors', (ctx) => saveMonitor(ctx));
route('PUT', '/api/monitors/:id', (ctx) => saveMonitor(ctx, ctx.params.id));
route('DELETE', '/api/monitors/:id', (ctx) => { const u = need(ctx, 'admin'); deleteMonitor(ctx.params.id, u.username); return { ok: true }; });
route('POST', '/api/monitors/:id/check', (ctx) => {
  need(ctx, 'tech');
  run('UPDATE monitor_state SET last_job_at=NULL WHERE monitor_id=?', Number(ctx.params.id));
  return { ok: true };
});

// ---------- IT documentation ----------

const DOC_SELECT = `SELECT d.*, c.name AS client_name FROM doc_articles d LEFT JOIN clients c ON c.id=d.client_id`;
const presentDoc = (d) => ({ ...d, agent_ids: (() => { try { return JSON.parse(d.agent_ids || '[]'); } catch { return []; } })() });
route('GET', '/api/docs', (ctx) => {
  need(ctx);
  const cid = ctx.query.get('client_id'), aid = ctx.query.get('agent_id');
  let list = all(`${DOC_SELECT} ${cid === 'global' ? 'WHERE d.client_id IS NULL' : cid ? 'WHERE d.client_id=? OR d.client_id IS NULL' : ''} ORDER BY d.category, d.title COLLATE NOCASE`, ...(cid && cid !== 'global' ? [Number(cid)] : [])).map(presentDoc);
  if (aid) {
    const a = loadAgent(aid);
    list = list.filter((d) => d.agent_ids.includes(a.id) || (d.client_id && d.client_id === a.client_id && !d.agent_ids.length));
  }
  return list;
});
route('GET', '/api/docs/:id', (ctx) => {
  need(ctx);
  const d = get(`${DOC_SELECT} WHERE d.id=?`, Number(ctx.params.id));
  if (!d) throw new HttpError(404, 'Article not found');
  const doc = presentDoc(d);
  doc.devices = doc.agent_ids.length ? all(`SELECT id, hostname, platform FROM agents WHERE id IN (${doc.agent_ids.map(() => '?').join(',')})`, ...doc.agent_ids) : [];
  return doc;
});
function cleanDoc(b) {
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) throw new HttpError(400, 'Title is required');
  const clientId = optInt(b.client_id);
  if (clientId && !get('SELECT id FROM clients WHERE id=?', clientId)) throw new HttpError(400, 'Unknown client');
  const agents = (Array.isArray(b.agent_ids) ? b.agent_ids : []).map(String).filter((x) => get('SELECT id FROM agents WHERE id=?', x)).slice(0, 200);
  return { title, client_id: clientId, body: String(b.body || '').slice(0, 200000), category: String(b.category || '').trim().slice(0, 60), agent_ids: JSON.stringify(agents) };
}
route('POST', '/api/docs', (ctx) => {
  const u = need(ctx, 'tech');
  const v = cleanDoc(ctx.body);
  const t = Date.now();
  const r = run('INSERT INTO doc_articles(client_id, title, body, category, agent_ids, updated_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)', v.client_id, v.title, v.body, v.category, v.agent_ids, u.username, t, t);
  audit(u.username, 'doc.create', v.title);
  return presentDoc(get(`${DOC_SELECT} WHERE d.id=?`, r.lastInsertRowid));
});
route('PUT', '/api/docs/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const d = get('SELECT * FROM doc_articles WHERE id=?', Number(ctx.params.id));
  if (!d) throw new HttpError(404, 'Article not found');
  const v = cleanDoc({ ...presentDoc(d), ...ctx.body });
  run('UPDATE doc_articles SET client_id=?, title=?, body=?, category=?, agent_ids=?, updated_by=?, updated_at=? WHERE id=?', v.client_id, v.title, v.body, v.category, v.agent_ids, u.username, Date.now(), d.id);
  audit(u.username, 'doc.update', v.title);
  return presentDoc(get(`${DOC_SELECT} WHERE d.id=?`, d.id));
});
route('DELETE', '/api/docs/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const d = get('SELECT * FROM doc_articles WHERE id=?', Number(ctx.params.id));
  if (!d) throw new HttpError(404, 'Article not found');
  run('DELETE FROM doc_articles WHERE id=?', d.id);
  audit(u.username, 'doc.delete', d.title);
  return { ok: true };
});

// ---------- password vault (tech role; every reveal is audited) ----------

const CRED_SELECT = `SELECT cr.id, cr.client_id, cr.agent_id, cr.name, cr.username, cr.url, cr.notes, cr.updated_by, cr.created_at, cr.updated_at,
  cr.secret IS NOT NULL AS has_secret, c.name AS client_name, a.hostname FROM credentials cr LEFT JOIN clients c ON c.id=cr.client_id LEFT JOIN agents a ON a.id=cr.agent_id`;
route('GET', '/api/credentials', (ctx) => {
  need(ctx, 'tech');
  const cid = ctx.query.get('client_id'), aid = ctx.query.get('agent_id');
  const where = [], p = [];
  if (cid) { where.push('cr.client_id=?'); p.push(Number(cid)); }
  if (aid) { where.push('cr.agent_id=?'); p.push(String(aid)); }
  return all(`${CRED_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.name, cr.name COLLATE NOCASE`, ...p).map((c) => ({ ...c, has_secret: !!c.has_secret }));
});
function cleanCred(b, prev) {
  const name = String(b.name || '').trim().slice(0, 150);
  if (!name) throw new HttpError(400, 'Name is required');
  let clientId = optInt(b.client_id);
  const agentId = b.agent_id ? String(b.agent_id) : null;
  if (agentId) { const a = get('SELECT client_id FROM agents WHERE id=?', agentId); if (!a) throw new HttpError(400, 'Device not found'); clientId = a.client_id ?? clientId; }
  if (!clientId || !get('SELECT id FROM clients WHERE id=?', clientId)) throw new HttpError(400, 'Pick a client');
  const url = String(b.url || '').trim().slice(0, 500);
  if (url && !/^(https?|rdp|ssh|ftp|smb):\/\/|^[\w.-]+(:\d+)?(\/.*)?$/i.test(url)) throw new HttpError(400, 'That URL looks wrong');
  return {
    name, client_id: clientId, agent_id: agentId, username: String(b.username || '').slice(0, 200), url, notes: String(b.notes || '').slice(0, 5000),
    // secret: undefined = keep, '' = clear
    secret: b.secret === undefined ? prev?.secret ?? null : seal(String(b.secret).slice(0, 5000)),
  };
}
route('POST', '/api/credentials', (ctx) => {
  const u = need(ctx, 'tech');
  const v = cleanCred(ctx.body);
  const t = Date.now();
  const r = run('INSERT INTO credentials(client_id, agent_id, name, username, secret, url, notes, updated_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    v.client_id, v.agent_id, v.name, v.username, v.secret, v.url, v.notes, u.username, t, t);
  audit(u.username, 'credential.create', v.name);
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/credentials/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const c = get('SELECT * FROM credentials WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Password not found');
  const v = cleanCred({ ...c, secret: undefined, ...ctx.body }, c);
  run('UPDATE credentials SET client_id=?, agent_id=?, name=?, username=?, secret=?, url=?, notes=?, updated_by=?, updated_at=? WHERE id=?',
    v.client_id, v.agent_id, v.name, v.username, v.secret, v.url, v.notes, u.username, Date.now(), c.id);
  audit(u.username, 'credential.update', v.name);
  return { ok: true };
});
route('POST', '/api/credentials/:id/reveal', (ctx) => {
  const u = need(ctx, 'tech');
  const c = get('SELECT cr.*, a.hostname FROM credentials cr LEFT JOIN agents a ON a.id=cr.agent_id WHERE cr.id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Password not found');
  let secret;
  try { secret = open(c.secret); } catch { throw new HttpError(500, "This password can't be decrypted: the vault key changed (VAULT_KEY or data/vault.key)"); }
  audit(u.username, 'credential.reveal', `${c.name}${c.hostname ? ` (${c.hostname})` : ''}`);
  return { secret };
});
route('DELETE', '/api/credentials/:id', (ctx) => {
  const u = need(ctx, 'tech');
  const c = get('SELECT * FROM credentials WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Password not found');
  run('DELETE FROM credentials WHERE id=?', c.id);
  audit(u.username, 'credential.delete', c.name);
  return { ok: true };
});

// ---------- warranty ----------

/** The vendor's own warranty-check page for a serial number (opens in the browser; no API key needed). */
export function warrantyLookup(manufacturer, serial) {
  const m = String(manufacturer || '').toLowerCase(), s = encodeURIComponent(String(serial || '').trim());
  if (!s || /^(0+|to be filled.*|default string|system serial number|none)$/i.test(String(serial).trim())) return null;
  if (m.includes('dell')) return `https://www.dell.com/support/home/product-support/servicetag/${s}/overview`;
  if (m.includes('lenovo')) return `https://pcsupport.lenovo.com/products/${s}/warranty`;
  if (m.includes('hp') || m.includes('hewlett')) return 'https://support.hp.com/checkwarranty';
  if (m.includes('apple')) return 'https://checkcoverage.apple.com/';
  if (m.includes('microsoft')) return 'https://mybusinessservice.surface.com/';
  if (m.includes('asus')) return 'https://www.asus.com/support/warranty-status-inquiry/';
  if (m.includes('acer')) return 'https://www.acer.com/us-en/support/warranty';
  return null;
}
route('GET', '/api/warranty', (ctx) => {
  need(ctx);
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  return all(`SELECT a.id, a.hostname, a.platform, a.device_class, a.manufacturer, a.model, a.serial, a.purchase_date, a.warranty_end, a.warranty_note,
                a.enrolled_at, a.last_seen, c.name AS client_name, a.client_id FROM agents a LEFT JOIN clients c ON c.id=a.client_id ORDER BY a.hostname COLLATE NOCASE`).map((a) => {
    const days = a.warranty_end ? Math.round((Date.parse(a.warranty_end) - today) / 86400000) : null;
    const age = a.purchase_date ? Math.floor((today - Date.parse(a.purchase_date)) / (365.25 * 86400000) * 10) / 10 : null;
    return { ...a, days_left: days, age_years: age, status: days == null ? 'unknown' : days < 0 ? 'expired' : days <= 90 ? 'expiring' : 'active', lookup_url: warrantyLookup(a.manufacturer, a.serial) };
  });
});
route('POST', '/api/warranty/import', (ctx) => {
  const u = need(ctx, 'tech');
  const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows.slice(0, 20000) : [];
  const date = (v) => { const s = String(v || '').trim(); if (!s) return undefined; const d = new Date(s); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : undefined; };
  let updated = 0; const unmatched = [];
  for (const r of rows) {
    const key = String(r.serial || r.hostname || '').trim();
    if (!key) continue;
    // every device with that serial (a reinstalled machine can be enrolled twice) or that hostname
    const matches = all('SELECT id FROM agents WHERE (lower(serial)=lower(?) AND length(serial) > 3) OR lower(hostname)=lower(?)', key, key);
    if (!matches.length) { unmatched.push(key); continue; }
    const w = date(r.warranty_end), p = date(r.purchase_date);
    for (const a of matches) {
      if (w) run('UPDATE agents SET warranty_end=? WHERE id=?', w, a.id);
      if (p) run('UPDATE agents SET purchase_date=? WHERE id=?', p, a.id);
      if (r.note) run('UPDATE agents SET warranty_note=? WHERE id=?', String(r.note).slice(0, 300), a.id);
      if (w || p || r.note) updated++;
    }
  }
  checkWarranty();
  audit(u.username, 'warranty.import', `${updated} device(s)`);
  return { updated, unmatched: unmatched.slice(0, 100), unmatched_count: unmatched.length };
});

// ---------- API keys (personal, for scripts and integrations) ----------

route('GET', '/api/me/api-keys', (ctx) => {
  const u = need(ctx);
  return all('SELECT id, name, role, prefix, created_at, last_used, expires_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC', u.id);
});
route('POST', '/api/me/api-keys', (ctx) => {
  const u = need(ctx);
  if (u.api_key) throw new HttpError(403, 'API keys cannot create other API keys');
  const name = String(ctx.body.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Give the key a name, like "Backup script"');
  const role = ROLE_RANK[ctx.body.role] ? ctx.body.role : u.role;
  if (ROLE_RANK[role] > ROLE_RANK[u.role]) throw new HttpError(403, "A key can't have more rights than you");
  const days = Math.max(0, Math.min(3650, Math.round(Number(ctx.body.expires_days) || 0)));
  if (get('SELECT COUNT(*) AS n FROM api_keys WHERE user_id=?', u.id).n >= 25) throw new HttpError(400, 'You already have 25 keys');
  const token = `hpk_${randHex(20)}`;
  run('INSERT INTO api_keys(user_id, name, role, token_hash, prefix, created_at, expires_at) VALUES(?,?,?,?,?,?,?)',
    u.id, name, role, sha256(token), token.slice(0, 10), Date.now(), days ? Date.now() + days * 86400000 : null);
  audit(u.username, 'apikey.create', `${name} (${role})`);
  return { token, name, role };
});
route('DELETE', '/api/me/api-keys/:id', (ctx) => {
  const u = need(ctx);
  const k = get('SELECT * FROM api_keys WHERE id=? AND (user_id=? OR ?)', Number(ctx.params.id), u.id, u.role === 'admin' ? 1 : 0);
  if (!k) throw new HttpError(404, 'Key not found');
  run('DELETE FROM api_keys WHERE id=?', k.id);
  audit(u.username, 'apikey.delete', k.name);
  return { ok: true };
});

// ---------- end-user portal access (set on a contact) ----------

route('PUT', '/api/contacts/:id/portal', (ctx) => {
  const u = need(ctx, 'tech');
  const c = get('SELECT * FROM contacts WHERE id=?', Number(ctx.params.id));
  if (!c) throw new HttpError(404, 'Contact not found');
  const b = ctx.body;
  if (b.enabled === false) {
    run('UPDATE contacts SET portal_hash=NULL WHERE id=?', c.id);
    run('DELETE FROM portal_sessions WHERE contact_id=?', c.id);
    audit(u.username, 'portal.disable', c.name);
    return pubContact(get('SELECT * FROM contacts WHERE id=?', c.id));
  }
  if (!c.email) throw new HttpError(400, 'The contact needs an email address: they sign in with it');
  if (get('SELECT id FROM contacts WHERE lower(email)=lower(?) AND id!=? AND portal_hash IS NOT NULL', c.email, c.id)) throw new HttpError(409, 'Another contact with this email already has portal access');
  if (b.password) {
    if (String(b.password).length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
    run('UPDATE contacts SET portal_hash=? WHERE id=?', hashPassword(String(b.password)), c.id);
    run('DELETE FROM portal_sessions WHERE contact_id=?', c.id);
  } else if (!c.portal_hash) throw new HttpError(400, 'Set a password for the portal');
  if (b.all !== undefined) run('UPDATE contacts SET portal_all=? WHERE id=?', b.all ? 1 : 0, c.id);
  audit(u.username, 'portal.enable', c.name);
  return pubContact(get('SELECT * FROM contacts WHERE id=?', c.id));
});
