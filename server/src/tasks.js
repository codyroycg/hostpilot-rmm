import { all, run, getSettings } from './db.js';
import { queueJobs, isPolling } from './jobs.js';
import { openAlert } from './alerts.js';
import { buildTask } from './task-catalog.js';
import { policyTargets, buildPolicyScript } from './policies.js';
import { runPatchWindows } from './patching.js';
import { expireShots } from './screenshots.js';

// Periodically scan online devices for OS updates (a few at a time).
function autoUpdateScan() {
  const { update_scan_hours } = getSettings();
  if (!update_scan_hours) return;
  const cutoff = Date.now() - update_scan_hours * 3600000;
  const due = all(`SELECT id, hostname, platform FROM agents a WHERE (updates_checked_at IS NULL OR updates_checked_at < ?)
                   AND last_seen > ? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.agent_id=a.id
                   AND j.task IN ('updates.scan','updates.install') AND (j.status IN ('queued','running') OR j.created_at > ?))
                   LIMIT 10`, cutoff, Date.now() - 3 * 60000, Date.now() - 6 * 3600000);
  if (!due.length) return;
  queueJobs({
    agents: due, name: 'Scan for OS updates', task: 'updates.scan', timeout: 3600, createdBy: 'scheduler',
    build: (a) => buildTask('updates.scan', a.platform, {}),
  });
}

// Detect server roles (for role-based monitoring) on online Windows / Linux devices, a few at a time.
export function queueRoleDetect(agents, createdBy) {
  return queueJobs({
    agents: agents.filter((a) => a.platform === 'windows' || a.platform === 'linux'), name: 'Detect server roles', task: 'roles.detect',
    timeout: 300, createdBy, build: (a) => buildTask('roles.detect', a.platform, {}, { allowInternal: true }),
  });
}
function autoRoleDetect() {
  const { role_scan_hours } = getSettings();
  if (!role_scan_hours) return;
  const due = all(`SELECT id, hostname, platform FROM agents a WHERE platform IN ('windows','linux') AND (roles_at IS NULL OR roles_at < ?)
                   AND last_seen > ? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.agent_id=a.id AND j.task='roles.detect'
                   AND (j.status IN ('queued','running') OR j.created_at > ?)) LIMIT 20`,
  Date.now() - role_scan_hours * 3600000, Date.now() - 3 * 60000, Date.now() - 6 * 3600000);
  if (due.length) queueRoleDetect(due, 'scheduler');
}

// Rescan discovered networks on their schedule (scan_hours; 0 = manual only).
async function networkScans() {
  const { queueNetworkScan } = await import('./api-routes.js');
  const t = Date.now();
  for (const n of all('SELECT * FROM networks WHERE scan_hours > 0 AND probe_agent_id IS NOT NULL')) {
    if (n.last_scan_at && t - n.last_scan_at < n.scan_hours * 3600000) continue;
    const j = n.last_job_id ? all('SELECT status, created_at FROM jobs WHERE id=?', n.last_job_id)[0] : null;
    if (j && (['queued', 'running'].includes(j.status) || t - j.created_at < 3600000)) continue; // running, or failed less than an hour ago
    try { queueNetworkScan(n, 'scheduler'); } catch (e) { console.error('[netscan]', n.name, e.message); }
  }
}

// Run enabled policies on their interval (one job per targeted device; skip devices that already have one queued).
export function runPolicy(p, createdBy, onlyAgents = null) {
  let agents = policyTargets(p);
  if (onlyAgents) agents = agents.filter((a) => onlyAgents.includes(a.id));
  const pending = new Set(all("SELECT agent_id FROM jobs WHERE task='policy.run' AND status IN ('queued','running') AND name=?", `Policy: ${p.name}`).map((r) => r.agent_id));
  const r = queueJobs({
    agents: agents.filter((a) => !pending.has(a.id)), name: `Policy: ${p.name}`, task: 'policy.run', timeout: 900, createdBy,
    build: (a) => buildPolicyScript(p, a.platform),
  });
  run('UPDATE policies SET last_run=? WHERE id=?', Date.now(), p.id);
  return r;
}
function runPolicies() {
  const t = Date.now();
  for (const p of all('SELECT * FROM policies WHERE enabled=1')) {
    if (p.last_run && t - p.last_run < p.interval_hours * 3600000) continue;
    const r = runPolicy(p, 'scheduler');
    console.log(`[policy] "${p.name}" queued on ${r.created} device(s)`);
  }
}

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
  // jobs that ended without a result (cancelled/lost/expired) still hold their injected arguments: scrub them
  run("UPDATE jobs SET body=display_body, display_body=NULL WHERE display_body IS NOT NULL AND status NOT IN ('queued','running')");
}

function prune() {
  const s = getSettings();
  const t = Date.now();
  run('DELETE FROM metrics WHERE ts < ?', t - s.metric_retention_days * 86400000);
  run("DELETE FROM jobs WHERE created_at < ? AND status NOT IN ('queued','running')", t - s.job_retention_days * 86400000);
  run("DELETE FROM alerts WHERE status='resolved' AND resolved_at < ?", t - 90 * 86400000);
  run('DELETE FROM sessions WHERE expires_at < ?', t);
  run('DELETE FROM audit WHERE ts < ?', t - 365 * 86400000);
  run('DELETE FROM device_events WHERE ts < ?', t - 365 * 86400000);
}

function safe(name, fn) {
  return () => { try { fn(); } catch (e) { console.error(`[task:${name}]`, e); } };
}

export function startBackgroundTasks() {
  setInterval(safe('schedules', runSchedules), 30_000);
  setInterval(safe('offline', checkOffline), 60_000);
  setInterval(safe('expire', expireJobs), 60_000);
  setInterval(safe('prune', prune), 3600_000);
  setInterval(safe('update-scan', autoUpdateScan), 5 * 60_000);
  setInterval(safe('policies', runPolicies), 5 * 60_000);
  setTimeout(safe('policies', runPolicies), 60_000);
  setInterval(() => networkScans().catch((e) => console.error('[task:netscan]', e)), 10 * 60_000);
  setTimeout(safe('update-scan', autoUpdateScan), 90_000);
  setTimeout(safe('prune', prune), 10_000);
  setInterval(safe('roles', autoRoleDetect), 10 * 60_000);
  setTimeout(safe('roles', autoRoleDetect), 120_000);
  setInterval(() => runPatchWindows().catch((e) => console.error('[task:patch]', e)), 60_000);
  setInterval(safe('screenshots', expireShots), 60_000);
}
