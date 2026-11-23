// Post-processing when a job finishes: scrub secrets, store parsed task results, wake waiting API calls.
import { get, run, tx } from './db.js';
import { notifyJobDone } from './jobs.js';

function parseUpdates(agentId, stdout) {
  const updates = [];
  let reboot = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const f = line.split('\t');
    if (f[0] === 'U' && f.length >= 7) {
      updates.push({ uid: f[1], kb: f[2], severity: f[3], category: f[4], size: Number(f[5]) || 0, title: f.slice(6).join(' ') });
    } else if (f[0] === 'R') {
      reboot = f[1] === '1' ? 1 : 0;
    }
  }
  if (reboot === null) return; // scan didn't complete
  const isSecurity = (u) => /critical|important|security/i.test(`${u.severity} ${u.category}`);
  tx(() => {
    run('DELETE FROM updates WHERE agent_id=?', agentId);
    for (const u of updates) {
      run('INSERT INTO updates(agent_id, uid, kb, title, severity, category, size) VALUES(?,?,?,?,?,?,?)',
        agentId, u.uid, u.kb, u.title, u.severity, u.category, u.size);
    }
    run('UPDATE agents SET updates_checked_at=?, pending_updates=?, security_updates=?, reboot_required=? WHERE id=?',
      Date.now(), updates.length, updates.filter(isSecurity).length, reboot, agentId);
  });
}

export function onJobFinished(jobId) {
  const j = get('SELECT id, agent_id, task, status, stdout, display_body FROM jobs WHERE id=?', jobId);
  if (!j) return;
  // job history keeps the readable copy (passwords masked) instead of the executed script
  if (j.display_body != null) run('UPDATE jobs SET body=display_body, display_body=NULL WHERE id=?', j.id);
  if (j.task === 'updates.scan' || j.task === 'updates.install') parseUpdates(j.agent_id, j.stdout);
  if (/^software\.(install|uninstall|reinstall)$/.test(j.task || '')) run('UPDATE agents SET want_inventory=1 WHERE id=?', j.agent_id);
  if (j.task === 'updates.install') run('UPDATE agents SET want_inventory=1 WHERE id=?', j.agent_id);
  notifyJobDone(j.id);
}
