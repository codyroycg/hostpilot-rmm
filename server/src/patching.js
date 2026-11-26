// Patch manager: ordered patch policies (targets, maintenance window, reboot behaviour, automatic approvals),
// a fleet-wide approval list, per-device overrides, and the scheduler that installs approved updates in the window.
import { all, get, run, getSettings, audit } from './db.js';
import { HttpError } from './util.js';
import { queueJobs, isPolling } from './jobs.js';
import { buildTask } from './task-catalog.js';
import { wakeOnLan, agentWakeTarget } from './wol.js';
import { deviceEvent } from './history.js';

export const CATEGORIES = [
  ['security', 'Security updates'], ['critical', 'Critical updates'], ['definition', 'Definition updates (antivirus)'],
  ['driver', 'Drivers'], ['feature', 'Feature updates & upgrades'], ['other', 'Other updates'],
];
const CAT_IDS = CATEGORIES.map(([c]) => c);
const PLATFORMS = ['any', 'windows', 'linux', 'macos'];
const CLASSES = ['desktop', 'laptop', 'server', 'vm'];
const ONLINE_WINDOW = 3 * 60 * 1000;
const isOnline = (a) => isPolling(a.id) || (a.last_seen && Date.now() - a.last_seen < ONLINE_WINDOW);

/** Sorts an update (row of the updates table) into one of CATEGORIES. */
export function categorize(u) {
  const c = String(u.category || '').toLowerCase(), t = String(u.title || '').toLowerCase(), sev = String(u.severity || '').toLowerCase();
  if (c.includes('definition') || t.includes('security intelligence') || t.includes('definition update')) return 'definition';
  if (c.includes('driver')) return 'driver';
  if (c.includes('upgrade') || c.includes('feature pack') || t.includes('feature update')) return 'feature';
  if (c.includes('critical')) return 'critical';
  if (sev || c.includes('security')) return 'security';
  return 'other';
}

/** Fleet-wide identity of an update: the same Windows update / Linux package on every device. */
export const ukey = (platform, u) => `${platform === 'windows' ? 'w' : platform === 'macos' ? 'm' : 'l'}:${u.uid}`;

// ---------- policies ----------

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export function presentPolicy(p) {
  return {
    id: p.id, name: p.name, position: p.position, enabled: !!p.enabled, created_at: p.created_at, updated_at: p.updated_at,
    target: parse(p.target, {}), schedule: parse(p.schedule, {}), options: parse(p.options, {}), reboot: parse(p.reboot, {}), approval: parse(p.approval, {}),
  };
}
export const listPolicies = () => all('SELECT * FROM patch_policies ORDER BY position, id').map(presentPolicy);

export function cleanPatchPolicy(b) {
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Name is required');
  const t = b.target || {};
  const target = {
    platform: PLATFORMS.includes(t.platform) ? t.platform : 'any',
    clients: (Array.isArray(t.clients) ? t.clients : []).map(Number).filter(Number.isInteger).slice(0, 500),
    classes: (Array.isArray(t.classes) ? t.classes : []).filter((c) => CLASSES.includes(c)),
    agents: (Array.isArray(t.agents) ? t.agents : []).map(String).filter((x) => /^[\w-]{1,64}$/.test(x)).slice(0, 5000),
  };
  const s = b.schedule || {};
  const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) throw new HttpError(400, 'Pick at least one day for the maintenance window');
  const start = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.start)) ? String(s.start) : null;
  if (!start) throw new HttpError(400, 'Start time must look like 03:00');
  const hours = Math.max(1, Math.min(12, Math.round(Number(s.hours) || 2)));
  const o = b.options || {};
  const options = { wake: !!o.wake, restore_point: !!o.restore_point, daytime: !!o.daytime, min_uptime: Math.max(0, Math.min(240, Math.round(Number(o.min_uptime) || 0))) };
  const r = b.reboot || {};
  const reboot = { mode: ['never', 'auto', 'notify'].includes(r.mode) ? r.mode : 'never', delay: Math.max(1, Math.min(240, Math.round(Number(r.delay) || 15))) };
  const ap = b.approval || {};
  const approval = {
    auto_approve: (Array.isArray(ap.auto_approve) ? ap.auto_approve : []).filter((c) => CAT_IDS.includes(c)),
    auto_deny: (Array.isArray(ap.auto_deny) ? ap.auto_deny : []).filter((c) => CAT_IDS.includes(c)),
  };
  approval.auto_deny = approval.auto_deny.filter((c) => !approval.auto_approve.includes(c));
  return { name, enabled: b.enabled === false ? 0 : 1, target, schedule: { days, start, hours }, options, reboot, approval };
}

