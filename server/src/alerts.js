import { get, run, getSettings } from './db.js';

async function notify(text, alert) {
  const { webhook_url } = getSettings();
  if (!webhook_url) return;
  try {
    // "text" works for Slack/Mattermost/Teams-style hooks, "content" for Discord.
    await fetch(webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text, alert }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.warn('[webhook] delivery failed:', e.message);
  }
}

export function openAlert(agent, type, severity, message) {
  if (agent.maintenance) return;
  const existing = get("SELECT id FROM alerts WHERE agent_id=? AND type=? AND status IN ('open','ack')", agent.id, type);
  const t = Date.now();
  if (existing) {
    run('UPDATE alerts SET message=?, severity=?, updated_at=? WHERE id=?', message, severity, t, existing.id);
    return;
  }
  const r = run('INSERT INTO alerts(agent_id, type, severity, message, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
    agent.id, type, severity, message, 'open', t, t);
  notify(`[${severity.toUpperCase()}] ${agent.hostname}: ${message}`,
    { id: Number(r.lastInsertRowid), agent_id: agent.id, hostname: agent.hostname, type, severity, message, state: 'open' });
}

export function resolveAlert(agent, type, note) {
  const open = get("SELECT id FROM alerts WHERE agent_id=? AND type=? AND status IN ('open','ack')", agent.id, type);
  if (!open) return;
  const t = Date.now();
  run("UPDATE alerts SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", t, t, open.id);
  notify(`[RESOLVED] ${agent.hostname}: ${note}`,
    { id: open.id, agent_id: agent.id, hostname: agent.hostname, type, state: 'resolved' });
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
