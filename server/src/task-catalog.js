// Built-in device tasks (files, updates, software, users, terminal).
// Each task is a PowerShell/bash template in ../task-scripts; the server injects validated arguments
// (base64-encoded, so no quoting/injection issues) and queues it as a normal job.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './util.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'task-scripts');
const TEMPLATES = new Map();
for (const f of fs.readdirSync(DIR)) {
  TEMPLATES.set(f, fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n'));
}

function expand(name, depth = 0) {
  const t = TEMPLATES.get(name);
  if (t == null || depth > 3) return null;
  return t.replace(/^#__INCLUDE:([\w.-]+)__$/gm, (_, inc) => {
    const body = expand(inc, depth + 1);
    if (body == null) throw new Error(`missing include ${inc}`);
    return body;
  });
}

// ---------- validation helpers ----------
const S = (v, max = 4096) => String(v ?? '').replace(/\0/g, '').slice(0, max);
const need = (v, label) => { if (!v) throw new HttpError(400, `${label} is required`); return v; };
const flag = (v) => (v === true || v === '1' || v === 1 ? '1' : v === false || v === '0' || v === 0 ? '0' : '');
const WIN_USER = /^[^"/\\[\]:;|=,+*?<>@]{1,20}$/;
const LIN_USER = /^[a-z_][a-z0-9_.-]{0,31}$/;
const LIN_PKG = /^[A-Za-z0-9][A-Za-z0-9.+_:@~-]{0,200}$/;
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,200}$/;

