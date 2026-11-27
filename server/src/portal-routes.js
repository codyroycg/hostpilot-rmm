// End-user self-service portal (/portal): contacts with portal access sign in with their email and see their
// devices and tickets, open new tickets and reply. Contacts with "sees everything" see their whole company.
import { route, clientIp } from './router.js';
import { all, get, run, audit, getSettings } from './db.js';
import { HttpError, randHex, sha256, verifyPassword, hashPassword } from './util.js';
import { isPolling } from './jobs.js';
import { createTicket, addComment, listTickets, getTicket } from './tickets.js';

const COOKIE = 'hp_portal';
const TTL = 8 * 3600 * 1000;
const failures = new Map();

function cookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const secure = (req) => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').startsWith('https');

function enabled() { if (!getSettings().portal_enabled) throw new HttpError(404, 'The support portal is turned off'); }

function contact(ctx) {
  enabled();
  const tok = cookie(ctx.req);
  const s = tok && get(`SELECT c.*, s.expires_at, cl.name AS client_name FROM portal_sessions s JOIN contacts c ON c.id=s.contact_id
                        LEFT JOIN clients cl ON cl.id=c.client_id WHERE s.token_hash=?`, sha256(tok));
  if (!s || s.expires_at < Date.now() || !s.portal_hash) throw new HttpError(401, 'Not signed in');
  if (s.expires_at - Date.now() < TTL / 2) run('UPDATE portal_sessions SET expires_at=? WHERE token_hash=?', Date.now() + TTL, sha256(tok));
  return s;
}

/** Devices this contact may see. */
function devicesOf(c) {
  return c.portal_all
    ? all('SELECT * FROM agents WHERE client_id=? ORDER BY hostname COLLATE NOCASE', c.client_id)
    : all('SELECT * FROM agents WHERE contact_id=? ORDER BY hostname COLLATE NOCASE', c.id);
}
function ownTicket(c, id) {
  const tk = getTicket(id, { includeInternal: false });
  const mine = c.portal_all ? tk.client_id === c.client_id : tk.contact_id === c.id;
  if (!mine) throw new HttpError(404, 'Ticket not found');
  return tk;
}
const publicTicket = (t) => ({
  id: t.id, subject: t.subject, status: t.status, priority: t.priority, hostname: t.hostname, contact_name: t.contact_name,
  created_at: t.created_at, updated_at: t.updated_at, resolved_at: t.resolved_at, comments: t.comments,
  thread: t.thread?.map((m) => ({ id: m.id, author: m.author_kind === 'tech' ? `${m.author} (IT support)` : m.author, mine: m.author_kind === 'contact', body: m.body, created_at: m.created_at })),
});

