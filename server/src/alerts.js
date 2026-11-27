import { all, get, run, getSettings } from './db.js';
import { notify } from './notify.js';
import { createTicket } from './tickets.js';

/** Opens (or refreshes) an alert. Returns { id, created } or null when the device is in maintenance mode. */
export function openAlert(agent, type, severity, message, { ticket = false, monitorId = null } = {}) {
  if (agent.maintenance) return null;
  const existing = get("SELECT id FROM alerts WHERE agent_id=? AND type=? AND status IN ('open','ack')", agent.id, type);
  const t = Date.now();
  if (existing) {
    run('UPDATE alerts SET message=?, severity=?, updated_at=? WHERE id=?', message, severity, t, existing.id);
    return { id: existing.id, created: false };
  }
  const r = run('INSERT INTO alerts(agent_id, type, severity, message, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
    agent.id, type, severity, message, 'open', t, t);
  const id = Number(r.lastInsertRowid);
  notify(`[${severity.toUpperCase()}] ${agent.hostname}: ${message}`,
    { alert: { id, agent_id: agent.id, hostname: agent.hostname, type, severity, message, state: 'open' } });
  if (ticket || (severity === 'critical' && getSettings().ticket_from_critical)) {
    try {
      createTicket({
        subject: `${agent.hostname}: ${message}`.slice(0, 200), body: `Opened automatically from a ${severity} alert.\n\n${message}`,
        agent_id: agent.id, client_id: agent.client_id ?? null, priority: severity === 'critical' ? 'high' : 'normal',
        source: monitorId ? 'monitor' : 'alert', alert_id: id, monitor_id: monitorId, created_by: 'HostPilot',
      });
    } catch (e) { console.error('[ticket]', e); }
  }
  return { id, created: true };
}

export function resolveAlert(agent, type, note) {
  const open = get("SELECT id FROM alerts WHERE agent_id=? AND type=? AND status IN ('open','ack')", agent.id, type);
  if (!open) return;
  const t = Date.now();
  run("UPDATE alerts SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", t, t, open.id);
  notify(`[RESOLVED] ${agent.hostname}: ${note}`,
    { alert: { id: open.id, agent_id: agent.id, hostname: agent.hostname, type, state: 'resolved' } });
  // tickets opened from this alert get a note (they stay open for the technician to close)
  for (const tk of all("SELECT id FROM tickets WHERE alert_id=? AND status NOT IN ('resolved','closed')", open.id)) {
    run("INSERT INTO ticket_comments(ticket_id, author, author_kind, body, internal, created_at) VALUES(?,?,?,?,1,?)", tk.id, 'HostPilot', 'system', `The alert cleared: ${note}`, t);
    run('UPDATE tickets SET updated_at=? WHERE id=?', t, tk.id);
  }
}

// Evaluate resource thresholds right after a check-in.
export function evaluateThresholds(agent, disks) {
  const s = getSettings();
  const recent = get(`SELECT AVG(cpu) AS cpu, AVG(mem) AS mem, COUNT(*) AS n FROM
    (SELECT cpu, mem FROM metrics WHERE agent_id=? ORDER BY ts DESC LIMIT 3)`, agent.id);
  if (recent && recent.n >= 3) {
    for (const [type, val, th] of [['cpu', recent.cpu, s.cpu_threshold], ['memory', recent.mem, s.mem_threshold]]) {
      if (!th) continue;
      if (val >= th) openAlert(agent, type, 'warning', `${type === 'cpu' ? 'CPU' : 'Memory'} usage sustained at ${val.toFixed(0)}% (threshold ${th}%)`);
      else if (val < th - 5) resolveAlert(agent, type, `${type} usage back to ${val.toFixed(0)}%`);
    }
  }
  if (s.disk_threshold && Array.isArray(disks)) {
    const full = disks.filter((d) => d.total > 0 && ((d.total - d.free) / d.total) * 100 >= s.disk_threshold);
    if (full.length) {
      const list = full.map((d) => `${d.mount} ${(((d.total - d.free) / d.total) * 100).toFixed(0)}%`).join(', ');
      openAlert(agent, 'disk', full.some((d) => d.free / d.total < 0.03) ? 'critical' : 'warning', `Low disk space: ${list}`);
    } else {
      resolveAlert(agent, 'disk', 'disk usage back under threshold');
    }
  }
}
