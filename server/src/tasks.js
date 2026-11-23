import { all, run, getSettings } from './db.js';
import { queueJobs, isPolling } from './jobs.js';
import { openAlert } from './alerts.js';

function targetsFor(s) {
  switch (s.target_type) {
    case 'all': return all('SELECT id, hostname, platform FROM agents');
    case 'client': return all('SELECT id, hostname, platform FROM agents WHERE client_id=?', Number(s.target_id));
    case 'platform': return all('SELECT id, hostname, platform FROM agents WHERE platform=?', s.target_id);
    case 'agent': return all('SELECT id, hostname, platform FROM agents WHERE id=?', s.target_id);
    default: return [];
  }
}

function runSchedules() {
  const t = Date.now();
  const due = all(`SELECT s.*, sc.name AS script_name, sc.shell, sc.body, sc.timeout FROM schedules s
                   JOIN scripts sc ON sc.id=s.script_id WHERE s.enabled=1`)
    .filter((s) => !s.last_run || t - s.last_run >= s.interval_minutes * 60000);
  for (const s of due) {
    run('UPDATE schedules SET last_run=? WHERE id=?', t, s.id);
    const agents = targetsFor(s);
    if (!agents.length) continue;
    // don't pile up duplicates for devices that are offline and still have this script queued
    const pending = new Set(all("SELECT agent_id FROM jobs WHERE script_id=? AND status='queued'", s.script_id).map((r) => r.agent_id));
    const r = queueJobs({
      agents: agents.filter((a) => !pending.has(a.id)), name: `${s.script_name} (scheduled: ${s.name})`,
      shell: s.shell, body: s.body, timeout: s.timeout, scriptId: s.script_id, createdBy: 'scheduler',
    });
    console.log(`[scheduler] "${s.name}" queued on ${r.created} device(s)`);
  }
}

function checkOffline() {
  const { offline_minutes } = getSettings();
  if (!offline_minutes) return;
  const cutoff = Date.now() - offline_minutes * 60000;
  for (const a of all('SELECT * FROM agents WHERE last_seen < ? AND maintenance=0', cutoff)) {
    if (isPolling(a.id)) continue;
    const mins = Math.round((Date.now() - a.last_seen) / 60000);
    openAlert(a, 'offline', 'critical', `Device offline for ${mins >= 120 ? Math.round(mins / 60) + ' hours' : mins + ' minutes'}`);
  }
}

function expireJobs() {
  const t = Date.now();
  // results never came back (agent restarted / host rebooted mid-job)
  run(`UPDATE jobs SET status='lost', finished_at=?, stderr='No result received from agent'
       WHERE status='running' AND sent_at < ? - (timeout + 600) * 1000`, t, t);
  run("UPDATE jobs SET status='expired', finished_at=? WHERE status='queued' AND created_at < ?", t, t - 7 * 86400000);
}

function prune() {
  const s = getSettings();
  const t = Date.now();
  run('DELETE FROM metrics WHERE ts < ?', t - s.metric_retention_days * 86400000);
  run("DELETE FROM jobs WHERE created_at < ? AND status NOT IN ('queued','running')", t - s.job_retention_days * 86400000);
  run("DELETE FROM alerts WHERE status='resolved' AND resolved_at < ?", t - 90 * 86400000);
  run('DELETE FROM sessions WHERE expires_at < ?', t);
  run('DELETE FROM audit WHERE ts < ?', t - 365 * 86400000);
}

function safe(name, fn) {
  return () => { try { fn(); } catch (e) { console.error(`[task:${name}]`, e); } };
}

export function startBackgroundTasks() {
  setInterval(safe('schedules', runSchedules), 30_000);
  setInterval(safe('offline', checkOffline), 60_000);
  setInterval(safe('expire', expireJobs), 60_000);
  setInterval(safe('prune', prune), 3600_000);
  setTimeout(safe('prune', prune), 10_000);
}