const targets = (pol, a) => {
  const t = pol.target || {};
  if (t.agents?.length) return t.agents.includes(a.id);
  return (t.platform === 'any' || !t.platform || t.platform === a.platform)
    && (!t.clients?.length || t.clients.includes(a.client_id))
    && (!t.classes?.length || t.classes.includes(a.device_class || 'desktop'));
};

/** The policy that applies to a device: its override, else the first matching enabled policy (top of the list wins). */
export function effectivePolicy(a, policies = listPolicies()) {
  if (a.patch_override === 'none') return { policy: null, source: 'override-none' };
  if (a.patch_override) {
    const p = policies.find((x) => String(x.id) === String(a.patch_override));
    if (p) return { policy: p, source: 'override' };
  }
  const p = policies.find((x) => x.enabled && targets(x, a));
  return { policy: p || null, source: p ? 'group' : 'none' };
}

// ---------- approvals ----------

/** approved / denied / pending for one update on one device, and why. */
export function approvalFor(u, platform, policy, manual) {
  const m = manual.get(ukey(platform, u));
  if (m) return { status: m.status, by: 'manual' };
  const cat = categorize(u);
  if (policy?.approval?.auto_approve?.includes(cat)) return { status: 'approved', by: 'auto' };
  if (policy?.approval?.auto_deny?.includes(cat)) return { status: 'denied', by: 'auto' };
  return { status: 'pending', by: '' };
}
export const manualApprovals = () => new Map(all('SELECT * FROM patch_approvals').map((r) => [r.ukey, r]));

export function setApprovals(keys, status, username) {
  if (!['approved', 'denied', 'reset'].includes(status)) throw new HttpError(400, 'Bad status');
  let n = 0;
  for (const k of keys.slice(0, 5000)) {
    if (!/^[wlm]:[\w.+:@~-]{1,200}$/.test(k)) continue;
    if (status === 'reset') run('DELETE FROM patch_approvals WHERE ukey=?', k);
    else {
      const t = get('SELECT title FROM updates WHERE uid=? LIMIT 1', k.slice(2))?.title || '';
      run(`INSERT INTO patch_approvals(ukey, status, title, decided_by, decided_at) VALUES(?,?,?,?,?)
           ON CONFLICT(ukey) DO UPDATE SET status=excluded.status, decided_by=excluded.decided_by, decided_at=excluded.decided_at`, k, status, t, username, Date.now());
    }
    n++;
  }
  audit(username, `patch.${status}`, `${n} update(s)`);
  return n;
}

const AGENT_COLS = 'id, hostname, platform, client_id, device_class, last_seen, boot_time, patch_override, patch_window, updates_checked_at, pending_updates, security_updates, reboot_required, wsus, net_ifaces, ip_addrs';

/** Every pending update in the fleet, grouped by update, with its approval state per device. */
export function approvalQueue() {
  const policies = listPolicies(), manual = manualApprovals();
  const agents = new Map(all(`SELECT ${AGENT_COLS} FROM agents`).map((a) => [a.id, { ...a, eff: effectivePolicy(a, policies).policy }]));
  const byKey = new Map();
  for (const u of all('SELECT agent_id, uid, kb, title, severity, category, size FROM updates')) {
    const a = agents.get(u.agent_id);
    if (!a) continue;
    const key = ukey(a.platform, u);
    let e = byKey.get(key);
    if (!e) {
      const m = manual.get(key);
      e = { key, platform: a.platform, kb: u.kb, title: u.title, severity: u.severity, category: categorize(u), size: u.size,
        manual: m ? m.status : null, decided_by: m?.decided_by || null, devices: 0, approved: 0, denied: 0, pending: 0 };
      byKey.set(key, e);
    }
    e.devices++;
    e[approvalFor(u, a.platform, a.eff, manual).status]++;
  }
  return [...byKey.values()].sort((x, y) => (y.pending - x.pending) || (y.devices - x.devices) || String(x.title).localeCompare(String(y.title)));
}

