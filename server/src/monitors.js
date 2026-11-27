// Custom monitors with auto-remediation: a condition checked on a group of devices; when it fails HostPilot opens an
// alert (optionally a ticket) and can run a fix (restart the service, or any library script) automatically.
// Conditions are checked on the server from check-in data, or on the device by a small script (process, port, event log, script).
import { all, get, run, audit } from './db.js';
import { HttpError } from './util.js';
import { queueJobs, isPolling } from './jobs.js';
import { buildTask } from './task-catalog.js';
import { openAlert, resolveAlert } from './alerts.js';
import { deviceEvent } from './history.js';

const ONLINE_WINDOW = 3 * 60 * 1000;
const isOnline = (a) => isPolling(a.id) || (a.last_seen && Date.now() - a.last_seen < ONLINE_WINDOW);
const PLATFORMS = ['any', 'windows', 'linux', 'macos'];
const CLASSES = ['desktop', 'laptop', 'server', 'vm'];
const NAME = /^[\w .@:+$()-]{1,100}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/;

// p: param definitions shown in the editor [key, label, kind, default, extra]
export const TYPES = {
  cpu: { label: 'CPU usage too high', group: 'Performance', p: [['threshold', 'Above (%)', 'num', 90], ['minutes', 'For at least (minutes)', 'num', 10]] },
  memory: { label: 'Memory usage too high', group: 'Performance', p: [['threshold', 'Above (%)', 'num', 90], ['minutes', 'For at least (minutes)', 'num', 10]] },
  disk: { label: 'Disk almost full', group: 'Performance', p: [['threshold', 'Used above (%)', 'num', 90], ['mount', 'Only this drive / mount (empty = any)', 'text', '']] },
  offline: { label: 'Device offline', group: 'Availability', p: [['minutes', 'Offline for (minutes)', 'num', 30]] },
  uptime: { label: 'Not restarted for a long time', group: 'Availability', p: [['days', 'Up for more than (days)', 'num', 30]] },
  reboot_pending: { label: 'Restart pending after updates', group: 'Availability', p: [['hours', 'Pending for more than (hours)', 'num', 24]] },
  service: { label: 'Service not running', group: 'Services & processes', p: [['name', 'Service name (e.g. Spooler, nginx)', 'text', '']], fix: 'Start the service again automatically' },
  process: { label: 'Process not running', group: 'Services & processes', device: true, p: [['name', 'Process name (e.g. outlook, sshd)', 'text', ''], ['interval', 'Check every (minutes)', 'num', 15]] },
  port: { label: 'TCP port not answering', group: 'Services & processes', device: true, p: [['port', 'Port', 'num', 443], ['host', 'Host (checked from the device)', 'text', '127.0.0.1'], ['interval', 'Check every (minutes)', 'num', 15]] },
  event_log: { label: 'Windows event logged', group: 'Services & processes', device: true, platforms: ['windows'], p: [['log', 'Log', 'text', 'System'], ['ids', 'Event IDs (comma separated)', 'text', '41,6008'], ['minutes', 'In the last (minutes)', 'num', 60], ['interval', 'Check every (minutes)', 'num', 15]] },
  software_missing: { label: 'Required software missing', group: 'Software', p: [['name', 'Name contains (e.g. CrowdStrike)', 'text', '']] },
  software_present: { label: 'Prohibited software installed', group: 'Software', p: [['name', 'Name contains (e.g. TeamViewer)', 'text', '']] },
  script: { label: 'Script check (fails on a non-zero exit code)', group: 'Custom', device: true, p: [['script_id', 'Script', 'script', null], ['interval', 'Check every (minutes)', 'num', 60]] },
};
export const SEVERITIES = ['info', 'warning', 'critical'];

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const presentMonitor = (m) => ({ ...m, enabled: !!m.enabled, target: parse(m.target, {}), params: parse(m.params, {}), actions: parse(m.actions, {}) });

