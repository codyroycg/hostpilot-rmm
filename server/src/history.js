// Device history: one timeline per device built from recorded events (start-ups, sign-ins, software changes,
// patching) plus jobs, alerts, chat and audit entries already in the database.
import { all, run } from './db.js';

export function deviceEvent(agentId, kind, text) {
  try { run('INSERT INTO device_events(agent_id, ts, kind, text) VALUES(?,?,?,?)', agentId, Date.now(), kind, String(text).slice(0, 1000)); }
  catch { /* device deleted meanwhile */ }
}

/** Called on check-in with the stored row and the new values: records what changed. */
export function recordCheckinChanges(prev, next) {
  if (!prev) return;
  const id = prev.id;
  if (next.boot_time && prev.boot_time && Math.abs(next.boot_time - prev.boot_time) > 120000) deviceEvent(id, 'startup', 'Device started up');
  if (next.logged_user !== undefined && (next.logged_user || '') !== (prev.logged_user || '')) {
    deviceEvent(id, 'user', next.logged_user ? `${next.logged_user} signed in${prev.logged_user ? ` (was ${prev.logged_user})` : ''}` : `${prev.logged_user} signed out`);
  }
  if (next.agent_version && prev.agent_version && next.agent_version !== prev.agent_version) deviceEvent(id, 'agent', `Agent updated to ${next.agent_version}`);
  if (next.os_version && prev.os_version && next.os_version !== prev.os_version) deviceEvent(id, 'os', `OS changed from ${prev.os_version} to ${next.os_version}`);
  if (next.ip_addrs && prev.ip_addrs && next.ip_addrs !== prev.ip_addrs) {
    try { deviceEvent(id, 'network', `IP addresses changed to ${JSON.parse(next.ip_addrs).join(', ') || 'none'}`); } catch { /* bad json */ }
  }
}

/** Called before an inventory replaces the software list: records installs, removals and version changes. */
export function recordSoftwareChanges(agentId, newList) {
  const old = all('SELECT name, version FROM software WHERE agent_id=?', agentId);
  if (!old.length) return; // first inventory: nothing to compare with
  const o = new Map(old.map((s) => [s.name, s.version || '']));
  const n = new Map(newList.filter((s) => s?.name).map((s) => [String(s.name), String(s.version || '')]));
  let count = 0;
  for (const [name, ver] of n) {
    if (count > 200) break;
    if (!o.has(name)) { deviceEvent(agentId, 'software', `Installed ${name}${ver ? ` ${ver}` : ''}`); count++; }
    else if (o.get(name) !== ver) { deviceEvent(agentId, 'software', `Updated ${name} ${o.get(name)} → ${ver}`); count++; }
  }
  for (const [name, ver] of o) {
    if (count > 200) break;
    if (!n.has(name)) { deviceEvent(agentId, 'software', `Removed ${name}${ver ? ` ${ver}` : ''}`); count++; }
  }
}

/** Merged, newest-first timeline for a device. */
export function deviceHistory(agent, { limit = 300, before = Date.now() + 1, kinds = null } = {}) {
  const items = [];
  const want = (k) => !kinds || kinds.includes(k);
  if (want('events')) {
    for (const e of all('SELECT ts, kind, text FROM device_events WHERE agent_id=? AND ts<? ORDER BY ts DESC LIMIT ?', agent.id, before, limit)) {
      items.push({ ts: e.ts, kind: e.kind, text: e.text });
    }
  }
  if (want('jobs')) {
    for (const j of all(`SELECT id, name, status, created_by, created_at, finished_at, exit_code FROM jobs WHERE agent_id=? AND created_at<?
                          AND COALESCE(task,'') NOT IN ('metrics.live','terminal.open') AND shell!='_remote' ORDER BY created_at DESC LIMIT ?`, agent.id, before, limit)) {
      items.push({ ts: j.created_at, kind: 'job', text: `${j.name} — ${j.status}${j.created_by ? ` (by ${j.created_by})` : ''}`, job_id: j.id, status: j.status });
    }
  }
  if (want('alerts')) {
    for (const a of all('SELECT severity, message, status, created_at, resolved_at FROM alerts WHERE agent_id=? AND created_at<? ORDER BY created_at DESC LIMIT ?', agent.id, before, limit)) {
      items.push({ ts: a.created_at, kind: 'alert', severity: a.severity, text: `Alert: ${a.message}` });
      if (a.resolved_at) items.push({ ts: a.resolved_at, kind: 'alert-resolved', text: `Resolved: ${a.message}` });
    }
  }
  if (want('chat')) {
    for (const m of all('SELECT direction, author, body, created_at FROM chat_messages WHERE agent_id=? AND created_at<? ORDER BY id DESC LIMIT ?', agent.id, before, Math.min(limit, 100))) {
      items.push({ ts: m.created_at, kind: 'chat', text: `${m.direction === 'user' ? (m.author || 'User') : `${m.author || 'Technician'} (IT)`}: ${m.body}` });
    }
  }
  if (want('audit') && agent.hostname) {
    for (const a of all("SELECT ts, username, action, detail FROM audit WHERE ts<? AND (detail LIKE ? OR detail LIKE ?) ORDER BY ts DESC LIMIT ?",
      before, `%${agent.hostname}%`, `%${agent.id}%`, Math.min(limit, 100))) {
      items.push({ ts: a.ts, kind: 'audit', text: `${a.username}: ${a.action}${a.detail ? ` — ${a.detail}` : ''}` });
    }
  }
  if (agent.enrolled_at && agent.enrolled_at < before && want('events')) items.push({ ts: agent.enrolled_at, kind: 'agent', text: 'Device enrolled in HostPilot' });
  return items.filter((x) => x.ts).sort((x, y) => y.ts - x.ts).slice(0, limit);
}