function userName(a, platform) {
  const n = need(S(a.name, 64).trim(), 'Username');
  if (!(platform === 'windows' ? WIN_USER : LIN_USER).test(n)) throw new HttpError(400, `"${n}" is not a valid username`);
  return n;
}
function pkg(a, platform, key = 'name') {
  const n = need(S(a[key], 300).trim(), 'Package');
  if (platform === 'linux' && !LIN_PKG.test(n)) throw new HttpError(400, `"${n}" is not a valid package name`);
  return n;
}
function password(a, required) {
  const p = S(a.password, 256);
  if (required && !p) throw new HttpError(400, 'Password is required');
  if (p && p.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  return p;
}
const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

function regPath(v, allowEmpty = false) {
  const p = S(v, 1000).trim().replace(/\//g, '\\');
  if (!p && allowEmpty) return '';
  if (!/^(HKLM|HKU|HKCR|HKCC|HKEY_LOCAL_MACHINE|HKEY_USERS|HKEY_CLASSES_ROOT|HKEY_CURRENT_CONFIG)(\\.*)?$/i.test(p) || /[\0\r\n\t]/.test(p)) throw new HttpError(400, 'Registry path must start with HKLM, HKU, HKCR or HKCC');
  return p;
}

// ---------- firewall rule validation ----------
const PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;
const ADDRS = /^[A-Za-z0-9:.\/-]+(,[A-Za-z0-9:.\/-]+)*$/;
const oneOf = (v, list, label) => { if (!list.includes(v)) throw new HttpError(400, `Invalid ${label}`); return v; };
const noCtl = (v, max, label) => { const s = S(v, max + 1); if (s.length > max || /[\x00-\x1f]/.test(s)) throw new HttpError(400, `${label} is too long or has invalid characters`); return s.trim(); };
function fwPorts(v, label) {
  const s = S(v, 300).replace(/\s+/g, '').toLowerCase();
  if (!s || s === 'any') return s;
  if (!PORTS.test(s) || s.split(/[,-]/).some((n) => Number(n) < 1 || Number(n) > 65535)) throw new HttpError(400, `${label}: use numbers 1-65535, ranges (1000-2000) or a comma list`);
  return s;
}
function fwId(a) { return need(noCtl(a.id, 1000, 'Rule id'), 'Rule id'); }
/** full=true: create/modify with every field; full=false: only fields that were sent (enable/disable). */
function fwArgs(a, platform, isNew) {
  const out = {};
  const has = (k) => a[k] !== undefined && a[k] !== null;
  if (isNew || has('direction')) {
    out.name = need(noCtl(a.name, 200, 'Name'), 'Name');
    out.direction = oneOf(S(a.direction), ['in', 'out'], 'direction');
    out.action = oneOf(S(a.action), ['allow', 'block'], 'action');
    out.protocol = oneOf(S(a.protocol || 'any').toLowerCase(), ['any', 'tcp', 'udp', 'icmpv4', 'icmpv6'], 'protocol');
    out.local_port = fwPorts(a.local_port, 'Local port') || 'any';
    out.remote_port = fwPorts(a.remote_port, 'Remote port') || 'any';
    if ((out.local_port !== 'any' || out.remote_port !== 'any') && !['tcp', 'udp'].includes(out.protocol)) throw new HttpError(400, 'Ports need protocol TCP or UDP');
    const addr = S(a.remote_address, 1000).replace(/\s+/g, '');
    if (addr && addr.toLowerCase() !== 'any' && !ADDRS.test(addr)) throw new HttpError(400, 'Remote address: use IPs, subnets (10.0.0.0/8), ranges or keywords like LocalSubnet, comma-separated');
    out.remote_address = !addr || addr.toLowerCase() === 'any' ? 'any' : addr;
    if (platform === 'windows') {
      out.program = noCtl(a.program, 260, 'Program');
      out.program_set = '1';
      const prof = S(a.profile || 'any').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
      if (!prof.length || prof.includes('any')) out.profile = 'any';
      else { prof.forEach((x) => oneOf(x, ['domain', 'private', 'public'], 'profile')); out.profile = prof.join(','); }
      out.description = noCtl(a.description, 500, 'Description');
      out.description_set = '1';
    } else if (out.remote_port !== 'any') {
      throw new HttpError(400, 'Remote ports are only supported on Windows');
    }
  }
  if (isNew || has('enabled')) out.enabled = flag(a.enabled ?? true) || '1';
  if (!isNew && !Object.keys(out).length) throw new HttpError(400, 'Nothing to change');
  return out;
}

/**
 * title(args) -> job name; args(raw, platform) -> validated {key: string}; timeout seconds;
 * wait: seconds the API call waits for a result (0 = return immediately);
 * secret: arg names masked in job history; internal: only queued by the server itself.
 */
export const TASKS = {
  'files.list': { title: (a) => `Browse ${a.path || 'drives'}`, timeout: 60, wait: 45, args: (a) => ({ path: S(a.path) }) },
  'files.delete': { title: (a) => `Delete ${a.path}`, timeout: 900, wait: 60, args: (a) => ({ path: need(S(a.path), 'Path') }) },
  'files.rename': {
    title: (a) => `Rename ${a.path} to ${a.to}`, timeout: 120, wait: 45,
    args: (a) => {
      const to = need(S(a.to, 255).trim(), 'New name');
      if (/[\\/:*?"<>|]/.test(to)) throw new HttpError(400, 'Name contains characters that are not allowed');
      return { path: need(S(a.path), 'Path'), to };
    },
  },
  'files.mkdir': { title: (a) => `New folder ${a.path}`, timeout: 60, wait: 45, args: (a) => ({ path: need(S(a.path), 'Path') }) },
  'files.get': { internal: true, title: (a) => `Download ${a.path}`, timeout: 7200, args: (a) => ({ path: S(a.path), url: S(a.url) }) },
  'files.put': { internal: true, title: (a) => `Upload to ${a.path}`, timeout: 7200, args: (a) => ({ path: S(a.path), url: S(a.url) }) },

  'updates.scan': { title: () => 'Scan for OS updates', timeout: 3600, wait: 0, args: () => ({}) },
  'updates.install': {
    title: (a) => (a.ids === 'all' ? 'Install all OS updates' : `Install ${a.ids.split(',').length} OS update(s)`) + (a.reboot === '1' ? ' + reboot' : ''),
    timeout: 14400, wait: 0,
    args: (a) => {
      let ids = 'all';
      if (a.ids && a.ids !== 'all') {
        const list = (Array.isArray(a.ids) ? a.ids : String(a.ids).split(',')).map((x) => String(x).trim()).filter((x) => /^[\w.+:@~-]{1,200}$/.test(x));
        if (!list.length) throw new HttpError(400, 'No valid updates selected');
        ids = list.join(',');
      }
      // reboot_delay: minutes the user gets (with an on-screen warning) before the restart; restore: Windows restore point first
      const delay = Math.max(0, Math.min(240, Math.round(Number(a.reboot_delay) || 2)));
      return { ids, reboot: flag(a.reboot) || '0', reboot_delay: String(delay), restore: flag(a.restore) || '0' };
    },
  },

  'software.uninstall': { title: (a) => `Uninstall ${a.name}`, timeout: 3600, wait: 0, args: (a, p) => ({ name: pkg(a, p) }) },
  'software.reinstall': { title: (a) => `Reinstall ${a.name}`, timeout: 3600, wait: 0, args: (a, p) => ({ name: pkg(a, p) }) },
  'software.install': {
    title: (a) => `Install ${a.id}`, timeout: 3600, wait: 0,
    args: (a, p) => {
      const id = need(S(a.id, 200).trim(), 'Package');
      if (!(p === 'windows' ? WINGET_ID : LIN_PKG).test(id)) throw new HttpError(400, `"${id}" is not a valid ${p === 'windows' ? 'winget ID' : 'package name'}`);
      return { id };
    },
  },
  'software.search': { title: (a) => `Search packages: ${a.query}`, timeout: 180, wait: 120, args: (a) => ({ query: need(S(a.query, 100).trim(), 'Search text') }) },

  'users.list': { title: () => 'List local users', timeout: 120, wait: 60, args: () => ({}) },
  'users.create': {
    title: (a) => `Create user ${a.name}`, timeout: 120, wait: 60, secret: ['password'],
    args: (a, p) => ({ name: userName(a, p), password: password(a, true), fullname: S(a.fullname, 100), admin: flag(a.admin) || '0', must_change: flag(a.must_change) || '0' }),
  },
  'users.update': {
    title: (a) => `Modify user ${a.name}`, timeout: 120, wait: 60, secret: ['password'],
    args: (a, p) => ({
      name: userName(a, p), password: password(a, false), enabled: flag(a.enabled), admin: flag(a.admin),
      fullname: S(a.fullname, 100), fullname_set: a.fullname === undefined ? '0' : '1', must_change: flag(a.must_change) || '0',
    }),
  },
  'users.delete': {
    title: (a) => `Delete user ${a.name}`, timeout: 600, wait: 90,
    args: (a, p) => {
      const name = userName(a, p);
      if (p === 'linux' && name === 'root') throw new HttpError(400, "Refusing to delete root");
      return { name, remove_home: flag(a.remove_home) || '0' };
    },
  },

  'hardware.disks': { title: () => 'Read disk health (SMART)', timeout: 180, wait: 120, args: () => ({}) },
  'hardware.usb': { title: () => 'List USB devices', timeout: 120, wait: 90, args: () => ({}) },
  'hardware.printers': { title: () => 'List printers and scanners', timeout: 120, wait: 90, args: () => ({}) },

  'fw.list': { title: () => 'List firewall rules', timeout: 180, wait: 120, args: () => ({}) },
  'fw.create': { title: (a) => `Create firewall rule ${a.name}`, timeout: 120, wait: 60, args: (a, p) => fwArgs(a, p, true) },
  'fw.update': {
    title: (a) => (a.direction ? `Modify firewall rule ${a.name || a.id}` : `${a.enabled === '1' ? 'Enable' : 'Disable'} firewall rule ${a.id}`),
    timeout: 120, wait: 60, args: (a, p) => ({ id: fwId(a), ...fwArgs(a, p, false) }),
  },
  'fw.delete': { title: (a) => `Delete firewall rule ${a.id}`, timeout: 120, wait: 60, args: (a) => ({ id: fwId(a) }) },

  'proc.list': { title: () => 'List processes', timeout: 120, wait: 60, args: () => ({}) },
  'proc.kill': {
    title: (a) => `End process ${a.pid}`, timeout: 60, wait: 45,
    args: (a) => { const pid = Number(a.pid); if (!Number.isInteger(pid) || pid <= 4) throw new HttpError(400, 'Invalid process ID'); return { pid: String(pid), tree: flag(a.tree) || '0' }; },
  },
  'svc.list': { title: () => 'List services', timeout: 120, wait: 60, args: () => ({}) },
  'svc.control': {
    title: (a) => `Service ${a.name}: ${a.action}`, timeout: 120, wait: 90,
    args: (a) => {
      const name = need(S(a.name, 200).trim(), 'Service');
      if (!/^[\w.@:+ -]{1,200}$/.test(name)) throw new HttpError(400, 'Invalid service name');
      return { name, action: oneOf(S(a.action), ['start', 'stop', 'restart', 'auto', 'manual', 'disabled'], 'action') };
    },
  },
  'reg.list': { title: (a) => `Registry: ${a.path || 'roots'}`, timeout: 60, wait: 45, args: (a) => ({ path: regPath(a.path, true) }) },
  'reg.set': {
    title: (a) => `Set registry value ${a.path}\\${a.name}`, timeout: 60, wait: 45,
    args: (a) => ({ path: regPath(a.path), name: S(a.name, 255), type: oneOf(S(a.type), ['String', 'ExpandString', 'MultiString', 'DWord', 'QWord', 'Binary'], 'type'), data: S(a.data, 100000) }),
  },
  'reg.delete': {
    title: (a) => (a.what === 'key' ? `Delete registry key ${a.path}` : `Delete registry value ${a.path}\\${a.name}`), timeout: 120, wait: 60,
    args: (a) => ({ path: regPath(a.path), what: a.what === 'key' ? 'key' : 'value', name: S(a.name, 255) }),
  },
  'reg.newkey': {
    title: (a) => `New registry key ${a.path}\\${a.name}`, timeout: 60, wait: 45,
    args: (a) => { const name = need(S(a.name, 255).trim(), 'Key name'); if (/[\\]/.test(name)) throw new HttpError(400, 'Key name cannot contain \\'); return { path: regPath(a.path), name }; },
  },
  'net.scan': {
    internal: true, title: (a) => `Network discovery ${a.subnet}`, timeout: 900,
    args: (a) => {
      const community = S(a.community, 64);
      if (community && !/^[\w.@#$%^&*!+=-]{1,32}$/.test(community)) throw new HttpError(400, 'Invalid SNMP community');
      return { subnet: need(S(a.subnet, 20), 'Subnet'), community };
    },
  },
  // wait > 0: only sent to online devices (a queued reboot mustn't fire hours later when an offline device returns)
  'power.reboot': {
    title: (a) => `${a.mode === 'shutdown' ? 'Shut down' : 'Restart'} ${a.delay === '0' ? 'now' : `in ${a.delay} min`}`, timeout: 120, wait: 30,
    args: (a) => {
      const delay = Math.round(Number(a.delay ?? 0));
      if (!Number.isFinite(delay) || delay < 0 || delay > 1440) throw new HttpError(400, 'Delay must be 0-1440 minutes');
      return { mode: oneOf(S(a.mode || 'restart'), ['restart', 'shutdown'], 'mode'), delay: String(delay), message: noCtl(a.message, 200, 'Message') };
    },
  },
  'power.cancel': { title: () => 'Cancel scheduled restart / shutdown', timeout: 60, wait: 30, args: () => ({}) },
  'roles.detect': { internal: true, title: () => 'Detect server roles', timeout: 300, args: () => ({}) },
  'screenshot.take': { internal: true, title: () => 'Take a screenshot', timeout: 120, args: (a) => ({ url: S(a.url) }) },
  'net.wake': {
    internal: true, title: (a) => `Wake-on-LAN ${a.label}`.trim(), timeout: 60,
    args: (a) => ({
      macs: need(S(a.macs, 400), 'MAC address'), bcasts: need(S(a.bcasts, 200), 'Broadcast address'), label: S(a.label, 120),
    }),
  },
  'metrics.live': { internal: true, title: () => 'Live performance monitor', timeout: 3600, args: (a) => ({ url: S(a.url) }) },
  'terminal.open': {
    internal: true, title: (a) => ({ powershell: 'PowerShell session', cmd: 'Command Prompt session' }[a.shell] || 'Terminal session'), timeout: 12 * 3600,
    args: (a) => ({ in: S(a.in), out: S(a.out), close: S(a.close), shell: ['cmd', 'powershell'].includes(a.shell) ? a.shell : 'bash' }),
  },
};

export function getTask(task, { allowInternal = false } = {}) {
  const def = TASKS[task];
  if (!def || (def.internal && !allowInternal)) throw new HttpError(400, `Unknown task ${task}`);
  return def;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function argsBlock(args, platform) {
  if (platform === 'windows') {
    return ['$A = @{}', ...Object.entries(args).map(([k, v]) => `$A['${k}'] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(v)}'))`)].join('\n');
  }
  const dec = platform === 'macos' ? 'base64 -D' : 'base64 -d'; // macOS (BSD) base64 decodes with -D
  return Object.entries(args).map(([k, v]) => `A_${k}="$(printf '%s' '${b64(v)}' | ${dec})"`).join('\n');
}

// macOS: a task uses <task>.mac.sh when present, otherwise the Linux .sh only if it is known to be portable
const MAC_PORTABLE = new Set(['files.get', 'files.put', 'files.rename', 'files.mkdir', 'hardware.printers', 'net.wake', 'power.reboot', 'power.cancel']);
function templateFor(task, platform) {
  if (platform === 'windows') return expand(`${task}.ps1`);
  if (platform === 'macos') return expand(`${task}.mac.sh`) ?? (MAC_PORTABLE.has(task) ? expand(`${task}.sh`) : null);
  return expand(`${task}.sh`);
}

function displayBlock(args, secret = []) {
  return ['# Arguments:', ...Object.entries(args).map(([k, v]) => `#   ${k} = ${secret.includes(k) && v ? '********' : String(v).replace(/\n/g, ' ')}`)].join('\n');
}

const PS_PRELUDE = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12\n";

/** Returns {shell, body, displayBody, name, timeout} or null when the task has no script for this platform. */
export function buildTask(task, platform, rawArgs = {}, opts = {}) {
  const def = getTask(task, opts);
  const tpl = templateFor(task, platform);
  if (tpl == null) return null;
  const args = def.args(rawArgs || {}, platform);
  const prelude = platform === 'windows' ? PS_PRELUDE : '';
  return {
    shell: platform === 'windows' ? 'powershell' : 'bash',
    body: prelude + tpl.replaceAll('#__ARGS__', argsBlock(args, platform)),
    displayBody: prelude + tpl.replaceAll('#__ARGS__', displayBlock(args, def.secret)),
    name: def.title(args),
    timeout: def.timeout,
    args,
  };
}

export const supportsTask = (task, platform) => platform === 'windows' ? TEMPLATES.has(`${task}.ps1`)
  : platform === 'macos' ? TEMPLATES.has(`${task}.mac.sh`) || (MAC_PORTABLE.has(task) && TEMPLATES.has(`${task}.sh`)) : TEMPLATES.has(`${task}.sh`);
export { base as baseName };