export function cleanMonitor(b) {
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Name is required');
  const def = TYPES[b.type];
  if (!def) throw new HttpError(400, 'Pick a condition');
  const t = b.target || {};
  const target = {
    platform: PLATFORMS.includes(t.platform) ? t.platform : 'any',
    clients: (Array.isArray(t.clients) ? t.clients : []).map(Number).filter(Number.isInteger).slice(0, 500),
    classes: (Array.isArray(t.classes) ? t.classes : []).filter((c) => CLASSES.includes(c)),
    agents: (Array.isArray(t.agents) ? t.agents : []).map(String).filter((x) => /^[\w-]{1,64}$/.test(x)).slice(0, 5000),
  };
  if (def.platforms && target.platform === 'any') target.platform = def.platforms[0];
  const raw = b.params || {};
  const params = {};
  for (const [k, label, kind, dflt] of def.p) {
    let v = raw[k] ?? dflt;
    if (kind === 'num') {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${label}: enter a number`);
      if (k === 'interval') v = Math.max(5, Math.min(1440, Math.round(v)));
      if (k === 'threshold') v = Math.max(1, Math.min(100, v));
      if (k === 'port' && (v < 1 || v > 65535)) throw new HttpError(400, 'Port must be 1-65535');
      v = Math.round(v * 10) / 10;
    } else if (kind === 'script') {
      v = Number(v);
      if (!get('SELECT id FROM scripts WHERE id=?', v)) throw new HttpError(400, 'Pick a script');
    } else {
      v = String(v ?? '').trim().slice(0, 200);
      if (k === 'name' && !NAME.test(v)) throw new HttpError(400, `${label.split(' (')[0]}: letters, numbers, spaces and . _ - only`);
      if (k === 'host' && !HOST.test(v)) throw new HttpError(400, 'Host: a name or IP address');
      if (k === 'ids' && !/^\d{1,6}(\s*,\s*\d{1,6})*$/.test(v)) throw new HttpError(400, 'Event IDs: numbers separated by commas');
      if (k === 'log' && !/^[\w /-]{1,100}$/.test(v)) throw new HttpError(400, 'Invalid log name');
      if (k === 'mount' && v && !/^[\w:\\/ .-]{1,200}$/.test(v)) throw new HttpError(400, 'Invalid drive');
    }
    params[k] = v;
  }
  const a = b.actions || {};
  const actions = {
    fix_script_id: a.fix_script_id ? Number(a.fix_script_id) : null,
    restart_service: def.fix ? !!a.restart_service : false,
    ticket: !!a.ticket,
    max_fixes: Math.max(1, Math.min(20, Math.round(Number(a.max_fixes) || 3))),
  };
  if (actions.fix_script_id && !get('SELECT id FROM scripts WHERE id=?', actions.fix_script_id)) throw new HttpError(400, 'Remediation script not found');
  return {
    name, type: b.type, enabled: b.enabled === false ? 0 : 1, severity: SEVERITIES.includes(b.severity) ? b.severity : 'warning',
    target: JSON.stringify(target), params: JSON.stringify(params), actions: JSON.stringify(actions),
  };
}

const matches = (m, a) => {
  const t = m.target || {};
  if (TYPES[m.type]?.platforms && !TYPES[m.type].platforms.includes(a.platform)) return false;
  if (t.agents?.length) return t.agents.includes(a.id);
  return (t.platform === 'any' || !t.platform || t.platform === a.platform)
    && (!t.clients?.length || t.clients.includes(a.client_id))
    && (!t.classes?.length || t.classes.includes(a.device_class || 'desktop'));
};

export const listMonitors = () => all('SELECT * FROM monitors ORDER BY name COLLATE NOCASE').map(presentMonitor);
export const monitorTargets = (m) => all('SELECT id, hostname, platform, client_id, device_class FROM agents').filter((a) => matches(m, a));

/** service names that "service not running" monitors want the device to report (merged into its watch list) */
export function monitorServicesFor(a) {
  try {
    return listMonitors().filter((m) => m.enabled && m.type === 'service' && matches(m, a)).map((m) => m.params.name);
  } catch { return []; }
}

// ---------- device-side check scripts ----------
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
function checkScript(m, platform) {
  const p = m.params;
  const win = platform === 'windows';
  switch (m.type) {
    case 'process': {
      const n = p.name.replace(/\.exe$/i, '');
      return win
        ? { shell: 'powershell', body: `if (Get-Process -Name ${psq(n)} -ErrorAction SilentlyContinue) { "${n} is running"; exit 0 } else { "${n} is not running"; exit 1 }` }
        : { shell: 'bash', body: `if pgrep -x -- ${shq(n.slice(0, 15))} >/dev/null 2>&1; then echo ${shq(`${n} is running`)}; else echo ${shq(`${n} is not running`)}; exit 1; fi` };
    }
    case 'port':
      return win
        ? { shell: 'powershell', body: `$c = New-Object Net.Sockets.TcpClient\ntry { $ok = $c.ConnectAsync(${psq(p.host)}, ${p.port}).Wait(5000) } catch { $ok = $false }\n$c.Close()\nif ($ok) { "${p.host}:${p.port} is answering"; exit 0 } else { "${p.host}:${p.port} is not answering"; exit 1 }` }
        : { shell: 'bash', body: `if timeout 5 bash -c ${shq(`exec 3<>/dev/tcp/${p.host}/${p.port}`)} 2>/dev/null; then echo ${shq(`${p.host}:${p.port} is answering`)}; else echo ${shq(`${p.host}:${p.port} is not answering`)}; exit 1; fi` };
    case 'event_log':
      if (!win) return null;
      return { shell: 'powershell', body: `$ev = @(Get-WinEvent -FilterHashtable @{ LogName = ${psq(p.log)}; Id = @(${p.ids.split(',').map((x) => Number(x)).join(',')}); StartTime = (Get-Date).AddMinutes(-${p.minutes}) } -MaxEvents 5 -ErrorAction SilentlyContinue)
if ($ev.Count) { $e = $ev[0]; "Event $($e.Id) in ${p.log} at $($e.TimeCreated): $(($e.Message -split "\`n")[0])"; exit 1 } else { 'No matching events'; exit 0 }` };
    case 'script': {
      const s = get('SELECT shell, body FROM scripts WHERE id=?', p.script_id);
      return s ? { shell: s.shell, body: s.body } : null;
    }
    default: return null;
  }
}

// ---------- evaluation ----------
function stateRow(m, a) {
  return get('SELECT * FROM monitor_state WHERE monitor_id=? AND agent_id=?', m.id, a.id)
    || { monitor_id: m.id, agent_id: a.id, state: null, since: null, remediations: 0, fresh: true };
}
function saveState(s) {
  run(`INSERT INTO monitor_state(monitor_id, agent_id, state, since, detail, checked_at, job_id, last_job_at, remediated_at, remediations) VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(monitor_id, agent_id) DO UPDATE SET state=excluded.state, since=excluded.since, detail=excluded.detail, checked_at=excluded.checked_at,
       job_id=excluded.job_id, last_job_at=excluded.last_job_at, remediated_at=excluded.remediated_at, remediations=excluded.remediations`,
  s.monitor_id, s.agent_id, s.state, s.since, s.detail, s.checked_at, s.job_id, s.last_job_at, s.remediated_at, s.remediations || 0);
}

/** Server-side condition: { fail: bool, detail } or { pending: true } (true but not long enough) or null (no data). */
function serverCheck(m, a, s) {
  const p = m.params, t = Date.now();
  const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  switch (m.type) {
    case 'cpu': case 'memory': {
      const col = m.type === 'cpu' ? 'cpu' : 'mem';
      const r = get(`SELECT AVG(${col}) AS v, COUNT(*) AS n, MIN(ts) AS first FROM metrics WHERE agent_id=? AND ts>? AND ${col} IS NOT NULL`, a.id, t - p.minutes * 60000);
      if (!r || r.n < 2 || r.first > t - p.minutes * 60000 * 0.6) return null; // not enough samples in the window yet
      return { fail: r.v >= p.threshold, detail: `${m.type === 'cpu' ? 'CPU' : 'Memory'} averaged ${Math.round(r.v)}% over ${p.minutes} min (limit ${p.threshold}%)` };
    }
    case 'disk': {
      const disks = json(a.disks, []).filter((d) => d.total > 0 && (!p.mount || String(d.mount).toLowerCase().startsWith(p.mount.toLowerCase())));
      if (!disks.length) return null;
      const full = disks.map((d) => ({ m: d.mount, pct: ((d.total - d.free) / d.total) * 100 })).filter((d) => d.pct >= p.threshold);
      return { fail: full.length > 0, detail: full.length ? `${full.map((d) => `${d.m} ${Math.round(d.pct)}%`).join(', ')} full (limit ${p.threshold}%)` : 'Enough free space' };
    }
    case 'offline': {
      const off = !isOnline(a) && a.last_seen && t - a.last_seen > p.minutes * 60000;
      return { fail: !!off, detail: off ? `Offline since ${new Date(a.last_seen).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Online' };
    }
    case 'uptime': {
      if (!a.boot_time) return null;
      const days = (t - a.boot_time) / 86400000;
      return { fail: days > p.days, detail: `Up for ${Math.floor(days)} day(s) (limit ${p.days})` };
    }
    case 'reboot_pending': {
      if (!a.reboot_required) return { fail: false, detail: 'No restart pending' };
      const since = s.state === 'fail' || s.state === 'pending' ? s.since : t;
      return t - since >= p.hours * 3600000 ? { fail: true, detail: `Restart pending for ${Math.round((t - since) / 3600000)} hour(s)`, since } : { pending: true, since, detail: 'Restart pending' };
    }
    case 'service': {
      const svc = json(a.services, []).find((x) => String(x.name).toLowerCase() === p.name.toLowerCase());
      if (!svc) return null; // device hasn't reported it yet (it does from the next check-in)
      if (svc.status === 'missing') return { fail: true, detail: `Service ${p.name} is not installed`, noFix: true };
      return { fail: svc.status !== 'running', detail: `Service ${svc.display || p.name} is ${svc.status}` };
    }
    case 'software_missing': case 'software_present': {
      if (!a.inventory_at) return null;
      const hit = get('SELECT name, version FROM software WHERE agent_id=? AND name LIKE ? LIMIT 1', a.id, `%${p.name}%`);
      return m.type === 'software_missing'
        ? { fail: !hit, detail: hit ? `${hit.name} ${hit.version || ''} is installed` : `Nothing matching "${p.name}" is installed` }
        : { fail: !!hit, detail: hit ? `${hit.name} ${hit.version || ''} is installed` : `"${p.name}" is not installed` };
    }
    default: return null;
  }
}

function remediate(m, a, s, res) {
  const act = m.actions || {};
  if (res.noFix || (!act.fix_script_id && !act.restart_service)) return;
  const t = Date.now();
  if (s.remediated_at && t - s.remediated_at < 30 * 60000) return; // give the last fix time to work
  if (s.remediated_at && t - s.remediated_at > 24 * 3600000) s.remediations = 0;
  if ((s.remediations || 0) >= (act.max_fixes || 3)) return;
  if (!isOnline(a)) return;
  let r = null;
  try {
    if (act.restart_service && m.type === 'service') {
      r = queueJobs({ agents: [a], name: `Auto-fix (${m.name}): start ${m.params.name}`, task: 'svc.control', timeout: 120, createdBy: 'monitor',
        build: (x) => buildTask('svc.control', x.platform, { name: m.params.name, action: 'start' }) });
    } else if (act.fix_script_id) {
      const sc = get('SELECT * FROM scripts WHERE id=?', act.fix_script_id);
      if (sc) r = queueJobs({ agents: [a], name: `Auto-fix (${m.name}): ${sc.name}`, shell: sc.shell, body: sc.body, timeout: sc.timeout, scriptId: sc.id, createdBy: 'monitor' });
    }
  } catch (e) { console.error('[monitor fix]', e.message); }
  if (r?.created) {
    s.remediated_at = t; s.remediations = (s.remediations || 0) + 1;
    deviceEvent(a.id, 'monitor', `Monitor "${m.name}": running the automatic fix (attempt ${s.remediations})`);
  }
}

function apply(m, a, s, res) {
  const t = Date.now();
  s.checked_at = t;
  if (!res) { saveState(s); return; }
  const type = `monitor:${m.id}`;
  if (res.pending) { s.state = 'pending'; s.since = res.since || s.since || t; s.detail = res.detail; saveState(s); return; }
  if (res.fail) {
    if (s.state !== 'fail') {
      s.since = res.since || t;
      deviceEvent(a.id, 'monitor', `Monitor "${m.name}" failed: ${res.detail}`);
    }
    s.state = 'fail'; s.detail = res.detail;
    openAlert(a, type, m.severity, `${m.name}: ${res.detail}`, { ticket: !!m.actions?.ticket, monitorId: m.id });
    remediate(m, a, s, res);
  } else {
    if (s.state === 'fail') {
      resolveAlert(a, type, `${m.name}: ${res.detail}`);
      deviceEvent(a.id, 'monitor', `Monitor "${m.name}" is OK again${s.remediated_at && t - s.remediated_at < 2 * 3600000 ? ' (after the automatic fix)' : ''}`);
    }
    if (s.state !== 'ok') s.since = t;
    s.state = 'ok'; s.detail = res.detail; s.remediations = 0;
  }
  saveState(s);
}

/** Every minute: evaluate server-side monitors and queue device-side checks that are due. */
export function runMonitors() {
  const monitors = listMonitors().filter((m) => m.enabled);
  if (!monitors.length) return;
  const agents = all('SELECT * FROM agents');
  const t = Date.now();
  for (const m of monitors) {
    const def = TYPES[m.type];
    if (!def) continue;
    for (const a of agents.filter((x) => matches(m, x))) {
      if (a.maintenance) continue;
      const s = stateRow(m, a);
      if (def.device) {
        if (!isOnline(a)) continue;
        const due = !s.last_job_at || t - s.last_job_at >= (m.params.interval || 15) * 60000;
        const running = s.job_id && get("SELECT 1 FROM jobs WHERE id=? AND status IN ('queued','running')", s.job_id);
        if (!due || running) continue;
        const sc = checkScript(m, a.platform);
        if (!sc) continue;
        const r = queueJobs({ agents: [a], name: `Monitor: ${m.name}`, task: 'monitor.check', shell: sc.shell, body: sc.body, timeout: 120, createdBy: 'monitor' });
        s.last_job_at = t;
        if (r.created) s.job_id = r.jobs[0].id;
        saveState(s);
      } else {
        if (m.type !== 'offline' && !isOnline(a)) continue; // keep the last state while the device is away
        apply(m, a, s, serverCheck(m, a, s));
      }
    }
  }
}

/** A device-side check finished. */
export function ingestMonitorCheck(j) {
  const s = get('SELECT * FROM monitor_state WHERE job_id=?', j.id);
  if (!s) return;
  const m = get('SELECT * FROM monitors WHERE id=?', s.monitor_id);
  const a = get('SELECT * FROM agents WHERE id=?', s.agent_id);
  if (!m || !a || !m.enabled) return;
  const out = `${j.stdout || ''}\n${j.stderr || ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const detail = (out[out.length - 1] || (j.status === 'success' ? 'OK' : `exit code ${j.exit_code ?? j.status}`)).slice(0, 300);
  if (!['success', 'failed'].includes(j.status)) return; // timed out / lost: try again next interval
  apply(presentMonitor(m), a, s, { fail: j.status !== 'success', detail });
}

/** Status per monitor for the Monitors page. */
export function monitorOverview() {
  const states = all('SELECT ms.*, a.hostname FROM monitor_state ms JOIN agents a ON a.id=ms.agent_id');
  return listMonitors().map((m) => {
    const targets = monitorTargets(m);
    const st = states.filter((s) => s.monitor_id === m.id && targets.some((x) => x.id === s.agent_id));
    return {
      ...m, targets: targets.length, failing: st.filter((s) => s.state === 'fail').length, ok: st.filter((s) => s.state === 'ok').length,
      devices: targets.map((a) => {
        const s = st.find((x) => x.agent_id === a.id);
        return { id: a.id, hostname: a.hostname, platform: a.platform, state: s?.state || 'waiting', detail: s?.detail || '', since: s?.since || null, checked_at: s?.checked_at || null, remediations: s?.remediations || 0, remediated_at: s?.remediated_at || null };
      }).sort((x, y) => (x.state === 'fail' ? 0 : 1) - (y.state === 'fail' ? 0 : 1) || String(x.hostname).localeCompare(String(y.hostname))),
    };
  });
}

export function deleteMonitor(id, username) {
  const m = get('SELECT * FROM monitors WHERE id=?', Number(id));
  if (!m) throw new HttpError(404, 'Monitor not found');
  const t = Date.now();
  run("UPDATE alerts SET status='resolved', resolved_at=?, updated_at=? WHERE type=? AND status IN ('open','ack')", t, t, `monitor:${m.id}`);
  run('DELETE FROM monitors WHERE id=?', m.id);
  audit(username, 'monitor.delete', m.name);
}

/** Ready-made monitors offered on the empty page. */
export const TEMPLATES = [
  { name: 'Print spooler stopped', type: 'service', target: { platform: 'windows' }, params: { name: 'Spooler' }, severity: 'warning', actions: { restart_service: true } },
  { name: 'Windows Update service stopped', type: 'service', target: { platform: 'windows' }, params: { name: 'wuauserv' }, severity: 'warning', actions: { restart_service: true } },
  { name: 'Unexpected shutdown or crash', type: 'event_log', target: { platform: 'windows' }, params: { log: 'System', ids: '41,6008', minutes: 60, interval: 30 }, severity: 'warning', actions: {} },
  { name: 'Restart pending for over a day', type: 'reboot_pending', target: { platform: 'any' }, params: { hours: 24 }, severity: 'info', actions: {} },
  { name: 'Not restarted in 30 days', type: 'uptime', target: { platform: 'any', classes: ['desktop', 'laptop'] }, params: { days: 30 }, severity: 'info', actions: {} },
  { name: 'Server offline', type: 'offline', target: { platform: 'any', classes: ['server'] }, params: { minutes: 10 }, severity: 'critical', actions: { ticket: true } },
  { name: 'SSH not running', type: 'service', target: { platform: 'linux', classes: ['server'] }, params: { name: 'ssh' }, severity: 'critical', actions: { restart_service: true } },
];
