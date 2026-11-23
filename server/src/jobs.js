import { all, run, tx } from './db.js';
import { uuid, shellSupported } from './util.js';

// agentId -> Set<wake fn> for agents currently long-polling
const waiters = new Map();
// jobId -> Set<fn> for API calls waiting on a job result
const jobWaiters = new Map();

export function addWaiter(agentId, fn) {
  let set = waiters.get(agentId);
  if (!set) { set = new Set(); waiters.set(agentId, set); }
  set.add(fn);
  return () => { set.delete(fn); if (!set.size) waiters.delete(agentId); };
}

export function wakeAgent(agentId) {
  const set = waiters.get(agentId);
  if (set) for (const fn of [...set]) fn();
}

export const isPolling = (agentId) => waiters.has(agentId);

/** Resolve when the job finishes or after ms (whichever first). */
export function waitForJob(jobId, ms) {
  return new Promise((resolve) => {
    let set = jobWaiters.get(jobId);
    if (!set) { set = new Set(); jobWaiters.set(jobId, set); }
    const done = () => { clearTimeout(t); set.delete(done); if (!set.size) jobWaiters.delete(jobId); resolve(); };
    const t = setTimeout(done, ms);
    set.add(done);
  });
}

export function notifyJobDone(jobId) {
  const set = jobWaiters.get(jobId);
  if (set) for (const fn of [...set]) fn();
}

/**
 * Queue a script on a set of agents. Agents whose OS can't run the shell are skipped.
 * `build(agent)` may be given instead of shell/body to generate a per-platform script
 * (returns {shell, body, displayBody} or null to skip that agent).
 */
export function queueJobs({ agents, name, shell, body, displayBody = null, timeout, scriptId = null, createdBy, task = null, build = null }) {
  const batchId = uuid();
  const t = Date.now();
  const created = [];
  const skipped = [];
  tx(() => {
    for (const a of agents) {
      let sh = shell, bd = body, disp = displayBody, nm = name;
      if (build) {
        const b = build(a);
        if (!b) { skipped.push(a.hostname || a.id); continue; }
        sh = b.shell; bd = b.body; disp = b.displayBody ?? null; nm = b.name || name;
      }
      // "_"-prefixed shells are internal agent commands (uninstall, remote control)
      if (!sh.startsWith('_') && !shellSupported(sh, a.platform)) { skipped.push(a.hostname || a.id); continue; }
      const id = uuid();
      run(`INSERT INTO jobs(id, batch_id, agent_id, script_id, name, shell, body, display_body, timeout, status, created_by, created_at, task)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, batchId, a.id, scriptId, nm, sh, bd, disp, timeout, 'queued', createdBy, t, task);
      created.push({ id, agent_id: a.id });
    }
  });
  for (const c of created) wakeAgent(c.agent_id);
  return { batch_id: batchId, created: created.length, jobs: created, skipped };
}

export function claimJobs(agentId) {
  const jobs = all("SELECT id, shell, body, timeout FROM jobs WHERE agent_id=? AND status='queued' ORDER BY created_at LIMIT 10", agentId);
  if (jobs.length) {
    const t = Date.now();
    tx(() => { for (const j of jobs) run("UPDATE jobs SET status='running', sent_at=? WHERE id=?", t, j.id); });
  }
  return jobs;
}
