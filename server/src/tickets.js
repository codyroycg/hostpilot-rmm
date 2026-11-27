// Ticketing: tickets per client / device / contact with a comment thread. Opened by technicians, from alerts and
// monitors, or by end users in the self-service portal.
import { all, get, run, tx } from './db.js';
import { HttpError } from './util.js';
import { notify } from './notify.js';
import { deviceEvent } from './history.js';

export const STATUSES = [['new', 'New'], ['open', 'Open'], ['pending', 'Waiting on customer'], ['resolved', 'Resolved'], ['closed', 'Closed']];
export const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const STATUS_IDS = STATUSES.map(([s]) => s);
const PRIORITY_IDS = PRIORITIES.map(([p]) => p);
export const ACTIVE = "('new','open','pending')";

const clip = (v, n) => String(v ?? '').replace(/\0/g, '').slice(0, n);

export function createTicket({ subject, body = '', client_id = null, agent_id = null, contact_id = null, priority = 'normal', source = 'tech',
  alert_id = null, monitor_id = null, created_by = '', author_kind = 'tech', assignee = null }) {
  subject = clip(subject, 200).trim();
  if (!subject) throw new HttpError(400, 'Subject is required');
  if (!PRIORITY_IDS.includes(priority)) priority = 'normal';
  // the device decides the client when one is given
  if (agent_id) {
    const a = get('SELECT id, hostname, client_id FROM agents WHERE id=?', agent_id);
    if (!a) throw new HttpError(400, 'Device not found');
    client_id = a.client_id ?? client_id;
  }
  if (contact_id && !get('SELECT id FROM contacts WHERE id=?', contact_id)) contact_id = null;
  if (client_id && !get('SELECT id FROM clients WHERE id=?', client_id)) client_id = null;
  const t = Date.now();
  const id = tx(() => {
    const r = run(`INSERT INTO tickets(client_id, agent_id, contact_id, subject, status, priority, assignee, source, alert_id, monitor_id, created_by, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, client_id, agent_id, contact_id, subject, 'new', priority, assignee || null, source, alert_id, monitor_id, created_by, t, t);
    const tid = Number(r.lastInsertRowid);
    if (String(body).trim()) run('INSERT INTO ticket_comments(ticket_id, author, author_kind, body, internal, created_at) VALUES(?,?,?,?,0,?)', tid, created_by, author_kind, clip(body, 20000), t);
    return tid;
  });
  if (agent_id) deviceEvent(agent_id, 'ticket', `Ticket #${id} opened: ${subject}`);
  notify(`[TICKET #${id}] ${subject}${source === 'portal' ? ` (from ${created_by})` : ''}`, { ticket: { id, subject, priority, source } });
  return id;
}

export function addComment(ticketId, { author, author_kind = 'tech', body, internal = false }) {
  const tk = get('SELECT * FROM tickets WHERE id=?', ticketId);
  if (!tk) throw new HttpError(404, 'Ticket not found');
  const text = clip(body, 20000).trim();
  if (!text) throw new HttpError(400, 'Write something first');
  const t = Date.now();
  run('INSERT INTO ticket_comments(ticket_id, author, author_kind, body, internal, created_at) VALUES(?,?,?,?,?,?)', tk.id, author, author_kind, text, internal ? 1 : 0, t);
  // a customer reply re-opens a ticket that was waiting on them or resolved
  let status = tk.status;
  if (author_kind === 'contact' && ['pending', 'resolved'].includes(tk.status)) status = 'open';
  if (author_kind === 'tech' && !internal && tk.status === 'new') status = 'open';
  run('UPDATE tickets SET updated_at=?, status=?, resolved_at=CASE WHEN ? IN (\'resolved\',\'closed\') THEN resolved_at ELSE NULL END WHERE id=?', t, status, status, tk.id);
  if (author_kind === 'contact') notify(`[TICKET #${tk.id}] ${author} replied: ${text.slice(0, 300)}`, { ticket: { id: tk.id, subject: tk.subject } });
  return { ok: true };
}

/** Partial update by a technician: status, priority, assignee, subject, client, device, contact. */
export function updateTicket(id, b, username) {
  const tk = get('SELECT * FROM tickets WHERE id=?', id);
  if (!tk) throw new HttpError(404, 'Ticket not found');
  const set = {};
  if (b.status !== undefined) { if (!STATUS_IDS.includes(b.status)) throw new HttpError(400, 'Bad status'); set.status = b.status; }
  if (b.priority !== undefined) { if (!PRIORITY_IDS.includes(b.priority)) throw new HttpError(400, 'Bad priority'); set.priority = b.priority; }
  if (b.assignee !== undefined) {
    const as = b.assignee ? String(b.assignee) : null;
    if (as && !get('SELECT id FROM users WHERE username=?', as)) throw new HttpError(400, 'Unknown technician');
    set.assignee = as;
  }
  if (b.subject !== undefined) { set.subject = clip(b.subject, 200).trim(); if (!set.subject) throw new HttpError(400, 'Subject is required'); }
  if (b.agent_id !== undefined) {
    set.agent_id = b.agent_id ? String(b.agent_id) : null;
    if (set.agent_id) { const a = get('SELECT client_id FROM agents WHERE id=?', set.agent_id); if (!a) throw new HttpError(400, 'Device not found'); if (a.client_id) set.client_id = a.client_id; }
  }
  if (b.client_id !== undefined && set.client_id === undefined) set.client_id = b.client_id ? Number(b.client_id) : null;
  if (b.contact_id !== undefined) set.contact_id = b.contact_id ? Number(b.contact_id) : null;
  const keys = Object.keys(set);
  if (!keys.length) return tk;
  const t = Date.now();
  if (set.status) set.resolved_at = ['resolved', 'closed'].includes(set.status) ? (tk.resolved_at || t) : null;
  const all_ = Object.keys(set);
  run(`UPDATE tickets SET ${all_.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...all_.map((k) => set[k]), t, tk.id);
  const changes = [];
  if (set.status && set.status !== tk.status) changes.push(`status → ${STATUSES.find(([s]) => s === set.status)[1]}`);
  if (set.priority && set.priority !== tk.priority) changes.push(`priority → ${set.priority}`);
  if (b.assignee !== undefined && set.assignee !== tk.assignee) changes.push(set.assignee ? `assigned to ${set.assignee}` : 'unassigned');
  if (changes.length) run("INSERT INTO ticket_comments(ticket_id, author, author_kind, body, internal, created_at) VALUES(?,?,'system',?,1,?)", tk.id, username, `${username}: ${changes.join(', ')}`, t);
  return get('SELECT * FROM tickets WHERE id=?', tk.id);
}

const TICKET_SELECT = `SELECT t.*, c.name AS client_name, a.hostname, ct.name AS contact_name, ct.email AS contact_email,
  (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id=t.id AND tc.author_kind!='system') AS comments,
  (SELECT MAX(created_at) FROM ticket_comments tc WHERE tc.ticket_id=t.id AND tc.author_kind='contact') AS last_customer_reply
  FROM tickets t LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN agents a ON a.id=t.agent_id LEFT JOIN contacts ct ON ct.id=t.contact_id`;

export function listTickets({ status = 'active', client_id = null, agent_id = null, assignee = null, contact = null, q = '' } = {}) {
  const where = [], p = [];
  if (status === 'active') where.push(`t.status IN ${ACTIVE}`);
  else if (status && status !== 'all') { where.push('t.status=?'); p.push(status); }
  if (client_id) { where.push('t.client_id=?'); p.push(Number(client_id)); }
  if (agent_id) { where.push('t.agent_id=?'); p.push(String(agent_id)); }
  if (assignee === '-') where.push('t.assignee IS NULL');
  else if (assignee) { where.push('t.assignee=?'); p.push(String(assignee)); }
  if (contact) { where.push(contact.portal_all ? 't.client_id=?' : 't.contact_id=?'); p.push(contact.portal_all ? contact.client_id : contact.id); }
  if (q) { where.push("(t.subject LIKE ? OR CAST(t.id AS TEXT)=? OR a.hostname LIKE ?)"); p.push(`%${q}%`, String(q).replace(/^#/, ''), `%${q}%`); }
  return all(`${TICKET_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE t.status WHEN 'new' THEN 0 WHEN 'open' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC LIMIT 1000`, ...p);
}

export function getTicket(id, { includeInternal = true } = {}) {
  const tk = get(`${TICKET_SELECT} WHERE t.id=?`, Number(id));
  if (!tk) throw new HttpError(404, 'Ticket not found');
  tk.thread = all(`SELECT id, author, author_kind, body, internal, created_at FROM ticket_comments WHERE ticket_id=? ${includeInternal ? '' : 'AND internal=0'} ORDER BY id`, tk.id);
  return tk;
}

export function ticketCounts(username) {
  const r = get(`SELECT SUM(status='new') AS new, SUM(status IN ${ACTIVE}) AS active, SUM(status IN ${ACTIVE} AND assignee=?) AS mine,
    SUM(status IN ${ACTIVE} AND assignee IS NULL) AS unassigned FROM tickets`, username);
  return { new: r.new || 0, active: r.active || 0, mine: r.mine || 0, unassigned: r.unassigned || 0 };
}
