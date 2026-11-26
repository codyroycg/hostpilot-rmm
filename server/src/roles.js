// Role-based monitoring: devices report the server roles they run (domain controller, SQL, IIS, Docker…);
// each role brings a monitor pack of services that are watched continuously and alert when they stop.
import { all, get, run, getSettings, saveSettings } from './db.js';
import { deviceEvent } from './history.js';

/** id → pack. `group` drives the dashboard sections. Services are the candidates; a device watches the ones it has. */
export const PACKS = {
  domain_controller: { label: 'Domain controller', group: 'Core services', icon: '🏛', desc: 'Active Directory: NTDS, Netlogon, Kerberos KDC, DFS Replication, time service, AD Web Services (Samba AD on Linux).' },
  dns_server: { label: 'DNS server', group: 'Core services', icon: '🧭', desc: 'Windows DNS Server, BIND, PowerDNS.' },
  dhcp_server: { label: 'DHCP server', group: 'Core services', icon: '📡', desc: 'Windows DHCP Server, ISC DHCP, Kea.' },
  file_server: { label: 'File server', group: 'Core services', icon: '🗂', desc: 'Windows Server with shared folders (Server service), Samba, NFS.' },
  print_server: { label: 'Print server', group: 'Core services', icon: '🖨', desc: 'Windows Server sharing printers (Print Spooler).' },
  hyperv: { label: 'Hyper-V host', group: 'Virtualization', icon: '🖥', desc: 'Hyper-V Virtual Machine Management and Host Compute Service.' },
  kvm: { label: 'KVM / libvirt host', group: 'Virtualization', icon: '🖥', desc: 'libvirtd.' },
  docker: { label: 'Container host', group: 'Virtualization', icon: '📦', desc: 'Docker and containerd.' },
  sql_server: { label: 'Microsoft SQL Server', group: 'Databases', icon: '🗄', desc: 'SQL Server instances and their SQL Agents.' },
  mysql: { label: 'MySQL / MariaDB', group: 'Databases', icon: '🗄', desc: 'mysqld / mariadb.' },
  postgresql: { label: 'PostgreSQL', group: 'Databases', icon: '🗄', desc: 'PostgreSQL server.' },
  exchange: { label: 'Exchange server', group: 'Messaging', icon: '✉', desc: 'Information Store, Transport, Front End Transport, Service Host.' },
  mail_server: { label: 'Mail server', group: 'Messaging', icon: '✉', desc: 'Postfix, Exim, Dovecot.' },
  iis: { label: 'IIS web server', group: 'Web & proxy', icon: '🌐', desc: 'World Wide Web Publishing Service and Windows Process Activation.' },
  web_server: { label: 'Web server', group: 'Web & proxy', icon: '🌐', desc: 'nginx, Apache, Caddy.' },
  backup: { label: 'Backup server', group: 'Backup', icon: '💾', desc: 'Veeam Backup & Replication and Veeam Agent services.' },
};
export const LEVELS = { off: 'Off (not monitored)', low: 'Low (warning alerts)', high: 'High (critical alerts)' };

export function packLevels() {
  let saved = {};
  try { saved = JSON.parse(getSettings().role_packs || '{}'); } catch { saved = {}; }
  return Object.fromEntries(Object.keys(PACKS).map((id) => [id, LEVELS[saved[id]] ? saved[id] : 'high']));
}
export function savePackLevels(levels) {
  const cur = packLevels();
  for (const [id, lvl] of Object.entries(levels || {})) if (PACKS[id] && LEVELS[lvl]) cur[id] = lvl;
  saveSettings({ role_packs: JSON.stringify(cur) });
  return cur;
}

export const agentRoles = (a) => { try { return a.roles ? JSON.parse(a.roles) : []; } catch { return []; } };

/** service name (lower case) → 'low' | 'high' for the role packs that are switched on for this device. */
export function roleServices(a) {
  const levels = packLevels();
  const out = new Map();
  for (const r of agentRoles(a)) {
    const lvl = levels[r.id];
    if (!lvl || lvl === 'off') continue;
    for (const s of r.services || []) {
      const k = s.toLowerCase();
      if (out.get(k) !== 'high') out.set(k, lvl);
    }
  }
  return out;
}

/** Stores the output of a roles.detect job: lines "ROLE\t<id>\t<svc,svc,…>". */
export function ingestRoles(job) {
  if (job.status !== 'success') return;
  const roles = [];
  for (const line of String(job.stdout || '').split(/\r?\n/)) {
    const f = line.split('\t');
    if (f[0] !== 'ROLE' || !PACKS[f[1]]) continue;
    const services = (f[2] || '').split(',').map((s) => s.trim()).filter((s) => /^[\w.@:+$-]{1,100}$/.test(s)).slice(0, 20);
    if (services.length && !roles.some((r) => r.id === f[1])) roles.push({ id: f[1], services });
  }
  const prev = agentRoles(get('SELECT roles FROM agents WHERE id=?', job.agent_id) || {});
  const before = new Set(prev.map((r) => r.id)), after = new Set(roles.map((r) => r.id));
  for (const r of roles) if (!before.has(r.id)) deviceEvent(job.agent_id, 'role', `Role detected: ${PACKS[r.id].label}`);
  for (const r of prev) if (!after.has(r.id)) deviceEvent(job.agent_id, 'role', `Role no longer detected: ${PACKS[r.id]?.label || r.id}`);
  run('UPDATE agents SET roles=?, roles_at=? WHERE id=?', JSON.stringify(roles), Date.now(), job.agent_id);
}

/** Dashboard: per pack, the devices with that role and the state of each monitored service. */
export function roleDashboard(isOnline) {
  const levels = packLevels();
  const packs = Object.entries(PACKS).map(([id, p]) => ({ id, ...p, level: levels[id], devices: [], ok: 0, failed: 0, offline: 0, unknown: 0 }));
  const byId = new Map(packs.map((p) => [p.id, p]));
  for (const a of all('SELECT id, hostname, platform, client_id, last_seen, roles, services, roles_at FROM agents')) {
    const svc = new Map((() => { try { return JSON.parse(a.services || '[]'); } catch { return []; } })().map((s) => [s.name.toLowerCase(), s]));
    const online = isOnline(a);
    for (const r of agentRoles(a)) {
      const p = byId.get(r.id);
      if (!p) continue;
      const monitors = r.services.map((name) => {
        const s = svc.get(name.toLowerCase());
        const state = !online ? 'offline' : p.level === 'off' ? 'off' : !s ? 'unknown' : s.status === 'running' ? 'ok' : 'failed';
        return { name, display: s?.display || '', status: s?.status || null, state };
      });
      const failed = monitors.filter((m) => m.state === 'failed').length;
      p.devices.push({ id: a.id, hostname: a.hostname, platform: a.platform, online, monitors, state: !online ? 'offline' : failed ? 'failed' : monitors.every((m) => m.state === 'ok') ? 'ok' : 'unknown' });
      for (const m of monitors) p[m.state === 'off' ? 'unknown' : m.state]++;
    }
  }
  for (const p of packs) {
    const total = p.ok + p.failed;
    p.success = total ? Math.round((p.ok / total) * 100) : null;
    p.devices.sort((x, y) => (x.state === 'failed' ? -1 : 0) - (y.state === 'failed' ? -1 : 0) || x.hostname.localeCompare(y.hostname));
  }
  return { packs, levels: LEVELS, scanned: get('SELECT COUNT(*) AS n FROM agents WHERE roles_at IS NOT NULL').n, total: get('SELECT COUNT(*) AS n FROM agents').n };
}