/** Per-device rows for the patch manager. */
export function patchDevices() {
  const policies = listPolicies(), manual = manualApprovals();
  const ups = new Map();
  for (const u of all('SELECT agent_id, uid, kb, title, severity, category FROM updates')) {
    if (!ups.has(u.agent_id)) ups.set(u.agent_id, []);
    ups.get(u.agent_id).push(u);
  }
  const busy = new Map(all("SELECT agent_id, task FROM jobs WHERE task IN ('updates.scan','updates.install') AND status IN ('queued','running')").map((j) => [j.agent_id, j.task]));
  return all(`SELECT a.id, a.hostname, a.platform, a.client_id, a.device_class, a.last_seen, a.os_name, a.patch_override, a.updates_checked_at,
                a.pending_updates, a.security_updates, a.reboot_required, a.wsus, c.name AS client_name
              FROM agents a LEFT JOIN clients c ON c.id=a.client_id ORDER BY a.hostname COLLATE NOCASE`).map((a) => {
    const eff = effectivePolicy(a, policies);
    const counts = { approved: 0, denied: 0, pending: 0 };
    for (const u of ups.get(a.id) || []) counts[approvalFor(u, a.platform, eff.policy, manual).status]++;
    return {
      ...a, online: isOnline(a), busy: busy.get(a.id) || null,
      policy: eff.policy ? { id: eff.policy.id, name: eff.policy.name } : null, policy_source: eff.source, ...counts,
      // compliant: scanned in the last week and nothing approved is still missing
      compliant: !!a.updates_checked_at && Date.now() - a.updates_checked_at < 7 * 86400000 && counts.approved === 0,
    };
  });
}

export function patchDashboard() {
  const devs = patchDevices();
  const scanned = devs.filter((d) => d.updates_checked_at);
  const q = approvalQueue();
  return {
    devices: devs.length,
    compliance: scanned.length ? Math.round((scanned.filter((d) => d.compliant).length / scanned.length) * 100) : null,
    patching_now: devs.filter((d) => d.busy === 'updates.install').length,
    no_inventory: devs.filter((d) => !d.updates_checked_at || Date.now() - d.updates_checked_at > 7 * 86400000).length,
    reboot_required: devs.filter((d) => d.reboot_required).length,
    wsus: devs.filter((d) => d.wsus).length,
    no_policy: devs.filter((d) => !d.policy).length,
    awaiting_approval: q.filter((u) => u.pending > 0).length,
    missing_approved: devs.reduce((n, d) => n + d.approved, 0),
    updates: { approved: q.reduce((n, u) => n + u.approved, 0), denied: q.reduce((n, u) => n + u.denied, 0), pending: q.reduce((n, u) => n + u.pending, 0) },
    by_category: CATEGORIES.map(([id, label]) => ({ id, label, n: q.filter((u) => u.category === id).reduce((n, u) => n + u.devices, 0) })),
    next_windows: listPolicies().filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, ...describeWindow(p) })),
  };
}

// ---------- maintenance windows ----------