route('POST', '/api/portal/login', (ctx) => {
  enabled();
  const ip = clientIp(ctx.req);
  const f = failures.get(ip);
  if (f && f.count >= 8 && f.until > Date.now()) throw new HttpError(429, 'Too many failed sign-ins. Try again in 15 minutes.');
  const email = String(ctx.body.email || '').trim();
  const c = email && get('SELECT * FROM contacts WHERE lower(email)=lower(?) AND portal_hash IS NOT NULL', email);
  if (!c || !verifyPassword(String(ctx.body.password || ''), c.portal_hash)) {
    const cur = f && f.until > Date.now() ? f : { count: 0 };
    failures.set(ip, { count: cur.count + 1, until: Date.now() + 15 * 60000 });
    audit(`portal:${email || '?'}`, 'portal.login.failed', ip);
    throw new HttpError(401, 'Wrong email or password');
  }
  failures.delete(ip);
  const tok = randHex(32);
  run('INSERT INTO portal_sessions(token_hash, contact_id, expires_at) VALUES(?,?,?)', sha256(tok), c.id, Date.now() + TTL);
  run('UPDATE contacts SET portal_login=? WHERE id=?', Date.now(), c.id);
  audit(`portal:${c.email}`, 'portal.login', ip);
  ctx.res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict${secure(ctx.req) ? '; Secure' : ''}; Max-Age=${TTL / 1000}`);
  return { ok: true };
});
route('POST', '/api/portal/logout', (ctx) => {
  const tok = cookie(ctx.req);
  if (tok) run('DELETE FROM portal_sessions WHERE token_hash=?', sha256(tok));
  ctx.res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return { ok: true };
});
route('GET', '/api/portal/me', (ctx) => {
  const c = contact(ctx);
  return { name: c.name, email: c.email, client_name: c.client_name, all: !!c.portal_all };
});
route('POST', '/api/portal/password', (ctx) => {
  const c = contact(ctx);
  if (!verifyPassword(String(ctx.body.current || ''), c.portal_hash)) throw new HttpError(400, 'Your current password is wrong');
  if (String(ctx.body.password || '').length < 10) throw new HttpError(400, 'The new password must be at least 10 characters');
  run('UPDATE contacts SET portal_hash=? WHERE id=?', hashPassword(String(ctx.body.password)), c.id);
  return { ok: true };
});
route('GET', '/api/portal/devices', (ctx) => {
  const c = contact(ctx);
  return devicesOf(c).map((a) => {
    const disks = (() => { try { return JSON.parse(a.disks || '[]'); } catch { return []; } })();
    return {
      id: a.id, hostname: a.hostname, platform: a.platform, os_name: a.os_name, model: [a.manufacturer, a.model].filter(Boolean).join(' '),
      serial: a.serial, logged_user: a.logged_user, last_seen: a.last_seen, warranty_end: a.warranty_end,
      online: isPolling(a.id) || (a.last_seen && Date.now() - a.last_seen < 180000),
      pending_updates: a.pending_updates, reboot_required: !!a.reboot_required,
      disk_free: disks.filter((d) => d.total > 0).map((d) => ({ mount: d.mount, pct: Math.round(((d.total - d.free) / d.total) * 100) })),
    };
  });
});
route('GET', '/api/portal/tickets', (ctx) => {
  const c = contact(ctx);
  const status = ctx.query.get('status') === 'all' ? 'all' : 'active';
  return listTickets({ status, contact: c }).map(publicTicket);
});
route('GET', '/api/portal/tickets/:id', (ctx) => publicTicket(ownTicket(contact(ctx), ctx.params.id)));
route('POST', '/api/portal/tickets', (ctx) => {
  const c = contact(ctx);
  const b = ctx.body;
  let agentId = null;
  if (b.agent_id) {
    if (!devicesOf(c).some((a) => a.id === String(b.agent_id))) throw new HttpError(400, 'Pick one of your devices');
    agentId = String(b.agent_id);
  }
  if (!String(b.body || '').trim()) throw new HttpError(400, 'Describe the problem');
  const id = createTicket({ subject: b.subject, body: b.body, client_id: c.client_id, agent_id: agentId, contact_id: c.id,
    priority: b.urgent ? 'high' : 'normal', source: 'portal', created_by: c.name, author_kind: 'contact' });
  return publicTicket(ownTicket(c, id));
});
route('POST', '/api/portal/tickets/:id/comments', (ctx) => {
  const c = contact(ctx);
  const tk = ownTicket(c, ctx.params.id);
  if (tk.status === 'closed') throw new HttpError(400, 'This ticket is closed. Open a new one.');
  addComment(tk.id, { author: c.name, author_kind: 'contact', body: ctx.body.body });
  return publicTicket(ownTicket(c, tk.id));
});
route('POST', '/api/portal/tickets/:id/resolve', (ctx) => {
  const c = contact(ctx);
  const tk = ownTicket(c, ctx.params.id);
  const t = Date.now();
  run("UPDATE tickets SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", t, t, tk.id);
  run("INSERT INTO ticket_comments(ticket_id, author, author_kind, body, internal, created_at) VALUES(?,?,'system',?,1,?)", tk.id, c.name, `${c.name} marked the ticket as solved in the portal`, t);
  return publicTicket(ownTicket(c, tk.id));
});
