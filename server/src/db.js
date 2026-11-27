import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed-scripts');
const SHELL_BY_EXT = { '.ps1': 'powershell', '.sh': 'bash', '.cmd': 'cmd', '.py': 'python' };

// Seed files carry metadata in leading "# key: value" comment lines.
function loadSeedScripts() {
  if (!fs.existsSync(SEED_DIR)) return [];
  return fs.readdirSync(SEED_DIR).sort().flatMap((f) => {
    const shell = SHELL_BY_EXT[path.extname(f)];
    if (!shell) return [];
    const text = fs.readFileSync(path.join(SEED_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    const meta = {};
    const lines = text.split('\n');
    let i = 0;
    for (; i < lines.length; i++) {
      const m = lines[i].match(/^(?:#|::|REM)\s*(name|category|description|timeout):\s*(.*)$/i);
      if (!m) break;
      meta[m[1].toLowerCase()] = m[2].trim();
    }
    return [{
      file: f, name: meta.name || f, category: meta.category || 'General', description: meta.description || '',
      timeout: Number(meta.timeout) || 300, shell, body: lines.slice(i).join('\n'),
    }];
  });
}

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'hostpilot.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'tech', created_at INTEGER, last_login INTEGER);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS clients(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, notes TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS enroll_tokens(
  token TEXT PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label TEXT, created_at INTEGER, expires_at INTEGER, uses INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, secret_hash TEXT NOT NULL,
  hostname TEXT, platform TEXT, os_name TEXT, os_version TEXT, arch TEXT, cpu_model TEXT, cpu_cores INTEGER,
  ram_total INTEGER, ip_addrs TEXT, public_ip TEXT, logged_user TEXT, boot_time INTEGER, agent_version TEXT,
  manufacturer TEXT, model TEXT, serial TEXT, cpu_pct REAL, mem_pct REAL, disks TEXT,
  notes TEXT DEFAULT '', maintenance INTEGER DEFAULT 0, want_inventory INTEGER DEFAULT 1, inventory_at INTEGER,
  enrolled_at INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS metrics(
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, ts INTEGER, cpu REAL, mem REAL, disk REAL);
CREATE INDEX IF NOT EXISTS metrics_idx ON metrics(agent_id, ts);
CREATE TABLE IF NOT EXISTS software(
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, name TEXT, version TEXT, publisher TEXT);
CREATE INDEX IF NOT EXISTS software_idx ON software(agent_id);
CREATE TABLE IF NOT EXISTS scripts(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', category TEXT DEFAULT 'General',
  shell TEXT NOT NULL, body TEXT NOT NULL, timeout INTEGER DEFAULT 300, created_by TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, batch_id TEXT, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  script_id INTEGER, name TEXT, shell TEXT, body TEXT, timeout INTEGER, status TEXT,
  exit_code INTEGER, stdout TEXT, stderr TEXT, created_by TEXT, created_at INTEGER, sent_at INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS jobs_agent_idx ON jobs(agent_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_batch_idx ON jobs(batch_id);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE TABLE IF NOT EXISTS schedules(
  id INTEGER PRIMARY KEY, name TEXT, script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, target_id TEXT, interval_minutes INTEGER NOT NULL, enabled INTEGER DEFAULT 1,
  last_run INTEGER, created_by TEXT);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, type TEXT, severity TEXT,
  message TEXT, status TEXT DEFAULT 'open', created_at INTEGER, updated_at INTEGER, resolved_at INTEGER);
CREATE INDEX IF NOT EXISTS alerts_idx ON alerts(agent_id, type, status);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER, username TEXT, action TEXT, detail TEXT);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS updates(
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, uid TEXT, kb TEXT, title TEXT,
  severity TEXT, category TEXT, size INTEGER);
CREATE INDEX IF NOT EXISTS updates_idx ON updates(agent_id);
`);

// Additive column migrations for databases created by earlier versions.
function addColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
addColumn('jobs', 'task', 'TEXT');
addColumn('jobs', 'display_body', 'TEXT');
addColumn('agents', 'updates_checked_at', 'INTEGER');
addColumn('agents', 'pending_updates', 'INTEGER');
addColumn('agents', 'security_updates', 'INTEGER');
addColumn('agents', 'reboot_required', 'INTEGER DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS networks(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  probe_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, subnet TEXT NOT NULL, community TEXT DEFAULT 'public',
  scan_hours INTEGER DEFAULT 24, gateway TEXT, probe_ip TEXT, hops TEXT, last_scan_at INTEGER, last_job_id TEXT, scan_error TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS net_devices(
  id INTEGER PRIMARY KEY, network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE, dkey TEXT NOT NULL,
  ip TEXT, mac TEXT, hostname TEXT, name TEXT, vendor TEXT, type TEXT, reason TEXT, type_manual INTEGER DEFAULT 0, ports TEXT, info TEXT,
  agent_id TEXT, online INTEGER DEFAULT 1, first_seen INTEGER, last_seen INTEGER, UNIQUE(network_id, dkey));
`);
db.exec(`
CREATE TABLE IF NOT EXISTS policies(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', enabled INTEGER DEFAULT 1, enforce INTEGER DEFAULT 0,
  interval_hours INTEGER DEFAULT 24, target TEXT NOT NULL, rules TEXT NOT NULL, last_run INTEGER, created_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS policy_results(
  policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rule_key TEXT NOT NULL, status TEXT, detail TEXT, checked_at INTEGER, job_id TEXT, PRIMARY KEY(policy_id, agent_id, rule_key));
CREATE TABLE IF NOT EXISTS chat_messages(
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, direction TEXT NOT NULL,
  author TEXT, body TEXT NOT NULL, created_at INTEGER, read_at INTEGER);
CREATE INDEX IF NOT EXISTS chat_idx ON chat_messages(agent_id, id);
CREATE TABLE IF NOT EXISTS mobile_devices(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT, created_at INTEGER, last_seen INTEGER);
`);
addColumn('agents', 'chat_token', 'TEXT');
addColumn('users', 'dashboard', 'TEXT');
addColumn('agents', 'core_load', 'TEXT');        // JSON [% per logical CPU]
addColumn('agents', 'device_class', 'TEXT');     // desktop | laptop | server | vm
addColumn('agents', 'services', 'TEXT');         // JSON status of watched services
addColumn('agents', 'watch_services', 'TEXT');   // extra services to watch on this device (comma separated)         // JSON dashboard layout [{id, span}] (null = default)
addColumn('agents', 'net_ifaces', 'TEXT');        // JSON list of network interfaces
addColumn('agents', 'net_rx_total', 'INTEGER');   // last byte counters, to turn into rates
addColumn('agents', 'net_tx_total', 'INTEGER');
addColumn('agents', 'net_ts', 'INTEGER');
addColumn('metrics', 'net_rx', 'REAL');           // bytes/second
addColumn('metrics', 'net_tx', 'REAL');

// ---- patch manager, role monitoring, contacts, device history, screenshots, user preferences ----
db.exec(`
CREATE TABLE IF NOT EXISTS patch_policies(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, position INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
  target TEXT, schedule TEXT, options TEXT, reboot TEXT, approval TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS patch_approvals(
  ukey TEXT PRIMARY KEY, status TEXT NOT NULL, title TEXT, decided_by TEXT, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS contacts(
  id INTEGER PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, name TEXT NOT NULL,
  email TEXT, phone TEXT, title TEXT, notes TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS device_events(
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, ts INTEGER, kind TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS device_events_idx ON device_events(agent_id, ts);
CREATE TABLE IF NOT EXISTS screenshots(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, created_at INTEGER,
  created_by TEXT, size INTEGER, token TEXT, status TEXT DEFAULT 'pending');
`);
addColumn('agents', 'patch_override', 'TEXT');   // null = follow patch policies, 'none' = never patch, '<id>' = that policy
addColumn('agents', 'patch_window', 'TEXT');     // key of the last maintenance window that was handled
addColumn('agents', 'wsus', 'INTEGER');          // Windows Update points at a WSUS server (HostPilot can't patch then)
addColumn('agents', 'roles', 'TEXT');            // JSON [{id, services:[...]}] detected server roles
addColumn('agents', 'roles_at', 'INTEGER');
addColumn('agents', 'contact_id', 'INTEGER');
addColumn('users', 'prefs', 'TEXT');             // JSON: favorites, device list columns, theme, show IDs

// ---- custom monitors & auto-remediation, ticketing, documentation & password vault, end-user portal, API keys, warranty ----
db.exec(`
CREATE TABLE IF NOT EXISTS monitors(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER DEFAULT 1, target TEXT, type TEXT NOT NULL, params TEXT,
  severity TEXT DEFAULT 'warning', actions TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS monitor_state(
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  state TEXT, since INTEGER, detail TEXT, checked_at INTEGER, job_id TEXT, last_job_at INTEGER, remediated_at INTEGER, remediations INTEGER DEFAULT 0,
  PRIMARY KEY(monitor_id, agent_id));
CREATE TABLE IF NOT EXISTS tickets(
  id INTEGER PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL, subject TEXT NOT NULL, status TEXT DEFAULT 'new', priority TEXT DEFAULT 'normal',
  assignee TEXT, source TEXT DEFAULT 'tech', alert_id INTEGER, monitor_id INTEGER, created_by TEXT, created_at INTEGER, updated_at INTEGER, resolved_at INTEGER);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status, updated_at);
CREATE TABLE IF NOT EXISTS ticket_comments(
  id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, author TEXT, author_kind TEXT DEFAULT 'tech',
  body TEXT NOT NULL, internal INTEGER DEFAULT 0, created_at INTEGER);
CREATE INDEX IF NOT EXISTS ticket_comments_idx ON ticket_comments(ticket_id, id);
CREATE TABLE IF NOT EXISTS doc_articles(
  id INTEGER PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT DEFAULT '',
  category TEXT DEFAULT '', agent_ids TEXT, updated_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS credentials(
  id INTEGER PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  name TEXT NOT NULL, username TEXT, secret TEXT, url TEXT, notes TEXT, updated_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS portal_sessions(
  token_hash TEXT PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS api_keys(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT, role TEXT, token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT, created_at INTEGER, last_used INTEGER, expires_at INTEGER);
`);
addColumn('contacts', 'portal_hash', 'TEXT');      // password hash for the end-user portal (null = no portal access)
addColumn('contacts', 'portal_all', 'INTEGER DEFAULT 0'); // 1 = sees every device and ticket of their client
addColumn('contacts', 'portal_login', 'INTEGER');
addColumn('agents', 'warranty_end', 'TEXT');       // YYYY-MM-DD
addColumn('agents', 'purchase_date', 'TEXT');      // YYYY-MM-DD
addColumn('agents', 'warranty_note', 'TEXT');

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export const all = (sql, ...p) => stmt(sql).all(...clean(p));
export const get = (sql, ...p) => stmt(sql).get(...clean(p));
export const run = (sql, ...p) => stmt(sql).run(...clean(p));

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---- settings ----
export const SETTING_DEFAULTS = {
  cpu_threshold: 90,
  mem_threshold: 90,
  disk_threshold: 90,
  offline_minutes: 10,
  checkin_seconds: 60,
  inventory_hours: 12,
  metric_retention_days: 14,
  job_retention_days: 30,
  webhook_url: '',
  update_scan_hours: 24,
  tray_icon: 1, // 1 = show the HostPilot status icon in the Windows taskbar
  watch_services_windows: '', // services monitored on every Windows device (comma separated)
  watch_services_linux: '',
  watch_services_macos: '',
  role_packs: '',      // JSON {packId: 'off'|'low'|'high'} for role monitoring (missing = 'high')
  role_scan_hours: 24, // how often server roles are detected
  patch_timezone: '',  // IANA zone for patch windows (empty = the server's zone)
  warranty_alert_days: 30, // warn this many days before a device's warranty ends (0 = no warranty alerts)
  portal_enabled: 1,   // end-user self-service portal at /portal
  ticket_from_critical: 0, // 1 = every new critical alert opens a ticket automatically
};

export function getSettings() {
  const s = { ...SETTING_DEFAULTS };
  for (const r of all('SELECT key, value FROM settings')) {
    if (r.key in SETTING_DEFAULTS) {
      s[r.key] = typeof SETTING_DEFAULTS[r.key] === 'number' ? Number(r.value) : r.value;
    }
  }
  return s;
}

export function saveSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in SETTING_DEFAULTS)) continue;
    let val = v;
    if (typeof SETTING_DEFAULTS[k] === 'number') {
      val = Number(v);
      if (!Number.isFinite(val) || val < 0) continue;
    } else val = String(v ?? '');
    run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(val));
  }
}