export const patchTimeZone = () => {
  const z = getSettings().patch_timezone;
  try { if (z) { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } } catch { /* invalid zone */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
};

/** Wall-clock "local minutes" for now in the patch time zone, as a UTC-based ms number (so date math stays simple). */
function localNow(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
}

/** The most recent window that has started (open or not) and the next one to start, in local wall-clock ms. */
export function windowState(pol, now = Date.now()) {
  const tz = patchTimeZone();
  const nowL = localNow(now, tz);
  const day0 = Date.UTC(new Date(nowL).getUTCFullYear(), new Date(nowL).getUTCMonth(), new Date(nowL).getUTCDate());
  const [sh, sm] = String(pol.schedule.start || '03:00').split(':').map(Number);
  const dur = (pol.schedule.hours || 2) * 3600000;
  const days = pol.schedule.days || [];
  let last = null, next = null;
  for (let off = -1; off <= 8 && !last; off++) { // -1: a window that started yesterday may still be open
    const d = day0 - off * 86400000;
    if (!days.includes(new Date(d).getUTCDay())) continue;
    const st = d + (sh * 60 + sm) * 60000;
    if (st <= nowL) last = { key: `${pol.id}:${new Date(d).toISOString().slice(0, 10)}`, start: st, end: st + dur, open: nowL < st + dur };
  }
  for (let off = 0; off <= 8 && !next; off++) {
    const d = day0 + off * 86400000;
    if (!days.includes(new Date(d).getUTCDay())) continue;
    const st = d + (sh * 60 + sm) * 60000;
    if (st > nowL) next = { key: `${pol.id}:${new Date(d).toISOString().slice(0, 10)}`, start: st, end: st + dur };
  }
  return { tz, nowL, last, next };
}

const fmtLocal = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
export function describeWindow(pol) {
  const w = windowState(pol);
  return { tz: w.tz, open: !!w.last?.open, open_until: w.last?.open ? fmtLocal(w.last.end) : null, next_start: w.next ? fmtLocal(w.next.start) : null };
}

const woken = new Set();

/** Every minute: wake devices before their window, then install approved updates in it (or later, with daytime patching). */
export async function runPatchWindows() {
  const policies = listPolicies();
  if (!policies.length) return;
  const manual = manualApprovals();
  const busy = new Set(all("SELECT agent_id FROM jobs WHERE task IN ('updates.scan','updates.install') AND status IN ('queued','running')").map((j) => j.agent_id));
  for (const a of all(`SELECT ${AGENT_COLS}, maintenance FROM agents`)) {
    const pol = effectivePolicy(a, policies).policy;
    if (!pol) continue;
    const w = windowState(pol);
    const online = isOnline(a);

    // Wake-on-LAN in the 10 minutes before the window opens
    if (pol.options?.wake && !online && w.next && w.next.start - w.nowL <= 10 * 60000) {
      const k = `${a.id}|${w.next.key}`;
      if (!woken.has(k)) {
        woken.add(k);
        const t = agentWakeTarget(a);
        if (t.macs.length) {
          wakeOnLan({ ...t, clientId: a.client_id, exclude: a.id, label: a.hostname, user: { username: 'patch manager' } })
            .then(() => deviceEvent(a.id, 'patch', `Wake-on-LAN sent before the "${pol.name}" patch window`)).catch(() => {});
        }
      }
    }

    if (!w.last || a.patch_window === w.last.key || !online || busy.has(a.id)) continue;
    let due = w.last.open, late = false;
    if (!due && pol.options?.daytime && (!w.next || w.next.start - w.nowL > 30 * 60000)) {
      // missed window (device was off): patch once it's been up long enough, so the user can get going first
      const up = a.boot_time ? Date.now() - a.boot_time : 0;
      due = up >= (pol.options.min_uptime || 0) * 60000;
      late = due;
    }
    if (!due) continue;

    // need a recent scan to know what's missing
    if (!a.updates_checked_at || Date.now() - a.updates_checked_at > 12 * 3600000) {
      queueJobs({ agents: [a], name: 'Scan for OS updates', task: 'updates.scan', timeout: 3600, createdBy: 'patch manager', build: (x) => buildTask('updates.scan', x.platform, {}) });
      continue;
    }
    run('UPDATE agents SET patch_window=? WHERE id=?', w.last.key, a.id);
    const ids = all('SELECT uid, kb, title, severity, category FROM updates WHERE agent_id=?', a.id)
      .filter((u) => approvalFor(u, a.platform, pol, manual).status === 'approved').map((u) => u.uid);
    if (!ids.length) { deviceEvent(a.id, 'patch', `Patch window "${pol.name}": nothing approved to install`); continue; }
    const reboot = pol.reboot?.mode === 'auto' || pol.reboot?.mode === 'notify';
    const delay = pol.reboot?.mode === 'notify' ? pol.reboot.delay : 2;
    let r;
    try {
      r = queueJobs({
        agents: [a], name: `Patch window: ${pol.name}`, task: 'updates.install', timeout: 14400, createdBy: 'patch manager',
        build: (x) => buildTask('updates.install', x.platform, { ids: ids.join(','), reboot, reboot_delay: delay, restore: !!pol.options?.restore_point }),
      });
    } catch (e) { deviceEvent(a.id, 'patch', `Patch window "${pol.name}" could not start: ${e.message}`); continue; }
    if (r.created) deviceEvent(a.id, 'patch', `${late ? 'Catch-up patching (missed window)' : 'Patch window'} "${pol.name}": installing ${ids.length} approved update(s)${reboot ? ', reboot if needed' : ''}`);
  }
}
