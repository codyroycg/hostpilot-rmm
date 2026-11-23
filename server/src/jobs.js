import { all, run, tx } from './db.js';
import { uuid, shellSupported } from './util.js';

// agentId -> Set<wake fn> for agents currently long-polling
const waiters = new Map();

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

/**
 * Queue a script on a set of agents. Agents whose OS can't run the shell are skipped.
 * @returns {{batch_id, created, skipped: string[]}}
 */
export function queueJobs({ agents, name, shell, body, timeout, scriptId = null, createdBy }) {
  const batchId = uuid();
  const t = Date.now();
  const created = [];
  const skipped = [];
  tx(() => {
    for (const a of agents) {
      // "_"-prefixed shells are internal agent commands (uninstall, remote control)
      if (!shell.startsWith('_') && !shellSupported(shell, a.platform)) { skipped.push(a.hostname || a.id); continue; }
      const id = uuid();
      run(`INSERT INTO jobs(id, batch_id, agent_id, script_id, name, shell, body, timeout, status, created_by, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, batchId, a.id, scriptId, name, shell, body, timeout, 'queued', createdBy, t);
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