export function audit(username, action, detail = '') {
  run('INSERT INTO audit(ts, username, action, detail) VALUES(?,?,?,?)', Date.now(), username || 'system', action,
    typeof detail === 'string' ? detail : JSON.stringify(detail));
}

// Seed the script library. Each built-in script is added once (tracked by file name in settings.seeded_scripts),
// so new built-ins reach existing servers, while ones an admin deleted or renamed don't come back.
{
  // the built-ins that shipped before tracking existed: an existing server already had the chance to get them
  const ORIGINAL = ['lin-01-system-info.sh', 'lin-02-pending-updates.sh', 'lin-03-apply-updates.sh', 'lin-04-top-processes.sh',
    'lin-05-failed-units.sh', 'lin-06-disk-usage.sh', 'lin-07-docker.sh', 'lin-08-reboot.sh', 'lin-09-security.sh',
    'win-01-system-info.ps1', 'win-02-pending-updates.ps1', 'win-03-install-updates.ps1', 'win-04-top-processes.ps1',
    'win-05-cleanup-temp.ps1', 'win-06-defender.ps1', 'win-07-services-stopped.ps1', 'win-08-reboot.ps1',
    'win-09-event-errors.ps1', 'win-10-local-admins.ps1'];
  const row = get("SELECT value FROM settings WHERE key='seeded_scripts'");
  let seeded;
  try { seeded = new Set(row ? JSON.parse(row.value) : []); } catch { seeded = new Set(); }
  if (!row && get('SELECT COUNT(*) AS n FROM scripts').n > 0) ORIGINAL.forEach((f) => seeded.add(f));
  const fresh = loadSeedScripts().filter((s) => !seeded.has(s.file));
  if (fresh.length || !row) {
    tx(() => {
      for (const s of fresh) {
        if (!get('SELECT id FROM scripts WHERE name=? AND shell=?', s.name, s.shell)) {
          run('INSERT INTO scripts(name, description, category, shell, body, timeout, created_by, updated_at) VALUES(?,?,?,?,?,?,?,?)',
            s.name, s.description, s.category, s.shell, s.body.trim() + '\n', s.timeout || 300, 'system', Date.now());
        }
        seeded.add(s.file);
      }
      run("INSERT INTO settings(key, value) VALUES('seeded_scripts', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify([...seeded]));
    });
  }
}
