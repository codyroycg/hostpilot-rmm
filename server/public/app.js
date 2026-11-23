// HostPilot RMM web console (no build step, no dependencies)

// ---------------- helpers ----------------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { user: null, timers: [], selected: new Set(), terminal: new Map(), devFilter: { q: '', client: '', status: '', platform: '' }, scripts: null };

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(method, path, body) {
  // X-HostPilot marks the request as coming from this console (CSRF check), including body-less POSTs.
  const opts = { method, headers: { 'X-HostPilot': '1' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { state.user = null; renderLogin(); throw new ApiError(401, 'Signed out'); }
  if (!r.ok) throw new ApiError(r.status, data.error || r.statusText);
  return data;
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

function guard(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
  };
}

function every(ms, fn) { state.timers.push(setInterval(guard(fn), ms)); }
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }

const can = (role) => ({ viewer: 1, tech: 2, admin: 3 })[state.user?.role] >= ({ viewer: 1, tech: 2, admin: 3 })[role];

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fmtDur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  return h < 48 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const fmtPct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

function meter(v) {
  if (v == null) return '<span class="muted">—</span>';
  const cls = v >= 90 ? 'bad' : v >= 75 ? 'warn' : '';
  return `<div class="meter"><div class="bar ${cls}"><span style="width:${Math.min(100, v)}%"></span></div><span class="n">${Math.round(v)}%</span></div>`;
}

const ICONS = {
  windows: '<svg viewBox="0 0 24 24" fill="#38bdf8"><path d="M3 5.5 10.5 4.5v7H3zM11.5 4.3 21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.3z"/></svg>',
  linux: '<svg viewBox="0 0 24 24" fill="#f59e0b"><path d="M12 2c-2.2 0-3.5 1.9-3.5 4.3 0 1.5.3 2.4-.6 3.9C6.8 12 5 14.4 5 17c0 .8.2 1.4.5 1.9-.6.4-1 .9-1 1.5C4.5 21.5 6 22 8 22c1.3 0 2.3-.4 3-.9.3.1.6.1 1 .1s.7 0 1-.1c.7.5 1.7.9 3 .9 2 0 3.5-.5 3.5-1.6 0-.6-.4-1.1-1-1.5.3-.5.5-1.1.5-1.9 0-2.6-1.8-5-2.9-6.8-.9-1.5-.6-2.4-.6-3.9C15.5 3.9 14.2 2 12 2z"/></svg>',
};
const osCell = (a) => `<span class="os">${ICONS[a.platform] || ''}${esc(a.os_name || a.platform || '')}</span>`;
const statusDot = (a) => `<span class="dot ${a.maintenance ? 'maint' : a.online ? 'on' : 'off'}" title="${a.maintenance ? 'Maintenance mode' : a.online ? 'Online' : 'Offline'}"></span>`;
const badge = (s, cls = s) => `<span class="badge ${esc(cls)}">${esc(s)}</span>`;
const SHELLS_FOR = { windows: ['powershell', 'cmd', 'python'], linux: ['bash', 'sh', 'python'] };
const SHELL_OS = { powershell: 'windows', cmd: 'windows', bash: 'linux', sh: 'linux', python: 'any' };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Copied to clipboard');
}

// ---------------- modal ----------------
function openModal(title, bodyHtml, { wide = false, foot = '' } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x" data-action="close-modal" aria-label="Close">×</button></div>
    <div class="modal-body">${bodyHtml}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div></div>`;
  return $('.modal', root);
}
function closeModal() { $('#modal-root').innerHTML = ''; if (state.modalTimer) { clearInterval(state.modalTimer); state.modalTimer = null; } }

function confirmDialog(message, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = openModal('Please confirm', `<p>${esc(message)}</p>`, {
      foot: `<button class="btn" data-k="no">Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-k="yes">${esc(okLabel)}</button>`,
    });
    m.addEventListener('click', (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (k) { closeModal(); resolve(k === 'yes'); }
    });
  });
}

// ---------------- chart ----------------
function chart(rows, series, { hours = 24 } = {}) {
  const W = 600, H = 160;
  const end = Date.now(), start = end - hours * 3600000;
  const x = (ts) => ((ts - start) / (end - start)) * W;
  const y = (v) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const grid = [25, 50, 75].map((g) => `<line class="grid-line" x1="0" x2="${W}" y1="${y(g)}" y2="${y(g)}"/>`).join('');
  const gapMs = hours < 1 ? 10000 : Math.max(5 * 60000, (hours * 3600000) / 150);
  const paths = series.map(([key, , color]) => {
    let d = '', prev = null;
    for (const r of rows) {
      if (r[key] == null) { prev = null; continue; }
      d += `${prev && r.ts - prev < gapMs ? 'L' : 'M'}${x(r.ts).toFixed(1)},${y(r[key]).toFixed(1)}`;
      prev = r.ts;
    }
    return `<path d="${d}" stroke="${color}"/>`;
  }).join('');
  const legend = series.map(([, label, color]) => `<span><i style="background:${color}"></i>${label}</span>`).join('');
  const t = (ms) => new Date(ms).toLocaleString([], hours > 48 ? { month: 'short', day: 'numeric' }
    : hours < 1 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  return `<div class="legend">${legend}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}</svg>
    <div class="chart-axis"><span>${t(start)}</span><span>${t((start + end) / 2)}</span><span>now</span></div>`;
}

// ---------------- layout & routing ----------------
const NAV = [
  ['#/', 'Dashboard'], ['#/devices', 'Devices'], ['#/clients', 'Clients'], ['#/alerts', 'Alerts', 'alerts'],
  null, ['#/patching', 'Patching'], ['#/scripts', 'Scripts'], ['#/automation', 'Automation'], ['#/jobs', 'Job history'], ['#/software', 'Software'],
  null, ['#/settings', 'Settings'],
];

function renderShell() {
  $('#root').innerHTML = `<div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><img src="/favicon.svg" alt="">HostPilot RMM</div>
      <nav class="nav">${NAV.map((n) => (n ? `<a href="${n[0]}" data-nav="${n[0]}">${n[1]}${n[2] ? '<span class="badge hidden" id="nav-alerts"></span>' : ''}</a>` : '<div class="sep"></div>')).join('')}</nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="row"><button class="btn sm menu-toggle" data-action="toggle-menu">☰</button><strong id="page-title"></strong></div>
        <div class="user"><span>${esc(state.user.username)} · ${esc(state.user.role)}</span><button class="btn sm" data-action="logout">Sign out</button></div>
      </header>
      <main id="view"></main>
    </div></div>`;
  updateAlertBadge();
  setInterval(guard(updateAlertBadge), 30000);
}

async function updateAlertBadge() {
  if (!state.user) return;
  const d = await api('GET', '/api/alerts?status=open');
  const b = $('#nav-alerts');
  if (!b) return;
  b.textContent = d.length;
  b.classList.toggle('hidden', d.length === 0);
}

const ROUTES = [
  [/^#?\/?$/, pageDashboard, 'Dashboard'],
  [/^#\/devices$/, pageDevices, 'Devices'],
  [/^#\/devices\/([^/]+)(?:\/(\w+))?$/, pageDevice, 'Device'],
  [/^#\/clients$/, pageClients, 'Clients'],
  [/^#\/clients\/(\d+)$/, pageClient, 'Client'],
  [/^#\/scripts$/, pageScripts, 'Scripts'],
  [/^#\/scripts\/(new|\d+)$/, pageScriptEdit, 'Script'],
  [/^#\/automation$/, pageAutomation, 'Automation'],
  [/^#\/patching$/, pagePatching, 'Patching'],
  [/^#\/jobs$/, pageJobs, 'Job history'],
  [/^#\/jobs\/batch\/([\w-]+)$/, pageBatch, 'Job results'],
  [/^#\/alerts$/, pageAlerts, 'Alerts'],
  [/^#\/software$/, pageSoftware, 'Software'],
  [/^#\/settings$/, pageSettings, 'Settings'],
];

async function router() {
  if (!state.user) return;
  clearTimers();
  closeModal();
  $('#sidebar')?.classList.remove('open');
  const hash = location.hash || '#/';
  const r = ROUTES.find(([re]) => re.test(hash));
  const view = $('#view');
  $$('.nav a').forEach((a) => {
    const n = a.dataset.nav;
    a.classList.toggle('active', n === '#/' ? hash === '#/' || hash === '' : hash.startsWith(n));
  });
  if (!r) { view.innerHTML = '<div class="card">Page not found.</div>'; return; }
  $('#page-title').textContent = r[2];
  document.title = `${r[2]} · HostPilot RMM`;
  view.innerHTML = '<div class="muted">Loading…</div>';
  try { await r[1](view, ...hash.match(r[0]).slice(1)); }
  catch (e) { if (e.status !== 401) view.innerHTML = `<div class="card">Error: ${esc(e.message)}</div>`; }
}

// ---------------- login ----------------
function renderLogin() {
  clearTimers();
  $('#root').innerHTML = `<div class="login-wrap"><form class="card login" id="login-form">
    <div class="brand"><img src="/favicon.svg" alt="">HostPilot RMM</div>
    <div class="field"><label for="lu">Username</label><input id="lu" name="username" type="text" autocomplete="username" required autofocus></div>
    <div class="field"><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>
    <div class="error-text" id="login-err"></div>
    <button class="btn primary" style="width:100%;justify-content:center">Sign in</button></form></div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      state.user = await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') });
      renderShell(); router();
    } catch (err) { $('#login-err').textContent = err.message; }
  });
}

// ---------------- dashboard ----------------
async function pageDashboard(view) {
  const draw = async () => {
    const d = await api('GET', '/api/dashboard');
    const t = d.totals;
    const failed = (d.jobs_24h.failed || 0) + (d.jobs_24h.timeout || 0) + (d.jobs_24h.lost || 0);
    view.innerHTML = `
      <div class="tiles">
        <a class="tile" href="#/devices" data-preset=""><div class="l">Devices</div><div class="v">${t.devices}</div></a>
        <a class="tile ok" href="#/devices" data-preset="online"><div class="l">Online</div><div class="v">${t.online}</div></a>
        <a class="tile ${t.offline ? 'bad' : ''}" href="#/devices" data-preset="offline"><div class="l">Offline</div><div class="v">${t.offline}</div></a>
        <a class="tile ${t.open_alerts ? 'warn' : ''}" href="#/alerts"><div class="l">Active alerts</div><div class="v">${t.open_alerts}</div></a>
        <a class="tile" href="#/clients"><div class="l">Clients</div><div class="v">${t.clients}</div></a>
        <a class="tile ${failed ? 'bad' : ''}" href="#/jobs"><div class="l">Jobs 24h (failed)</div><div class="v">${Object.values(d.jobs_24h).reduce((a, b) => a + b, 0)} <span class="small muted">(${failed})</span></div></a>
      </div>
      <div class="grid cols-2">
        <div class="card flush"><h2>Active alerts</h2><div class="table-wrap"><table><tbody>
          ${d.recent_alerts.map((a) => `<tr class="clickable" data-href="#/devices/${a.agent_id}/alerts"><td>${badge(a.severity)}</td><td><strong>${esc(a.hostname)}</strong><div class="small muted">${esc(a.message)}</div></td><td class="right muted small nowrap">${fmtAgo(a.created_at)}</td></tr>`).join('') || '<tr><td class="empty">No active alerts 🎉</td></tr>'}
        </tbody></table></div></div>
        <div class="card flush"><h2>Recent jobs</h2><div class="table-wrap"><table><tbody>
          ${d.recent_jobs.map((j) => `<tr class="clickable" data-job="${j.id}"><td>${badge(j.status)}</td><td><strong>${esc(j.name)}</strong><div class="small muted">${esc(j.hostname)} · ${esc(j.created_by)}</div></td><td class="right muted small nowrap">${fmtAgo(j.created_at)}</td></tr>`).join('') || '<tr><td class="empty">No jobs yet</td></tr>'}
        </tbody></table></div></div>
        <div class="card flush"><h2>Highest CPU</h2><div class="table-wrap"><table><tbody>
          ${d.top_cpu.map((a) => `<tr class="clickable" data-href="#/devices/${a.id}"><td>${statusDot(a)}${esc(a.hostname)}</td><td style="width:45%">${meter(a.cpu_pct)}</td></tr>`).join('') || '<tr><td class="empty">No data</td></tr>'}
        </tbody></table></div></div>
        <div class="card flush"><h2>Fullest disks</h2><div class="table-wrap"><table><tbody>
          ${d.top_disk.map((a) => `<tr class="clickable" data-href="#/devices/${a.id}"><td>${statusDot(a)}${esc(a.hostname)}</td><td style="width:45%">${meter(a.disk_pct)}</td></tr>`).join('') || '<tr><td class="empty">No data</td></tr>'}
        </tbody></table></div></div>
      </div>
      ${t.devices === 0 ? `<div class="card" style="margin-top:16px"><h2>Get started</h2><p>1. Create a <a href="#/clients">client</a>. 2. Generate an install token on the client page. 3. Run the one-line installer on your Windows or Linux hosts.</p></div>` : ''}`;
  };
  await draw();
  every(15000, draw);
}

// ---------------- devices ----------------
async function pageDevices(view) {
  const clients = await api('GET', '/api/clients');
  const f = state.devFilter;
  view.innerHTML = `
    <div class="page-head"><h1>Devices</h1>
      <div class="row">
        ${can('tech') ? `<select id="bulk-sel" style="width:auto" disabled><option value="">More actions…</option>
          <option value="scan">Scan for OS updates</option><option value="patch">Install all OS updates</option>
          <option value="patch-reboot">Install all OS updates + reboot if required</option><option value="software">Install software…</option></select>
          <button class="btn primary" data-action="run-selected" id="run-sel" disabled>Run script on selected</button>` : ''}
        <a class="btn" href="#/clients">+ Add devices</a></div></div>
    <div class="toolbar">
      <input type="search" id="dev-q" placeholder="Search hostname, IP, user, OS…" value="${esc(f.q)}">
      <select id="dev-client"><option value="">All clients</option>${clients.map((c) => `<option value="${c.id}" ${String(f.client) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="dev-status"><option value="">Any status</option><option value="online">Online</option><option value="offline">Offline</option><option value="alerts">With alerts</option><option value="maintenance">Maintenance</option></select>
      <select id="dev-platform"><option value="">All platforms</option><option value="windows">Windows</option><option value="linux">Linux</option></select>
      <span class="muted small" id="dev-count"></span>
    </div>
    <div class="card flush"><div class="table-wrap"><table>
      <thead><tr><th style="width:32px"><input type="checkbox" id="dev-all"></th><th>Hostname</th><th>Client</th><th>OS</th><th>IP</th><th>User</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Last seen</th></tr></thead>
      <tbody id="dev-body"><tr><td colspan="10" class="empty">Loading…</td></tr></tbody></table></div></div>`;
  $('#dev-status').value = f.status;
  $('#dev-platform').value = f.platform;
  let agents = [];
  const filtered = () => {
    const q = f.q.toLowerCase();
    return agents.filter((a) => {
      if (f.client && String(a.client_id) !== String(f.client)) return false;
      if (f.platform && a.platform !== f.platform) return false;
      if (f.status === 'online' && !a.online) return false;
      if (f.status === 'offline' && a.online) return false;
      if (f.status === 'alerts' && !a.open_alerts) return false;
      if (f.status === 'maintenance' && !a.maintenance) return false;
      if (q && ![a.hostname, a.os_name, a.logged_user, a.client_name, a.public_ip, ...(a.ip_addrs || [])].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
  };
  const drawRows = () => {
    const list = filtered();
    $('#dev-count').textContent = `${list.length} of ${agents.length}`;
    $('#dev-body').innerHTML = list.map((a) => `<tr class="clickable" data-href="#/devices/${a.id}">
      <td data-stop><input type="checkbox" class="dev-cb" value="${a.id}" ${state.selected.has(a.id) ? 'checked' : ''}></td>
      <td class="nowrap">${statusDot(a)}<strong>${esc(a.hostname)}</strong>${a.open_alerts ? ` ${badge(a.open_alerts + ' alert' + (a.open_alerts > 1 ? 's' : ''), 'bad')}` : ''}</td>
      <td>${esc(a.client_name || '—')}</td><td>${osCell(a)}</td>
      <td class="mono small">${esc((a.ip_addrs || [])[0] || '')}</td><td class="small">${esc(a.logged_user || '')}</td>
      <td>${a.online ? meter(a.cpu_pct) : '<span class="muted">—</span>'}</td><td>${a.online ? meter(a.mem_pct) : '<span class="muted">—</span>'}</td><td>${meter(a.disk_pct)}</td>
      <td class="nowrap small ${a.online ? '' : 'muted'}">${a.online ? 'Online' : fmtAgo(a.last_seen)}</td></tr>`).join('')
      || `<tr><td colspan="10" class="empty">${agents.length ? 'No devices match the filters' : 'No devices yet. Go to a client page to get an install command.'}</td></tr>`;
    syncSel();
  };
  const syncSel = () => {
    const ids = new Set(agents.map((a) => a.id));
    for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
    const b = $('#run-sel');
    if (b) { b.disabled = !state.selected.size; b.textContent = `Run script on selected${state.selected.size ? ` (${state.selected.size})` : ''}`; }
    const bs = $('#bulk-sel');
    if (bs) bs.disabled = !state.selected.size;
    const vis = filtered();
    $('#dev-all').checked = vis.length > 0 && vis.every((a) => state.selected.has(a.id));
  };
  const load = async () => { agents = await api('GET', '/api/agents'); drawRows(); };
  $('#dev-q').addEventListener('input', (e) => { f.q = e.target.value; drawRows(); });
  $('#dev-client').addEventListener('change', (e) => { f.client = e.target.value; drawRows(); });
  $('#dev-status').addEventListener('change', (e) => { f.status = e.target.value; drawRows(); });
  $('#dev-platform').addEventListener('change', (e) => { f.platform = e.target.value; drawRows(); });
  $('#dev-body').addEventListener('change', (e) => {
    if (!e.target.classList.contains('dev-cb')) return;
    e.target.checked ? state.selected.add(e.target.value) : state.selected.delete(e.target.value);
    syncSel();
  });
  $('#dev-all').addEventListener('change', (e) => {
    for (const a of filtered()) e.target.checked ? state.selected.add(a.id) : state.selected.delete(a.id);
    drawRows();
  });
  $('#bulk-sel')?.addEventListener('change', guard(async (e) => {
    const op = e.target.value;
    e.target.value = '';
    const ids = [...state.selected];
    if (!op || !ids.length) return;
    if (op === 'software') { await bulkSoftwareModal(ids); return; }
    const label = { scan: 'Scan for OS updates', patch: 'Install all OS updates', 'patch-reboot': 'Install all OS updates and reboot where required' }[op];
    if (!await confirmDialog(`${label} on ${ids.length} device(s)?`, { okLabel: 'Go' })) return;
    const r = await api('POST', '/api/tasks', op === 'scan'
      ? { agent_ids: ids, task: 'updates.scan' }
      : { agent_ids: ids, task: 'updates.install', args: { ids: 'all', reboot: op === 'patch-reboot' } });
    toast(`Queued on ${r.created} device(s)`);
    location.hash = `#/jobs/batch/${r.batch_id}`;
  }));
  await load();
  every(15000, load);
}

// ---------------- device detail ----------------
async function pageDevice(view, id, tab = 'overview') {
  const a = await api('GET', `/api/agents/${id}`);
  const tabs = [['overview', 'Overview'], ['terminal', 'Run command'], ['files', 'Files'], ['updates', 'Updates'], ['software', 'Software'],
    ['users', 'Users'], ['jobs', 'Script history'], ['alerts', 'Alerts'], ['settings', 'Settings']];
  view.innerHTML = `
    <div class="page-head"><div>
      <h1>${statusDot(a)}${esc(a.hostname)}</h1>
      <div class="muted small" style="margin-top:4px">${osCell(a)} · ${a.client_name ? `<a href="#/clients/${a.client_id}">${esc(a.client_name)}</a>` : 'No client'} · ${a.maintenance ? badge('maintenance', 'warn') : a.online ? badge('online', 'ok') : badge(`offline · ${fmtAgo(a.last_seen)}`, 'bad')}</div></div>
      <div class="row">${can('tech') && a.platform === 'windows' ? `<a class="btn primary" href="/remote.html#${encodeURIComponent(a.id)}" target="_blank" rel="noopener">Remote control</a>` : ''}
      ${can('tech') && a.platform === 'linux' ? `<a class="btn primary" href="/terminal.html#${encodeURIComponent(a.id)}" target="_blank" rel="noopener">Terminal</a>` : ''}
      ${can('tech') ? `<button class="btn" data-action="run-on" data-ids="${a.id}">Run script</button><button class="btn" data-action="refresh-inv" data-id="${a.id}">Refresh inventory</button>` : ''}</div></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/devices/${a.id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <div id="tab"></div>`;
  const el = $('#tab');
  const fn = {
    overview: devOverview, terminal: devTerminal, files: devFiles, updates: devUpdates, software: devSoftware, users: devUsers,
    jobs: devJobs, alerts: devAlerts, settings: devSettings,
  }[tab] || devOverview;
  await fn(el, a);
}

async function devOverview(el, a) {
  const kv = (k, v) => `<dt>${k}</dt><dd>${v || '<span class="muted">—</span>'}</dd>`;
  el.innerHTML = `<div class="grid cols-2">
    <div class="card"><h3>System</h3><dl class="kv">
      ${kv('OS', esc(a.os_name))}${kv('Version', esc(a.os_version))}${kv('Architecture', esc(a.arch))}
      ${kv('Manufacturer', esc(a.manufacturer))}${kv('Model', esc(a.model))}${kv('Serial', `<span class="mono">${esc(a.serial)}</span>`)}
      ${kv('CPU', esc(a.cpu_model) + (a.cpu_cores ? ` <span class="muted">(${a.cpu_cores} threads)</span>` : ''))}${kv('Memory', a.ram_total ? fmtBytes(a.ram_total) : '')}
      ${kv('Logged-in user', esc(a.logged_user))}
    </dl></div>
    <div class="card"><h3>Network & agent</h3><dl class="kv">
      ${kv('Local IPs', (a.ip_addrs || []).map((i) => `<span class="mono">${esc(i)}</span>`).join('<br>'))}${kv('Public IP', `<span class="mono">${esc(a.public_ip)}</span>`)}
      ${kv('Booted', a.boot_time ? `${fmtDate(a.boot_time)} <span class="muted">(up ${fmtDur(Date.now() - a.boot_time)})</span>` : '')}
      ${kv('Last seen', `${fmtDate(a.last_seen)} <span class="muted">(${fmtAgo(a.last_seen)})</span>`)}${kv('Enrolled', fmtDate(a.enrolled_at))}
      ${kv('Agent version', `<span class="mono">${esc(a.agent_version)}</span>${a.update_pending ? ' ' + badge('update pending', 'info') : ''}`)}
      ${kv('Inventory', a.inventory_at ? fmtAgo(a.inventory_at) : 'pending')}${kv('Device ID', `<span class="mono small">${esc(a.id)}</span>`)}
    </dl></div>
    <div class="card"><h3>Utilization</h3>
      <dl class="kv">${kv('CPU', meter(a.cpu_pct))}${kv('Memory', meter(a.mem_pct))}
      ${(a.disks || []).map((d) => kv(esc(d.mount), `${meter(d.total ? ((d.total - d.free) / d.total) * 100 : null)}<div class="small muted">${fmtBytes(d.free)} free of ${fmtBytes(d.total)}</div>`)).join('')}</dl></div>
    <div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">Performance</h3>
      <select id="m-hours" style="width:auto"><option value="live">1 minute (live)</option><option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option></select></div>
      <div id="m-chart" class="muted">Loading…</div></div>
    ${a.notes ? `<div class="card"><h3>Notes</h3><div style="white-space:pre-wrap">${esc(a.notes)}</div></div>` : ''}
  </div>`;
  const SERIES = [['cpu', 'CPU', 'var(--c1)'], ['mem', 'Memory', 'var(--c2)'], ['disk', 'Fullest disk', 'var(--c3)']];
  let liveTimer = null, lastStart = 0;
  const stopLive = () => { clearInterval(liveTimer); liveTimer = null; };
  const drawLive = async () => {
    if (!document.body.contains($('#m-chart'))) return stopLive(); // navigated away
    const r = await api('GET', `/api/agents/${a.id}/live`);
    // (re)start the device-side sampler if it isn't running
    if (!r.active && Date.now() - lastStart > 20000) { lastStart = Date.now(); await api('POST', `/api/agents/${a.id}/live`); }
    $('#m-chart').innerHTML = r.samples.length
      ? chart(r.samples, SERIES, { hours: 1 / 60 }) + '<div class="small muted">Live · a sample every 2 seconds</div>'
      : '<div class="muted">Starting live monitoring on the device… (usually a few seconds)</div>';
  };
  const drawChart = async () => {
    const sel = $('#m-hours')?.value;
    if (!sel) return;
    if (sel === 'live') {
      if (!liveTimer) {
        $('#m-chart').innerHTML = '<div class="muted">Starting live monitoring on the device…</div>';
        lastStart = Date.now();
        try { await api('POST', `/api/agents/${a.id}/live`); } catch (e) { $('#m-chart').innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
        liveTimer = setInterval(guard(drawLive), 2000);
        state.timers.push(liveTimer);
      }
      return drawLive();
    }
    stopLive();
    const hours = Number(sel);
    const rows = await api('GET', `/api/agents/${a.id}/metrics?hours=${hours}`);
    $('#m-chart').innerHTML = rows.length ? chart(rows, SERIES, { hours }) : '<div class="muted">No metrics yet.</div>';
  };
  $('#m-hours').addEventListener('change', guard(drawChart));
  await drawChart();
  every(60000, () => { if ($('#m-hours')?.value !== 'live') return drawChart(); });
}

function termEntryHtml(j) {
  const running = ['queued', 'running'].includes(j.status);
  return `<div class="term-entry" data-term="${j.id}">
    <div class="head"><code>${esc(j.shell)}&gt; ${esc((j.body || j.name || '').split('\n')[0])}</code>
      <span class="row">${j.exit_code != null ? `<span class="small muted">exit ${j.exit_code}</span>` : ''}${badge(j.status)}${running && j.status === 'queued' ? `<button class="btn sm" data-action="cancel-job" data-id="${j.id}">Cancel</button>` : ''}</span></div>
    ${running ? `<pre class="out muted">${j.status === 'queued' ? 'Waiting for device to pick up the job…' : 'Running…'}</pre>`
      : `${j.stdout ? `<pre class="out">${esc(j.stdout)}</pre>` : ''}${j.stderr ? `<pre class="out err">${esc(j.stderr)}</pre>` : ''}${!j.stdout && !j.stderr ? '<pre class="out muted">(no output)</pre>' : ''}`}
  </div>`;
}

async function devTerminal(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">Your role cannot run commands.</div>'; return; }
  const shells = SHELLS_FOR[a.platform] || ['bash'];
  const hist = state.terminal.get(a.id) || [];
  state.terminal.set(a.id, hist);
  el.innerHTML = `<div class="card" style="margin-bottom:16px">
    <form id="term-form">
      <div class="row" style="margin-bottom:8px">
        <select name="shell" style="width:auto">${shells.map((s) => `<option>${s}</option>`).join('')}</select>
        <label class="row small" style="margin:0">Timeout (s) <input name="timeout" type="number" value="300" min="5" max="86400" style="width:100px"></label>
        <span class="grow"></span><span class="small muted">Ctrl+Enter to run · runs as ${a.platform === 'windows' ? 'SYSTEM' : 'root'}</span>
        <button class="btn primary">Run</button>
      </div>
      <textarea name="body" class="code" style="min-height:110px" placeholder="${a.platform === 'windows' ? 'Get-Service | Where-Object Status -eq Stopped' : 'systemctl status nginx'}" spellcheck="false"></textarea>
    </form>
    ${a.online ? '' : `<div class="small" style="color:var(--warn);margin-top:8px">Device is offline. Commands will be queued and run when it reconnects (up to 7 days).</div>`}
  </div><div id="term-out"></div>`;
  const out = $('#term-out');
  const draw = async () => {
    const jobs = await Promise.all(hist.map((jid) => api('GET', `/api/jobs/${jid}`).catch(() => null)));
    out.innerHTML = jobs.filter(Boolean).map(termEntryHtml).join('') || '<div class="muted small">Output appears here.</div>';
  };
  const form = $('#term-form');
  const submit = guard(async () => {
    const f = new FormData(form);
    if (!String(f.get('body')).trim()) return;
    const r = await api('POST', '/api/jobs', { agent_ids: [a.id], shell: f.get('shell'), body: f.get('body'), timeout: Number(f.get('timeout')) });
    if (r.skipped.length) toast(`Shell not supported on ${r.skipped.join(', ')}`, 'error');
    if (r.jobs[0]) hist.unshift(r.jobs[0].id);
    await draw();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  form.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.setRangeText('    ', s, t.selectionEnd, 'end'); }
  });
  form.body.focus();
  await draw();
  every(2000, async () => { if ($('.term-entry .badge.queued, .term-entry .badge.running')) await draw(); });
}

function jobsTable(jobs, { showHost = false } = {}) {
  return `<div class="card flush"><div class="table-wrap"><table>
    <thead><tr><th>Status</th><th>Script / command</th>${showHost ? '<th>Device</th>' : ''}<th>By</th><th>Queued</th><th>Duration</th><th>Exit</th></tr></thead>
    <tbody>${jobs.map((j) => `<tr class="clickable" data-job="${j.id}"><td>${badge(j.status)}</td><td>${esc(j.name)}</td>
      ${showHost ? `<td>${esc(j.hostname)}</td>` : ''}<td class="small">${esc(j.created_by)}</td><td class="small nowrap" title="${fmtDate(j.created_at)}">${fmtAgo(j.created_at)}</td>
      <td class="small">${j.finished_at && j.sent_at ? fmtDur(j.finished_at - j.sent_at) : '—'}</td><td class="mono small">${j.exit_code ?? ''}</td></tr>`).join('')
      || `<tr><td colspan="7" class="empty">No jobs</td></tr>`}</tbody></table></div></div>`;
}

async function devJobs(el, a) {
  const draw = async () => { el.innerHTML = jobsTable(await api('GET', `/api/agents/${a.id}/jobs`)); };
  await draw();
  every(10000, draw);
}

async function devSoftware(el, a) {
  const sw = await api('GET', `/api/agents/${a.id}/software`);
  const tech = can('tech');
  el.innerHTML = `<div class="toolbar"><input type="search" id="sw-q" placeholder="Filter ${sw.length} packages…">
      <span class="muted small">Inventory updated ${fmtAgo(a.inventory_at)}</span><span class="grow"></span>
      ${tech ? '<button class="btn primary" id="sw-install">Install software…</button>' : ''}</div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Version</th><th>Publisher</th>${tech ? '<th></th>' : ''}</tr></thead><tbody id="sw-body"></tbody></table></div></div>`;
  const draw = () => {
    const q = $('#sw-q').value.toLowerCase();
    const rows = sw.filter((s) => !q || `${s.name} ${s.publisher}`.toLowerCase().includes(q));
    $('#sw-body').innerHTML = rows.slice(0, 2000).map((s) => `<tr><td>${esc(s.name)}</td><td class="mono small">${esc(s.version)}</td><td class="small muted">${esc(s.publisher)}</td>
      ${tech ? `<td class="right nowrap"><button class="btn sm" data-sw="reinstall" data-name="${esc(s.name)}">Reinstall</button> <button class="btn sm danger" data-sw="uninstall" data-name="${esc(s.name)}">Uninstall</button></td>` : ''}</tr>`).join('')
      || `<tr><td colspan="4" class="empty">No software inventory yet</td></tr>`;
  };
  $('#sw-q').addEventListener('input', draw);
  draw();
  if (!tech) return;
  $('#sw-install').addEventListener('click', () => installSoftwareModal(a));
  $('#sw-body').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-sw]');
    if (!b) return;
    const { sw: op, name } = b.dataset;
    const msg = op === 'uninstall'
      ? `Uninstall "${name}" from ${a.hostname}? It runs silently; some programs may still close running apps or require a reboot.`
      : `Reinstall "${name}" on ${a.hostname}?${a.platform === 'windows' ? ' (Uses winget; works when the name matches a winget package exactly.)' : ''}`;
    if (!await confirmDialog(msg, { okLabel: op === 'uninstall' ? 'Uninstall' : 'Reinstall', danger: op === 'uninstall' })) return;
    const j = await deviceTask(a.id, `software.${op}`, { name }, { wait: false });
    openJobModal(j.id);
  }));
}

function installSoftwareModal(a) {
  const win = a.platform === 'windows';
  const m = openModal(`Install software on ${a.hostname}`, `
    <p class="small muted" style="margin-top:0">${win ? 'Installs machine-wide with <strong>winget</strong> (Windows Package Manager), silently.' : 'Installs with the system package manager (apt, dnf, yum, zypper, apk or pacman).'}</p>
    <form id="si-search" class="row" style="flex-wrap:nowrap"><input type="text" name="q" placeholder="Search, e.g. ${win ? 'chrome, 7zip, vlc' : 'htop, nginx, git'}" required><button class="btn">Search</button></form>
    <div id="si-results" style="margin:12px 0;max-height:340px;overflow:auto"></div>
    <label>Or install by ${win ? 'winget ID' : 'package name'}</label>
    <form id="si-direct" class="row" style="flex-wrap:nowrap"><input type="text" name="id" placeholder="${win ? 'e.g. Google.Chrome' : 'e.g. htop'}" required><button class="btn primary">Install</button></form>`, { wide: true });
  const install = guard(async (id) => {
    const j = await deviceTask(a.id, 'software.install', { id }, { wait: false });
    closeModal();
    openJobModal(j.id);
  });
  $('#si-search', m).addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const out = $('#si-results', m);
    out.innerHTML = '<div class="muted small">Searching on the device…</div>';
    try {
      const j = await deviceTask(a.id, 'software.search', { query: e.target.q.value });
      const rows = parseTsv(j.stdout, 'P');
      out.innerHTML = rows.length
        ? `<table><tbody>${rows.map(([id, name, ver]) => `<tr><td><strong>${esc(name || id)}</strong><div class="small muted mono">${esc(id)}</div></td><td class="small">${esc(ver)}</td>
            <td class="right"><button class="btn sm primary" data-id="${esc(id)}">Install</button></td></tr>`).join('')}</tbody></table>`
        : `<pre class="out">${esc(j.stdout || 'No results')}</pre>`;
    } catch (err) { out.innerHTML = `<div class="small" style="color:var(--bad)">${esc(err.message)}</div>`; }
  }));
  $('#si-results', m).addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) install(b.dataset.id); });
  $('#si-direct', m).addEventListener('submit', (e) => { e.preventDefault(); install(e.target.id.value.trim()); });
}

// ---------------- device tasks: shared helpers ----------------
const parseTsv = (s, tag) => String(s || '').split(/\r?\n/)
  .filter((l) => (tag ? l.startsWith(`${tag}\t`) : l.trim()))
  .map((l) => l.split('\t').slice(tag ? 1 : 0));

// PowerShell error records are noisy ("C:\...\jobs\x.ps1 : message\nAt line:..."); keep the message.
function cleanErr(s) {
  const lines = String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const first = lines[0].replace(/^[A-Za-z]:\\.*?\.ps1\s*:\s*/, '').replace(/^Exception calling .*?" with "\d+" argument\(s\): /, '');
  return first.replace(/^"|"$/g, '');
}

async function deviceTask(agentId, task, args = {}, { wait = true } = {}) {
  const j = await api('POST', `/api/agents/${agentId}/task`, { task, args, wait });
  if (!wait) return j;
  if (['queued', 'running'].includes(j.status)) throw new Error('The device is taking a while. The result will appear in Script history.');
  if (j.status !== 'success') throw new Error(cleanErr(j.stderr) || cleanErr(j.stdout) || `Task ${j.status}`);
  return j;
}

async function pollJob(id, onTick) {
  for (;;) {
    const j = await api('GET', `/api/jobs/${id}`);
    if (onTick) onTick(j);
    if (!['queued', 'running'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---------------- files ----------------
const isWin = (a) => a.platform === 'windows';
function fsJoin(a, dir, name) {
  if (isWin(a)) return dir ? `${dir.replace(/\\+$/, '')}\\${name}` : name;
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}
function fsParent(a, p) {
  if (isWin(a)) {
    if (!p || /^[A-Za-z]:\\?$/.test(p)) return '';
    const t = p.replace(/\\+$/, '');
    const par = t.slice(0, t.lastIndexOf('\\'));
    return /^[A-Za-z]:$/.test(par) ? `${par}\\` : par;
  }
  const t = p.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i <= 0 ? '/' : t.slice(0, i);
}
function fsCrumbs(a, p) {
  if (isWin(a)) {
    const out = [['This PC', '']];
    const parts = p.split('\\').filter(Boolean);
    parts.forEach((part, i) => out.push([part, i === 0 ? `${part}\\` : parts.slice(0, i + 1).join('\\')]));
    return out;
  }
  const out = [['/', '/']];
  const parts = p.split('/').filter(Boolean);
  parts.forEach((part, i) => out.push([part, `/${parts.slice(0, i + 1).join('/')}`]));
  return out;
}

function xhrUpload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('X-HostPilot', '1');
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded * 100) / e.total)); };
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* not json */ }
      if (x.status < 300) resolve(d); else reject(new Error(d.error || x.statusText));
    };
    x.onerror = () => reject(new Error('Upload failed'));
    x.send(file);
  });
}

async function devFiles(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">File access requires the tech role.</div>'; return; }
  if (!state.files) state.files = new Map();
  const st = state.files.get(a.id) || { path: isWin(a) ? '' : '/' };
  state.files.set(a.id, st);
  el.innerHTML = `<div class="toolbar">
      <button class="btn sm" data-f="up" title="Parent folder">↑</button><div class="crumbs" id="f-crumbs"></div><span class="grow"></span>
      <input type="search" id="f-q" placeholder="Filter…" style="max-width:160px">
      <button class="btn sm" data-f="refresh">Refresh</button><button class="btn sm" data-f="mkdir">New folder</button>
      <label class="btn sm primary" style="margin:0;color:#fff">Upload<input type="file" id="f-up" multiple hidden></label></div>
    <div class="small muted" id="f-status" style="min-height:18px;margin-bottom:6px"></div>
    <div class="card flush dropzone" id="f-zone"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th class="right">Size</th><th>Modified</th><th></th></tr></thead><tbody id="f-body"></tbody></table></div></div>
    <p class="small muted">Drag files onto the list to upload into the current folder. Folders download as ${isWin(a) ? '.zip' : '.tar.gz'}. Runs as ${isWin(a) ? 'SYSTEM' : 'root'}.</p>`;
  let entries = [];
  const status = (t) => { const s = $('#f-status'); if (s) s.textContent = t; };
  const draw = () => {
    const q = ($('#f-q')?.value || '').toLowerCase();
    const root = isWin(a) && !st.path;
    $('#f-body').innerHTML = entries.filter((e) => !q || e.name.toLowerCase().includes(q)).map((e) => `<tr data-name="${esc(e.name)}" data-dir="${e.dir ? 1 : 0}">
        <td><span class="fname"><span class="ic">${e.dir ? (root ? '💽' : '📁') : '📄'}</span>${e.dir ? `<a href="#" data-fa="open">${esc(e.name)}</a>` : esc(e.name)}</span></td>
        <td class="right small nowrap">${e.dir && !root ? '' : fmtBytes(e.size)}</td>
        <td class="small nowrap">${e.mtime ? new Date(e.mtime).toLocaleString() : ''}</td>
        <td class="right nowrap">${root ? '' : `<button class="btn sm" data-fa="download">Download</button> <button class="btn sm" data-fa="rename">Rename</button> <button class="btn sm danger" data-fa="delete">Delete</button>`}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Empty folder</td></tr>';
  };
  const load = async () => {
    $('#f-crumbs').innerHTML = fsCrumbs(a, st.path).map(([l, p]) => `<a href="#" data-crumb="${esc(p)}">${esc(l)}</a>`).join('<span class="muted">›</span>');
    status('Loading…');
    $('#f-body').innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
    try {
      const j = await deviceTask(a.id, 'files.list', { path: st.path });
      entries = parseTsv(j.stdout).map(([t, size, mt, ...rest]) => ({ dir: t === 'd', size: Number(size) || 0, mtime: Number(mt) * 1000, name: rest.join('\t') }))
        .filter((e) => e.name)
        .sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));
      status(`${entries.length} item${entries.length === 1 ? '' : 's'}`);
    } catch (err) {
      entries = [];
      status(err.message);
    }
    draw();
  };
  const go = (p) => { st.path = p; $('#f-q').value = ''; load(); };

  const download = async (e) => {
    const p = fsJoin(a, st.path, e.name);
    status(`Preparing ${e.name}…`);
    const r = await api('POST', `/api/agents/${a.id}/files/download`, { path: p, is_dir: e.dir });
    const j = await pollJob(r.job.id, (jj) => status(`${e.name}: ${jj.status === 'queued' ? 'waiting for the device' : 'the device is sending the file'}…`));
    if (j.status !== 'success') throw new Error(cleanErr(j.stderr) || 'Download failed');
    const link = document.createElement('a');
    link.href = `/api/transfers/${r.transfer_id}`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
    status(`Downloaded ${e.name}`);
  };

  const upload = async (files) => {
    if (isWin(a) && !st.path) { toast('Open a drive or folder first', 'error'); return; }
    for (const f of files) {
      if (entries.some((x) => x.name.toLowerCase() === f.name.toLowerCase())
        && !await confirmDialog(`${f.name} already exists here. Overwrite it?`, { okLabel: 'Overwrite', danger: true })) continue;
      const dest = fsJoin(a, st.path, f.name);
      const r = await xhrUpload(`/api/agents/${a.id}/files/upload?path=${encodeURIComponent(dest)}`, f, (pct) => status(`Uploading ${f.name}… ${pct}%`));
      const j = await pollJob(r.job.id, () => status(`Sending ${f.name} to the device…`));
      if (j.status === 'success') toast(`Uploaded ${f.name}`); else toast(`${f.name}: ${cleanErr(j.stderr) || 'upload failed'}`, 'error');
    }
    await load();
  };

  el.addEventListener('click', guard(async (ev) => {
    const crumb = ev.target.closest('[data-crumb]');
    if (crumb) { ev.preventDefault(); go(crumb.dataset.crumb); return; }
    const fb = ev.target.closest('[data-f]');
    if (fb) {
      const op = fb.dataset.f;
      if (op === 'up') go(fsParent(a, st.path));
      if (op === 'refresh') load();
      if (op === 'mkdir') {
        if (isWin(a) && !st.path) { toast('Open a drive first', 'error'); return; }
        const name = await promptDialog('New folder', 'Folder name');
        if (!name) return;
        await deviceTask(a.id, 'files.mkdir', { path: fsJoin(a, st.path, name) });
        load();
      }
      return;
    }
    const act = ev.target.closest('[data-fa]');
    if (!act) return;
    ev.preventDefault();
    const row = act.closest('tr');
    const e = entries.find((x) => x.name === row.dataset.name);
    if (!e) return;
    const p = fsJoin(a, st.path, e.name);
    switch (act.dataset.fa) {
      case 'open': go(isWin(a) && !st.path ? e.name : p); break;
      case 'download': await download(e); break;
      case 'rename': {
        const to = await promptDialog(`Rename ${e.name}`, 'New name', e.name);
        if (!to || to === e.name) return;
        await deviceTask(a.id, 'files.rename', { path: p, to });
        load();
        break;
      }
      case 'delete':
        if (!await confirmDialog(`Delete ${e.dir ? 'the folder' : ''} ${p}${e.dir ? ' and everything in it' : ''}? This cannot be undone.`, { okLabel: 'Delete', danger: true })) return;
        status(`Deleting ${e.name}…`);
        await deviceTask(a.id, 'files.delete', { path: p });
        toast(`Deleted ${e.name}`);
        load();
        break;
      default:
    }
  }));
  $('#f-q').addEventListener('input', draw);
  $('#f-up').addEventListener('change', guard(async (ev) => { const files = [...ev.target.files]; ev.target.value = ''; await upload(files); }));
  const zone = $('#f-zone');
  zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', guard(async (ev) => { ev.preventDefault(); zone.classList.remove('drag'); await upload([...ev.dataTransfer.files]); }));
  await load();
}

function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const m = openModal(title, `<form id="pd-form"><div class="field"><label>${esc(label)}</label><input type="text" name="v" value="${esc(value)}" required></div></form>`,
      { foot: '<button class="btn" data-k="no">Cancel</button><button class="btn primary" form="pd-form">OK</button>' });
    const input = $('input', m);
    input.focus();
    input.select();
    $('#pd-form', m).addEventListener('submit', (e) => { e.preventDefault(); const v = input.value.trim(); closeModal(); resolve(v); });
    m.addEventListener('click', (e) => { if (e.target.closest('[data-k="no"]')) { closeModal(); resolve(null); } });
  });
}

// ---------------- OS updates ----------------
async function devUpdates(el, a) {
  const sel = new Set();
  let reboot = false;
  let busy = false;
  const draw = async () => {
    const d = await api('GET', `/api/agents/${a.id}/updates`);
    busy = !!d.running;
    const sec = (u) => /critical|important|security/i.test(`${u.severity} ${u.category}`);
    const ids = new Set(d.updates.map((u) => u.uid));
    for (const id of [...sel]) if (!ids.has(id)) sel.delete(id);
    el.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="row" style="justify-content:space-between">
        <div><strong>${d.checked_at ? `${d.updates.length} pending update${d.updates.length === 1 ? '' : 's'}` : 'Not scanned yet'}</strong>
          ${d.updates.filter(sec).length ? badge(`${d.updates.filter(sec).length} security`, 'bad') : ''} ${d.reboot_required ? badge('reboot required', 'warn') : ''}
          <div class="small muted">${d.checked_at ? `Last scanned ${fmtAgo(d.checked_at)}` : ''}${busy ? ` · ${d.running.task === 'updates.install' ? 'Installing updates' : 'Scanning'} (${d.running.status})…` : ''}
          · ${a.platform === 'windows' ? 'Windows Update' : 'system package manager'}</div></div>
        ${can('tech') ? `<div class="row"><label class="check small" style="margin:0"><input type="checkbox" id="u-reboot" ${reboot ? 'checked' : ''}> Reboot if required</label>
          <button class="btn" data-u="scan" ${busy ? 'disabled' : ''}>Scan now</button>
          <button class="btn" data-u="selected" ${busy || !sel.size ? 'disabled' : ''}>Install selected (${sel.size})</button>
          <button class="btn primary" data-u="all" ${busy || !d.updates.length ? 'disabled' : ''}>Install all</button></div>` : ''}
      </div></div>
      <div class="card flush"><div class="table-wrap"><table>
        <thead><tr>${can('tech') ? '<th style="width:32px"><input type="checkbox" id="u-all"></th>' : ''}<th>Update</th><th>Severity</th><th>Category / repo</th></tr></thead>
        <tbody>${d.updates.map((u) => `<tr>${can('tech') ? `<td><input type="checkbox" data-uid="${esc(u.uid)}" ${sel.has(u.uid) ? 'checked' : ''}></td>` : ''}
          <td>${esc(u.title)}${u.kb ? ` <span class="small muted mono">${esc(u.kb)}</span>` : ''}</td>
          <td>${u.severity ? badge(u.severity, sec(u) ? 'bad' : 'info') : (sec(u) ? badge('security', 'bad') : '')}</td><td class="small">${esc(u.category)}</td></tr>`).join('')
          || `<tr><td colspan="4" class="empty">${d.checked_at ? 'Up to date 🎉' : 'Click "Scan now" to check for updates.'}</td></tr>`}</tbody></table></div></div>`;
  };
  el.addEventListener('change', (e) => {
    if (e.target.id === 'u-reboot') reboot = e.target.checked;
    if (e.target.dataset.uid) { e.target.checked ? sel.add(e.target.dataset.uid) : sel.delete(e.target.dataset.uid); draw(); }
    if (e.target.id === 'u-all') { $$('[data-uid]', el).forEach((cb) => { e.target.checked ? sel.add(cb.dataset.uid) : sel.delete(cb.dataset.uid); }); draw(); }
  });
  el.addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-u]');
    if (!b) return;
    const op = b.dataset.u;
    if (op === 'scan') await deviceTask(a.id, 'updates.scan', {}, { wait: false });
    else {
      const n = op === 'all' ? 'all pending updates' : `${sel.size} selected update(s)`;
      if (!await confirmDialog(`Install ${n} on ${a.hostname}${reboot ? ' and reboot automatically if required' : ''}?`, { okLabel: 'Install' })) return;
      await deviceTask(a.id, 'updates.install', { ids: op === 'all' ? 'all' : [...sel], reboot }, { wait: false });
      sel.clear();
    }
    toast(op === 'scan' ? 'Scan started' : 'Installation started. Progress is in Script history.');
    await draw();
  }));
  await draw();
  every(5000, async () => { if (busy) await draw(); });
}

// ---------------- local users ----------------
async function devUsers(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">Managing users requires the tech role.</div>'; return; }
  el.innerHTML = `<div class="toolbar"><span class="muted small" id="us-status">Loading…</span><span class="grow"></span>
      <button class="btn sm" id="us-refresh">Refresh</button><button class="btn primary" id="us-new">New user</button></div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>User</th><th>Full name</th><th>Status</th><th>Admin</th><th>${isWin(a) ? 'Last logon' : 'Home / shell'}</th><th></th></tr></thead>
    <tbody id="us-body"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div></div>
    <p class="small muted">Local accounts only${isWin(a) ? ' (domain accounts are managed in Active Directory)' : ''}. Passwords are masked in job history.</p>`;
  let users = [];
  const load = async () => {
    $('#us-status').textContent = 'Loading…';
    try {
      const j = await deviceTask(a.id, 'users.list');
      users = parseTsv(j.stdout, 'U').map(([name, enabled, admin, fullname, last, extra]) => ({ name, enabled: enabled === '1', admin: admin === '1', fullname, last: Number(last) * 1000, extra }));
      $('#us-status').textContent = `${users.length} account${users.length === 1 ? '' : 's'}`;
    } catch (err) { $('#us-status').textContent = err.message; }
    $('#us-body').innerHTML = users.map((u) => `<tr data-user="${esc(u.name)}"><td><strong>${esc(u.name)}</strong></td><td>${esc(u.fullname)}</td>
      <td>${u.enabled ? badge('enabled', 'ok') : badge('disabled')}</td><td>${u.admin ? badge('admin', 'warn') : ''}</td>
      <td class="small">${isWin(a) ? (u.last ? fmtAgo(u.last) : 'never') : esc(u.extra)}</td>
      <td class="right nowrap"><button class="btn sm" data-ua="password">Reset password</button>
        <button class="btn sm" data-ua="${u.enabled ? 'disable' : 'enable'}">${u.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn sm" data-ua="${u.admin ? 'unadmin' : 'admin'}">${u.admin ? 'Remove admin' : 'Make admin'}</button>
        <button class="btn sm danger" data-ua="delete">Delete</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No users</td></tr>';
  };
  const runUpdate = async (args, done) => {
    const j = await deviceTask(a.id, 'users.update', args);
    toast(done || (j.stdout || 'Done').trim().split('\n').pop());
    await load();
  };
  $('#us-refresh').addEventListener('click', guard(load));
  $('#us-new').addEventListener('click', () => userFormModal(a, null, guard(async (vals) => {
    const j = await deviceTask(a.id, 'users.create', vals);
    toast((j.stdout || 'User created').trim().split('\n').pop());
    closeModal();
    await load();
  })));
  $('#us-body').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-ua]');
    if (!b) return;
    const name = b.closest('tr').dataset.user;
    switch (b.dataset.ua) {
      case 'password':
        userFormModal(a, name, guard(async (vals) => { await runUpdate({ name, password: vals.password, must_change: vals.must_change }, `Password changed for ${name}`); closeModal(); }));
        break;
      case 'enable': await runUpdate({ name, enabled: true }); break;
      case 'disable':
        if (await confirmDialog(`Disable ${name}? They won't be able to sign in.`, { okLabel: 'Disable', danger: true })) await runUpdate({ name, enabled: false });
        break;
      case 'admin':
        if (await confirmDialog(`Give ${name} administrator rights on ${a.hostname}?`, { okLabel: 'Make admin' })) await runUpdate({ name, admin: true });
        break;
      case 'unadmin': await runUpdate({ name, admin: false }); break;
      case 'delete': {
        const m = openModal(`Delete ${name}`, `<p>Delete the local account <strong>${esc(name)}</strong> on ${esc(a.hostname)}?</p>
          <label class="check"><input type="checkbox" id="ud-home"> Also delete ${isWin(a) ? 'their profile folder' : 'their home folder'} (cannot be undone)</label>`,
        { foot: '<button class="btn" data-k="no">Cancel</button><button class="btn danger solid" data-k="yes">Delete</button>' });
        m.addEventListener('click', guard(async (ev) => {
          const k = ev.target.closest('[data-k]')?.dataset.k;
          if (!k) return;
          const home = $('#ud-home', m).checked;
          closeModal();
          if (k === 'yes') { const j = await deviceTask(a.id, 'users.delete', { name, remove_home: home }); toast((j.stdout || 'Deleted').trim().split('\n')[0]); await load(); }
        }));
        break;
      }
      default:
    }
  }));
  await load();
}

function userFormModal(a, existing, onSubmit) {
  const m = openModal(existing ? `Reset password for ${existing}` : `New local user on ${a.hostname}`, `<form id="uf-form">
    ${existing ? '' : `<div class="form-grid"><div class="field"><label>Username</label><input type="text" name="name" required maxlength="${isWin(a) ? 20 : 32}" autocomplete="off"></div>
      <div class="field"><label>Full name (optional)</label><input type="text" name="fullname" maxlength="100"></div></div>`}
    <div class="form-grid"><div class="field"><label>Password (min 8 chars)</label><input type="password" name="password" minlength="8" required autocomplete="new-password"></div>
      <div class="field"><label>Confirm password</label><input type="password" name="confirm" minlength="8" required autocomplete="new-password"></div></div>
    ${existing ? '' : '<label class="check"><input type="checkbox" name="admin"> Administrator</label>'}
    <label class="check"><input type="checkbox" name="must_change"> Must change password at next sign-in</label>
    <div class="error-text" id="uf-err" style="margin-top:8px"></div></form>`,
  { foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="uf-form">${existing ? 'Reset password' : 'Create user'}</button>` });
  $('#uf-form', m).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (f.password.value !== f.confirm.value) { $('#uf-err', m).textContent = 'Passwords do not match'; return; }
    onSubmit({
      name: f.namedItem('name') ? f.namedItem('name').value.trim() : undefined,
      fullname: f.namedItem('fullname') ? f.namedItem('fullname').value : '',
      password: f.password.value, admin: f.namedItem('admin') ? f.namedItem('admin').checked : undefined,
      must_change: f.must_change.checked,
    });
  });
}

function alertsTable(alerts, { showHost = true } = {}) {
  return `<div class="card flush"><div class="table-wrap"><table>
    <thead><tr><th>Severity</th>${showHost ? '<th>Device</th><th>Client</th>' : ''}<th>Type</th><th>Message</th><th>Status</th><th>Raised</th><th></th></tr></thead>
    <tbody>${alerts.map((al) => `<tr><td>${badge(al.severity)}</td>
      ${showHost ? `<td><a href="#/devices/${al.agent_id}">${esc(al.hostname)}</a></td><td class="small">${esc(al.client_name || '—')}</td>` : ''}
      <td>${esc(al.type)}</td><td>${esc(al.message)}</td><td>${badge(al.status)}</td>
      <td class="small nowrap" title="${fmtDate(al.created_at)}">${fmtAgo(al.created_at)}${al.resolved_at ? `<div class="muted">resolved ${fmtAgo(al.resolved_at)}</div>` : ''}</td>
      <td class="right nowrap">${can('tech') && al.status === 'open' ? `<button class="btn sm" data-action="alert" data-op="ack" data-id="${al.id}">Ack</button> ` : ''}${can('tech') && al.status !== 'resolved' ? `<button class="btn sm" data-action="alert" data-op="resolve" data-id="${al.id}">Resolve</button>` : ''}</td></tr>`).join('')
      || `<tr><td colspan="8" class="empty">No alerts</td></tr>`}</tbody></table></div></div>`;
}

async function devAlerts(el, a) {
  el.innerHTML = alertsTable(await api('GET', `/api/agents/${a.id}/alerts`), { showHost: false });
}

async function devSettings(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">Read-only access.</div>'; return; }
  const clients = await api('GET', '/api/clients');
  el.innerHTML = `<div class="grid cols-2">
    <form class="card" id="dev-form"><h2>Device settings</h2>
      <div class="field"><label>Client</label><select name="client_id"><option value="">— none —</option>${clients.map((c) => `<option value="${c.id}" ${c.id === a.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="5">${esc(a.notes)}</textarea></div>
      <div class="field"><label class="check"><input type="checkbox" name="maintenance" ${a.maintenance ? 'checked' : ''}> Maintenance mode (suppress alerts)</label></div>
      <button class="btn primary">Save</button></form>
    ${can('admin') ? `<div class="card"><h2>Danger zone</h2>
      <p class="small muted">Uninstall removes the agent from the host the next time it checks in, then you can remove the device record.</p>
      <div class="row"><button class="btn danger" data-action="uninstall-agent" data-id="${a.id}">Uninstall agent</button>
      <button class="btn danger solid" data-action="delete-agent" data-id="${a.id}">Remove device record</button></div></div>` : ''}
  </div>`;
  $('#dev-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('PUT', `/api/agents/${a.id}`, { client_id: f.get('client_id') || null, notes: f.get('notes'), maintenance: f.get('maintenance') === 'on' });
    toast('Device saved');
    router();
  }));
}

// ---------------- run-script modal ----------------
async function openRunModal(agentIds) {
  const [scripts, agents] = await Promise.all([api('GET', '/api/scripts'), api('GET', '/api/agents')]);
  const targets = agents.filter((a) => agentIds.includes(a.id));
  const platforms = new Set(targets.map((t) => t.platform));
  const compatible = (shell) => SHELL_OS[shell] === 'any' || platforms.has(SHELL_OS[shell]);
  const shellOpts = Object.keys(SHELL_OS).filter(compatible);
  const m = openModal(`Run on ${targets.length === 1 ? targets[0].hostname : targets.length + ' devices'}`, `
    <div class="tabs"><a href="#" class="active" data-mode="library">From library</a><a href="#" data-mode="adhoc">Ad-hoc command</a></div>
    <div data-pane="library">
      <div class="field"><label>Script</label><select id="rm-script">${scripts.filter((s) => compatible(s.shell)).map((s) => `<option value="${s.id}">[${esc(s.category)}] ${esc(s.name)} (${s.shell})</option>`).join('') || '<option value="">No compatible scripts</option>'}</select></div>
      <div class="small muted" id="rm-desc"></div>
      <pre class="out" id="rm-preview" style="max-height:220px;margin-top:8px"></pre>
    </div>
    <div data-pane="adhoc" class="hidden">
      <div class="field"><label>Shell</label><select id="rm-shell">${shellOpts.map((s) => `<option>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Command</label><textarea id="rm-body" class="code" style="min-height:160px" spellcheck="false"></textarea></div>
    </div>
    <div class="field" style="margin-top:12px"><label>Timeout (seconds, blank = script default)</label><input id="rm-timeout" type="number" min="5" max="86400"></div>
    ${platforms.size > 1 ? '<div class="small muted">Mixed Windows/Linux selection: devices that cannot run the chosen shell are skipped.</div>' : ''}
  `, { wide: true, foot: '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" id="rm-go">Run now</button>' });
  let mode = 'library';
  const preview = () => {
    const s = scripts.find((x) => String(x.id) === $('#rm-script', m).value);
    $('#rm-desc', m).textContent = s ? `${s.description || ''} · timeout ${s.timeout}s` : '';
    $('#rm-preview', m).textContent = s ? s.body : '';
  };
  preview();
  $('#rm-script', m).addEventListener('change', preview);
  $$('[data-mode]', m).forEach((t) => t.addEventListener('click', (e) => {
    e.preventDefault();
    mode = t.dataset.mode;
    $$('[data-mode]', m).forEach((x) => x.classList.toggle('active', x === t));
    $$('[data-pane]', m).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== mode));
  }));
  $('#rm-go', m).addEventListener('click', guard(async () => {
    const timeout = Number($('#rm-timeout', m).value) || undefined;
    const body = mode === 'library'
      ? { agent_ids: agentIds, script_id: Number($('#rm-script', m).value), timeout }
      : { agent_ids: agentIds, shell: $('#rm-shell', m).value, body: $('#rm-body', m).value, timeout };
    const r = await api('POST', '/api/jobs', body);
    closeModal();
    toast(`Queued on ${r.created} device(s)${r.skipped.length ? `, skipped ${r.skipped.length} (incompatible)` : ''}`);
    if (r.created) location.hash = `#/jobs/batch/${r.batch_id}`;
  }));
}

async function openJobModal(id) {
  const m = openModal('Job output', '<div class="muted">Loading…</div>', { wide: true });
  const draw = async () => {
    const j = await api('GET', `/api/jobs/${id}`);
    $('.modal-body', m).innerHTML = `
      <dl class="kv" style="margin-bottom:14px">
        <dt>Device</dt><dd><a href="#/devices/${j.agent_id}">${esc(j.hostname)}</a></dd>
        <dt>Script</dt><dd>${esc(j.name)} <span class="muted">(${esc(j.shell)})</span></dd>
        <dt>Status</dt><dd>${badge(j.status)} ${j.exit_code != null ? `<span class="muted">exit code ${j.exit_code}</span>` : ''}</dd>
        <dt>Queued</dt><dd>${fmtDate(j.created_at)} by ${esc(j.created_by)}</dd>
        <dt>Duration</dt><dd>${j.finished_at && j.sent_at ? fmtDur(j.finished_at - j.sent_at) : '—'}</dd></dl>
      <h3>Output</h3><pre class="out">${esc(j.stdout) || '<span class="muted">(none)</span>'}</pre>
      ${j.stderr ? `<h3 style="margin-top:12px">Errors</h3><pre class="out err">${esc(j.stderr)}</pre>` : ''}
      <details style="margin-top:12px"><summary class="small muted">Script source</summary><pre class="out" style="margin-top:8px">${esc(j.body)}</pre></details>
      ${j.status === 'queued' && can('tech') ? `<div style="margin-top:12px"><button class="btn danger" data-action="cancel-job" data-id="${j.id}">Cancel job</button></div>` : ''}`;
    if (!['queued', 'running'].includes(j.status) && state.modalTimer) { clearInterval(state.modalTimer); state.modalTimer = null; }
  };
  await draw();
  state.modalTimer = setInterval(guard(draw), 2500);
}

// ---------------- clients ----------------
async function pageClients(view) {
  const clients = await api('GET', '/api/clients');
  view.innerHTML = `<div class="page-head"><h1>Clients</h1>${can('tech') ? '<button class="btn primary" data-action="new-client">+ New client</button>' : ''}</div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Devices</th><th>Online</th><th>Notes</th></tr></thead><tbody>
    ${clients.map((c) => `<tr class="clickable" data-href="#/clients/${c.id}"><td><strong>${esc(c.name)}</strong></td><td>${c.device_count}</td>
      <td>${c.online_count}/${c.device_count}</td><td class="small muted">${esc(c.notes).slice(0, 120)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">No clients yet. Create one to start enrolling devices.</td></tr>'}
    </tbody></table></div></div>`;
}

function newClientModal() {
  const m = openModal('New client', `<form id="nc-form"><div class="field"><label>Name</label><input name="name" type="text" required autofocus></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="3"></textarea></div></form>`,
  { foot: '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="nc-form">Create</button>' });
  $('#nc-form', m).addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const c = await api('POST', '/api/clients', { name: f.get('name'), notes: f.get('notes') });
    closeModal();
    location.hash = `#/clients/${c.id}`;
  }));
}

const dlUrl = (server, token, file) => `${server}/download/${token}/${file}`;

function installCommands(server, token) {
  return {
    windows: `irm '${server}/install/windows?token=${token}' | iex`,
    linux: `curl -fsSL '${server}/install/linux?token=${token}' | sudo bash`,
  };
}

async function pageClient(view, id) {
  const c = await api('GET', `/api/clients/${id}`);
  const tokens = c.tokens.filter((t) => !t.expires_at || t.expires_at > Date.now());
  const latest = tokens[0];
  const cmds = latest ? installCommands(c.server_url, latest.token) : null;
  view.innerHTML = `
    <div class="page-head"><h1>${esc(c.name)}</h1><div class="row">
      ${can('tech') && c.devices.length ? `<button class="btn primary" data-action="run-on" data-ids="${c.devices.map((d) => d.id).join(',')}">Run script on all ${c.devices.length}</button>` : ''}
      ${can('tech') ? '<button class="btn" data-action="edit-client">Edit</button>' : ''}${can('admin') ? `<button class="btn danger" data-action="delete-client" data-id="${c.id}">Delete</button>` : ''}</div></div>
    ${c.notes ? `<div class="card" style="margin-bottom:16px;white-space:pre-wrap">${esc(c.notes)}</div>` : ''}
    ${can('tech') ? `<div class="card" style="margin-bottom:16px"><h2>Install the agent</h2>
      ${cmds ? `
        <p class="small muted">Devices enroll into <strong>${esc(c.name)}</strong>. Token ${latest.expires_at ? `expires ${fmtDate(latest.expires_at)}` : 'never expires'}.</p>
        <h3>Download an installer</h3>
        <div class="row field">
          <a class="btn primary" href="${esc(dlUrl(c.server_url, latest.token, 'HostPilot-Setup.exe'))}">⬇ Windows installer (.exe)</a>
          <button class="btn sm" data-action="copy" data-text="${esc(dlUrl(c.server_url, latest.token, 'HostPilot-Setup.exe'))}">Copy link</button>
          <span style="width:12px"></span>
          <a class="btn" href="${esc(dlUrl(c.server_url, latest.token, 'hostpilot-install.sh'))}">⬇ Linux installer (.sh)</a>
          <button class="btn sm" data-action="copy" data-text="${esc(dlUrl(c.server_url, latest.token, 'hostpilot-install.sh'))}">Copy link</button>
        </div>
        <p class="small muted">Email the link to the client. Windows: double-click the .exe and approve the admin prompt. It isn't code-signed, so SmartScreen may warn
          ("More info → Run anyway"); <code>HostPilot-Setup.exe /quiet</code> installs silently (e.g. via GPO/Intune). Linux: <code>sudo bash hostpilot-install.sh</code>.
          Links stop working when the token expires or is revoked.</p>
        <h3>Or use a one-line command</h3>
        <label>Windows: elevated PowerShell (Windows 10 / Server 2016 or newer)</label>
        <div class="copybox field"><code>${esc(cmds.windows)}</code><button class="btn" data-action="copy" data-text="${esc(cmds.windows)}">Copy</button></div>
        <label>Linux: any systemd distro, as root</label>
        <div class="copybox field"><code>${esc(cmds.linux)}</code><button class="btn" data-action="copy" data-text="${esc(cmds.linux)}">Copy</button></div>
        ${c.server_url.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(c.server_url) ? '<p class="small" style="color:var(--warn)">⚠ The server is being reached over plain HTTP. Put it behind HTTPS (see README) before enrolling hosts over the internet.</p>' : ''}`
      : '<p class="muted">No active enrollment token. Create one to get install commands.</p>'}
      <details ${cmds ? '' : 'open'}><summary class="small">Manage enrollment tokens (${tokens.length} active)</summary>
        <div class="row" style="margin:12px 0"><select id="tok-days" style="width:auto"><option value="1">Expires in 1 day</option><option value="7">7 days</option><option value="30" selected>30 days</option><option value="365">1 year</option><option value="0">Never</option></select>
          <button class="btn" data-action="new-token" data-id="${c.id}">Create token</button></div>
        <table><thead><tr><th>Token</th><th>Created</th><th>Expires</th><th>Uses</th><th></th></tr></thead><tbody>
        ${c.tokens.map((t) => `<tr><td class="mono small">${esc(t.token.slice(0, 10))}…</td><td class="small">${fmtDate(t.created_at)}</td>
          <td class="small">${t.expires_at ? (t.expires_at < Date.now() ? badge('expired', 'bad') : fmtDate(t.expires_at)) : 'never'}</td><td>${t.uses}</td>
          <td class="right"><button class="btn sm danger" data-action="revoke-token" data-token="${t.token}">Revoke</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No tokens</td></tr>'}
        </tbody></table></details></div>` : ''}
    <h2>Devices (${c.devices.length})</h2>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Hostname</th><th>OS</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Last seen</th></tr></thead><tbody>
    ${c.devices.map((a) => `<tr class="clickable" data-href="#/devices/${a.id}"><td>${statusDot(a)}<strong>${esc(a.hostname)}</strong></td><td>${osCell(a)}</td>
      <td>${meter(a.cpu_pct)}</td><td>${meter(a.mem_pct)}</td><td>${meter(a.disk_pct)}</td><td class="small">${a.online ? 'Online' : fmtAgo(a.last_seen)}</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">No devices enrolled yet</td></tr>'}</tbody></table></div></div>`;
  state.currentClient = c;
}

function editClientModal() {
  const c = state.currentClient;
  const m = openModal('Edit client', `<form id="ec-form"><div class="field"><label>Name</label><input name="name" type="text" value="${esc(c.name)}" required></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="5">${esc(c.notes)}</textarea></div></form>`,
  { foot: '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="ec-form">Save</button>' });
  $('#ec-form', m).addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('PUT', `/api/clients/${c.id}`, { name: f.get('name'), notes: f.get('notes') });
    closeModal(); router();
  }));
}

// ---------------- scripts ----------------
async function pageScripts(view) {
  const scripts = await api('GET', '/api/scripts');
  const cats = [...new Set(scripts.map((s) => s.category))];
  view.innerHTML = `<div class="page-head"><h1>Script library</h1>${can('tech') ? '<a class="btn primary" href="#/scripts/new">+ New script</a>' : ''}</div>
    <div class="toolbar"><input type="search" id="sc-q" placeholder="Filter scripts…">
      <select id="sc-os"><option value="">All platforms</option><option value="windows">Windows</option><option value="linux">Linux</option></select></div>
    <div id="sc-list"></div>`;
  const draw = () => {
    const q = $('#sc-q').value.toLowerCase();
    const os = $('#sc-os').value;
    const vis = scripts.filter((s) => (!q || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q)) && (!os || SHELL_OS[s.shell] === os || SHELL_OS[s.shell] === 'any'));
    $('#sc-list').innerHTML = cats.map((cat) => {
      const rows = vis.filter((s) => s.category === cat);
      if (!rows.length) return '';
      return `<h3 style="margin-top:18px">${esc(cat)}</h3><div class="card flush"><div class="table-wrap"><table><tbody>
        ${rows.map((s) => `<tr class="clickable" data-href="#/scripts/${s.id}"><td style="width:34%"><strong>${esc(s.name)}</strong></td>
          <td><span class="os">${ICONS[SHELL_OS[s.shell]] || ''}${esc(s.shell)}</span></td><td class="small muted">${esc(s.description)}</td><td class="small nowrap">${s.timeout}s</td></tr>`).join('')}
        </tbody></table></div></div>`;
    }).join('') || '<div class="card muted">No scripts match.</div>';
  };
  $('#sc-q').addEventListener('input', draw);
  $('#sc-os').addEventListener('change', draw);
  draw();
}

async function pageScriptEdit(view, id) {
  const isNew = id === 'new';
  const s = isNew ? { name: '', category: 'General', shell: 'powershell', timeout: 300, description: '', body: '' } : await api('GET', `/api/scripts/${id}`);
  const ro = !can('tech');
  view.innerHTML = `<div class="page-head"><h1>${isNew ? 'New script' : esc(s.name)}</h1><div class="row">
      ${!isNew && can('tech') ? `<button class="btn" data-action="run-script-pick" data-id="${s.id}">Run on devices…</button><button class="btn danger" data-action="delete-script" data-id="${s.id}">Delete</button>` : ''}</div></div>
    <form class="card" id="sc-form"><fieldset ${ro ? 'disabled' : ''} style="border:0;padding:0;margin:0">
      <div class="form-grid">
        <div class="field"><label>Name</label><input name="name" type="text" value="${esc(s.name)}" required></div>
        <div class="field"><label>Category</label><input name="category" type="text" value="${esc(s.category)}"></div>
        <div class="field"><label>Shell</label><select name="shell">${Object.keys(SHELL_OS).map((sh) => `<option ${sh === s.shell ? 'selected' : ''}>${sh}</option>`).join('')}</select></div>
        <div class="field"><label>Timeout (seconds)</label><input name="timeout" type="number" min="5" max="86400" value="${s.timeout}"></div>
      </div>
      <div class="field"><label>Description</label><input name="description" type="text" value="${esc(s.description)}"></div>
      <div class="field"><label>Script</label><textarea name="body" class="code" spellcheck="false">${esc(s.body)}</textarea></div>
      <div class="row"><button class="btn primary">${isNew ? 'Create' : 'Save'}</button><a class="btn" href="#/scripts">Back</a>
      <span class="small muted">Exit code 0 = success. Output is captured from stdout/stderr (max 1 MB each).</span></div>
    </fieldset></form>`;
  const form = $('#sc-form');
  form.body.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const t = e.target; t.setRangeText('    ', t.selectionStart, t.selectionEnd, 'end'); }
  });
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    f.timeout = Number(f.timeout);
    const saved = isNew ? await api('POST', '/api/scripts', f) : await api('PUT', `/api/scripts/${id}`, f);
    toast('Script saved');
    if (isNew) location.hash = `#/scripts/${saved.id}`;
  }));
}

async function pickDevicesModal(title, onPick) {
  const agents = await api('GET', '/api/agents');
  const m = openModal(title, `<div class="toolbar"><input type="search" id="pk-q" placeholder="Filter devices…"><label class="check small"><input type="checkbox" id="pk-all"> all visible</label></div>
    <div style="max-height:380px;overflow:auto" id="pk-list"></div>`,
  { foot: '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" id="pk-go">Continue</button>' });
  const sel = new Set();
  const draw = () => {
    const q = $('#pk-q', m).value.toLowerCase();
    $('#pk-list', m).innerHTML = agents.filter((a) => !q || `${a.hostname} ${a.client_name} ${a.os_name}`.toLowerCase().includes(q))
      .map((a) => `<label class="check" style="padding:5px 0"><input type="checkbox" value="${a.id}" ${sel.has(a.id) ? 'checked' : ''}>${statusDot(a)}${esc(a.hostname)} <span class="muted small">${esc(a.client_name || '')} · ${esc(a.platform)}</span></label>`).join('')
      || '<div class="muted">No devices</div>';
  };
  draw();
  $('#pk-q', m).addEventListener('input', draw);
  $('#pk-list', m).addEventListener('change', (e) => { e.target.checked ? sel.add(e.target.value) : sel.delete(e.target.value); });
  $('#pk-all', m).addEventListener('change', (e) => { $$('#pk-list input', m).forEach((cb) => { cb.checked = e.target.checked; e.target.checked ? sel.add(cb.value) : sel.delete(cb.value); }); });
  $('#pk-go', m).addEventListener('click', () => { if (!sel.size) return toast('Select at least one device', 'error'); onPick([...sel]); });
}

// ---------------- automation ----------------
const INTERVALS = [[15, 'Every 15 minutes'], [60, 'Hourly'], [360, 'Every 6 hours'], [720, 'Every 12 hours'], [1440, 'Daily'], [10080, 'Weekly'], [43200, 'Every 30 days']];
const fmtInterval = (m) => (INTERVALS.find((i) => i[0] === m)?.[1]) || `Every ${m} min`;

async function pageAutomation(view) {
  const [schedules, clients, agents] = await Promise.all([api('GET', '/api/schedules'), api('GET', '/api/clients'), api('GET', '/api/agents')]);
  state.autoRefs = { clients, agents, schedules };
  const targetName = (s) => {
    if (s.target_type === 'all') return 'All devices';
    if (s.target_type === 'platform') return `All ${s.target_id} devices`;
    if (s.target_type === 'client') return `Client: ${clients.find((c) => String(c.id) === s.target_id)?.name || '?'}`;
    return `Device: ${agents.find((a) => a.id === s.target_id)?.hostname || '?'}`;
  };
  view.innerHTML = `<div class="page-head"><h1>Automation</h1>${can('tech') ? '<button class="btn primary" data-action="edit-schedule">+ New scheduled task</button>' : ''}</div>
    <p class="muted small">Scheduled tasks run a library script on a recurring interval. Offline devices get the job queued and run it when they reconnect.</p>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Script</th><th>Targets</th><th>Interval</th><th>Last run</th><th>Enabled</th><th></th></tr></thead><tbody>
    ${schedules.map((s) => `<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.script_name)} <span class="muted small">(${s.shell})</span></td><td>${esc(targetName(s))}</td>
      <td>${fmtInterval(s.interval_minutes)}</td><td class="small">${s.last_run ? fmtAgo(s.last_run) : 'never'}</td><td>${s.enabled ? badge('on', 'ok') : badge('off')}</td>
      <td class="right nowrap">${can('tech') ? `<button class="btn sm" data-action="run-schedule" data-id="${s.id}">Run now</button> <button class="btn sm" data-action="edit-schedule" data-id="${s.id}">Edit</button> <button class="btn sm danger" data-action="delete-schedule" data-id="${s.id}">Delete</button>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">No scheduled tasks</td></tr>'}</tbody></table></div></div>`;
}

async function editScheduleModal(id) {
  const { clients, agents, schedules } = state.autoRefs;
  const scripts = await api('GET', '/api/scripts');
  const s = schedules.find((x) => String(x.id) === String(id)) || { name: '', script_id: scripts[0]?.id, target_type: 'all', target_id: '', interval_minutes: 1440, enabled: 1 };
  const m = openModal(id ? 'Edit scheduled task' : 'New scheduled task', `<form id="sch-form">
    <div class="field"><label>Name</label><input name="name" type="text" value="${esc(s.name)}" required></div>
    <div class="field"><label>Script</label><select name="script_id">${scripts.map((x) => `<option value="${x.id}" ${x.id === s.script_id ? 'selected' : ''}>[${esc(x.category)}] ${esc(x.name)} (${x.shell})</option>`).join('')}</select></div>
    <div class="form-grid">
      <div class="field"><label>Target</label><select name="target_type">
        <option value="all">All devices</option><option value="platform">Platform</option><option value="client">Client</option><option value="agent">Single device</option></select></div>
      <div class="field"><label>&nbsp;</label><select name="target_id"></select></div></div>
    <div class="field"><label>Interval</label><select name="interval_minutes">${INTERVALS.map(([v, l]) => `<option value="${v}" ${v === s.interval_minutes ? 'selected' : ''}>${l}</option>`).join('')}
      ${INTERVALS.some((i) => i[0] === s.interval_minutes) ? '' : `<option value="${s.interval_minutes}" selected>Every ${s.interval_minutes} min</option>`}</select></div>
    <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Enabled</label></form>`,
  { foot: '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="sch-form">Save</button>' });
  const form = $('#sch-form', m);
  form.target_type.value = s.target_type;
  const fillTargets = () => {
    const t = form.target_type.value;
    const opts = t === 'client' ? clients.map((c) => [c.id, c.name]) : t === 'agent' ? agents.map((a) => [a.id, a.hostname]) : t === 'platform' ? [['windows', 'Windows'], ['linux', 'Linux']] : [];
    form.target_id.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(s.target_id) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    form.target_id.disabled = t === 'all';
  };
  fillTargets();
  form.target_type.addEventListener('change', fillTargets);
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const body = { name: form.name.value, script_id: Number(form.script_id.value), target_type: form.target_type.value, target_id: form.target_id.value, interval_minutes: Number(form.interval_minutes.value), enabled: form.enabled.checked };
    await api(id ? 'PUT' : 'POST', id ? `/api/schedules/${id}` : '/api/schedules', body);
    closeModal(); router();
  }));
}

// ---------------- jobs ----------------
async function pageJobs(view) {
  const draw = async () => {
    const jobs = await api('GET', '/api/jobs?limit=300');
    view.innerHTML = `<div class="page-head"><h1>Job history</h1></div>${jobsTable(jobs, { showHost: true })}`;
  };
  await draw();
  every(10000, draw);
}

async function pageBatch(view, batchId) {
  const draw = async () => {
    const jobs = await api('GET', `/api/jobs?batch=${encodeURIComponent(batchId)}`);
    const counts = jobs.reduce((m, j) => ({ ...m, [j.status]: (m[j.status] || 0) + 1 }), {});
    view.innerHTML = `<div class="page-head"><div><h1>${esc(jobs[0]?.name || 'Job results')}</h1>
      <div class="row small" style="margin-top:6px">${Object.entries(counts).map(([k, v]) => badge(`${v} ${k}`, k)).join(' ')}</div></div>
      <a class="btn" href="#/jobs">All jobs</a></div>${jobsTable(jobs, { showHost: true })}`;
    return jobs.some((j) => ['queued', 'running'].includes(j.status));
  };
  await draw();
  every(3000, draw);
}

// ---------------- alerts ----------------
async function pageAlerts(view) {
  view.innerHTML = `<div class="page-head"><h1>Alerts</h1><select id="al-status" style="width:auto"><option value="active">Active</option><option value="resolved">Resolved</option><option value="all">All</option></select></div><div id="al-list"></div>`;
  const draw = async () => { $('#al-list').innerHTML = alertsTable(await api('GET', `/api/alerts?status=${$('#al-status').value}`)); };
  $('#al-status').addEventListener('change', guard(draw));
  await draw();
  every(20000, draw);
}

// ---------------- software ----------------
async function pageSoftware(view) {
  view.innerHTML = `<div class="page-head"><h1>Software inventory</h1></div>
    <div class="toolbar"><input type="search" id="fs-q" placeholder="Search software across all devices (e.g. chrome, openssl)…" style="max-width:420px"><span class="muted small" id="fs-count"></span></div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Software</th><th>Version</th><th>Device</th><th>Client</th></tr></thead><tbody id="fs-body"><tr><td colspan="4" class="empty">Type to search</td></tr></tbody></table></div></div>`;
  let t;
  $('#fs-q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(guard(async () => {
      const q = e.target.value.trim();
      if (q.length < 2) { $('#fs-body').innerHTML = '<tr><td colspan="4" class="empty">Type at least 2 characters</td></tr>'; return; }
      const rows = await api('GET', `/api/software?q=${encodeURIComponent(q)}`);
      $('#fs-count').textContent = `${rows.length}${rows.length === 1000 ? '+' : ''} results`;
      $('#fs-body').innerHTML = rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono small">${esc(r.version)}</td><td><a href="#/devices/${r.agent_id}/software">${esc(r.hostname)}</a></td><td class="small">${esc(r.client_name || '—')}</td></tr>`).join('')
        || '<tr><td colspan="4" class="empty">No matches</td></tr>';
    }), 250);
  });
  $('#fs-q').focus();
}

// ---------------- settings ----------------
async function pageSettings(view) {
  const admin = can('admin');
  const [cfg, users, auditLog] = admin ? await Promise.all([api('GET', '/api/settings'), api('GET', '/api/users'), api('GET', '/api/audit')]) : [null, [], []];
  const s = cfg?.settings;
  const num = (k, label, hint) => `<div class="field"><label>${label}</label><input name="${k}" type="number" min="0" value="${s[k]}">${hint ? `<div class="small muted">${hint}</div>` : ''}</div>`;
  view.innerHTML = `<div class="page-head"><h1>Settings</h1></div><div class="grid cols-2">
    ${admin ? `<form class="card" id="set-form"><h2>Monitoring & alerting</h2>
      <div class="form-grid">${num('cpu_threshold', 'CPU alert %', '3-check average; 0 disables')}${num('mem_threshold', 'Memory alert %')}${num('disk_threshold', 'Disk alert %')}${num('offline_minutes', 'Offline alert after (min)')}</div>
      <div class="form-grid">${num('checkin_seconds', 'Agent check-in (sec)')}${num('inventory_hours', 'Inventory refresh (hours)')}${num('update_scan_hours', 'OS update scan (hours)', '0 disables automatic scans')}${num('metric_retention_days', 'Keep metrics (days)')}${num('job_retention_days', 'Keep job output (days)')}</div>
      <div class="field"><label>Alert webhook URL</label><input name="webhook_url" type="url" value="${esc(s.webhook_url)}" placeholder="https://hooks.slack.com/… or Discord / Teams / ntfy webhook"></div>
      <div class="row"><button class="btn primary">Save settings</button><button type="button" class="btn" data-action="test-webhook">Send test</button></div>
      <p class="small muted">Current agent versions: Windows <span class="mono">${cfg.agent_versions.windows}</span>, Linux <span class="mono">${cfg.agent_versions.linux}</span>. Agents self-update when these change.</p></form>` : ''}
    <form class="card" id="pw-form"><h2>Change my password</h2>
      <div class="field"><label>Current password</label><input name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label>New password (min 10 chars)</label><input name="password" type="password" autocomplete="new-password" minlength="10" required></div>
      <button class="btn primary">Update password</button></form>
    ${admin ? `<div class="card"><h2>Users</h2><table><thead><tr><th>User</th><th>Role</th><th>Last login</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.username)}</td><td><select data-role-user="${u.id}" style="width:auto">${['viewer', 'tech', 'admin'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td class="small">${u.last_login ? fmtAgo(u.last_login) : 'never'}</td><td class="right nowrap"><button class="btn sm" data-action="reset-pw" data-id="${u.id}" data-name="${esc(u.username)}">Reset password</button> ${u.id !== state.user.id ? `<button class="btn sm danger" data-action="delete-user" data-id="${u.id}" data-name="${esc(u.username)}">Delete</button>` : ''}</td></tr>`).join('')}
      </tbody></table>
      <form id="user-form" style="margin-top:14px"><div class="form-grid">
        <div class="field"><label>Username</label><input name="username" type="text" required></div>
        <div class="field"><label>Password</label><input name="password" type="password" minlength="10" autocomplete="new-password" required></div>
        <div class="field"><label>Role</label><select name="role"><option value="tech">tech (run scripts)</option><option value="viewer">viewer (read-only)</option><option value="admin">admin</option></select></div></div>
        <button class="btn">Add user</button></form></div>
    <div class="card flush" style="grid-column:1/-1"><h2>Audit log</h2><div class="table-wrap" style="max-height:420px"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${auditLog.map((r) => `<tr><td class="small nowrap">${fmtDate(r.ts)}</td><td>${esc(r.username)}</td><td class="mono small">${esc(r.action)}</td><td class="small">${esc(r.detail)}</td></tr>`).join('')}
    </tbody></table></div></div>` : ''}
  </div>`;
  $('#pw-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('POST', '/api/me/password', { current: f.get('current'), password: f.get('password') });
    e.target.reset(); toast('Password updated');
  }));
  if (!admin) return;
  $('#set-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target)));
    toast('Settings saved');
  }));
  $('#user-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('POST', '/api/users', Object.fromEntries(new FormData(e.target)));
    toast('User added'); router();
  }));
  $$('[data-role-user]').forEach((sel) => sel.addEventListener('change', guard(async () => {
    try { await api('PUT', `/api/users/${sel.dataset.roleUser}`, { role: sel.value }); toast('Role updated'); }
    catch (err) { router(); throw err; }
  })));
}

// ---------------- patching (fleet) ----------------
async function pagePatching(view) {
  const sel = new Set();
  let filter = state.patchFilter || '';
  let reboot = false;
  let rows = [];
  view.innerHTML = `<div id="p-root"><div class="page-head"><h1>Patching</h1>
      ${can('tech') ? `<div class="row"><label class="check small" style="margin:0"><input type="checkbox" id="p-reboot"> Reboot if required</label>
        <button class="btn" data-p="scan" disabled>Scan selected</button><button class="btn primary" data-p="install" disabled>Install all updates on selected</button></div>` : ''}</div>
    <div class="toolbar"><select id="p-filter"><option value="">All devices</option><option value="pending">Updates pending</option>
      <option value="security">Security updates pending</option><option value="reboot">Reboot required</option><option value="stale">Not scanned in 3+ days</option></select>
      <span class="small muted" id="p-count"></span></div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr>${can('tech') ? '<th style="width:32px"><input type="checkbox" id="p-all"></th>' : ''}
      <th>Device</th><th>Client</th><th>OS</th><th class="right">Pending</th><th class="right">Security</th><th>Reboot</th><th>Last scan</th><th>Status</th></tr></thead>
      <tbody id="p-body"></tbody></table></div></div>
    <p class="small muted">Devices are scanned automatically (interval under Settings). Windows uses Windows Update; Linux uses apt / dnf / yum / zypper.</p></div>`;
  const root = $('#p-root');
  $('#p-filter').value = filter;
  const visible = () => rows.filter((r) => {
    if (filter === 'pending') return r.pending_updates > 0;
    if (filter === 'security') return r.security_updates > 0;
    if (filter === 'reboot') return r.reboot_required;
    if (filter === 'stale') return !r.updates_checked_at || Date.now() - r.updates_checked_at > 3 * 86400000;
    return true;
  });
  const draw = () => {
    const vis = visible();
    $('#p-count').textContent = `${vis.length} of ${rows.length}`;
    $('#p-body').innerHTML = vis.map((r) => `<tr>${can('tech') ? `<td><input type="checkbox" data-pid="${r.id}" ${sel.has(r.id) ? 'checked' : ''}></td>` : ''}
      <td class="nowrap">${statusDot(r)}<a href="#/devices/${r.id}/updates">${esc(r.hostname)}</a></td><td class="small">${esc(r.client_name || '—')}</td><td>${osCell(r)}</td>
      <td class="right">${r.updates_checked_at ? (r.pending_updates || 0) : '—'}</td>
      <td class="right">${r.security_updates ? badge(r.security_updates, 'bad') : (r.updates_checked_at ? '0' : '—')}</td>
      <td>${r.reboot_required ? badge('required', 'warn') : ''}</td>
      <td class="small nowrap">${r.updates_checked_at ? fmtAgo(r.updates_checked_at) : 'never'}</td>
      <td>${r.busy ? badge(r.busy === 'updates.install' ? 'installing' : 'scanning', 'running') : ''}</td></tr>`).join('')
      || '<tr><td colspan="9" class="empty">No devices match</td></tr>';
    for (const b of $$('[data-p]')) b.disabled = !sel.size;
    const all = $('#p-all');
    if (all) all.checked = vis.length > 0 && vis.every((r) => sel.has(r.id));
  };
  const load = async () => { rows = await api('GET', '/api/patching'); draw(); };
  $('#p-filter').addEventListener('change', (e) => { filter = state.patchFilter = e.target.value; draw(); });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'p-reboot') reboot = e.target.checked;
    if (e.target.dataset.pid) { e.target.checked ? sel.add(e.target.dataset.pid) : sel.delete(e.target.dataset.pid); draw(); }
    if (e.target.id === 'p-all') { for (const r of visible()) e.target.checked ? sel.add(r.id) : sel.delete(r.id); draw(); }
  });
  root.addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const install = b.dataset.p === 'install';
    if (install && !await confirmDialog(`Install all pending updates on ${sel.size} device(s)${reboot ? ', rebooting where required' : ''}?`, { okLabel: 'Install' })) return;
    const r = await api('POST', '/api/tasks', { agent_ids: [...sel], task: install ? 'updates.install' : 'updates.scan', args: install ? { ids: 'all', reboot } : {} });
    toast(`${install ? 'Installing' : 'Scanning'} on ${r.created} device(s)`);
    sel.clear();
    await load();
  }));
  await load();
  every(10000, load);
}

async function bulkSoftwareModal(ids) {
  const agents = (await api('GET', '/api/agents')).filter((a) => ids.includes(a.id));
  const hasWin = agents.some((a) => a.platform === 'windows');
  const hasLin = agents.some((a) => a.platform === 'linux');
  const m = openModal(`Install software on ${agents.length} device(s)`, `<form id="bs-form">
    ${hasWin ? '<div class="field"><label>Windows: winget ID</label><input type="text" name="win" placeholder="e.g. Google.Chrome, 7zip.7zip, VideoLAN.VLC"><div class="small muted">Find IDs with "Install software…" on a device, or at winget.run</div></div>' : ''}
    ${hasLin ? '<div class="field"><label>Linux: package name</label><input type="text" name="lin" placeholder="e.g. htop"></div>' : ''}</form>`,
  { foot: '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="bs-form">Install</button>' });
  $('#bs-form', m).addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const jobs = [];
    const win = f.namedItem('win')?.value.trim();
    const lin = f.namedItem('lin')?.value.trim();
    if (win) jobs.push(api('POST', '/api/tasks', { agent_ids: agents.filter((a) => a.platform === 'windows').map((a) => a.id), task: 'software.install', args: { id: win } }));
    if (lin) jobs.push(api('POST', '/api/tasks', { agent_ids: agents.filter((a) => a.platform === 'linux').map((a) => a.id), task: 'software.install', args: { id: lin } }));
    if (!jobs.length) { toast('Enter a package', 'error'); return; }
    const res = await Promise.all(jobs);
    closeModal();
    toast(`Installing on ${res.reduce((n, r) => n + r.created, 0)} device(s)`);
    location.hash = `#/jobs/batch/${res[0].batch_id}`;
  }));
}

// ---------------- global click actions ----------------
const ACTIONS = {
  'close-modal': () => closeModal(),
  'modal-backdrop': (el, e) => { if (e.target === el) closeModal(); },
  'toggle-menu': () => $('#sidebar').classList.toggle('open'),
  logout: async () => { await api('POST', '/api/logout'); state.user = null; renderLogin(); },
  copy: (el) => copyText(el.dataset.text),
  'run-selected': () => openRunModal([...state.selected]),
  'run-on': (el) => openRunModal(el.dataset.ids.split(',')),
  'run-script-pick': (el) => pickDevicesModal('Select devices', (ids) => {
    closeModal();
    api('POST', '/api/jobs', { agent_ids: ids, script_id: Number(el.dataset.id) }).then((r) => {
      toast(`Queued on ${r.created} device(s)${r.skipped.length ? `, skipped ${r.skipped.length} incompatible` : ''}`);
      if (r.created) location.hash = `#/jobs/batch/${r.batch_id}`;
    }).catch((e) => toast(e.message, 'error'));
  }),
  'refresh-inv': async (el) => { await api('POST', `/api/agents/${el.dataset.id}/inventory`); toast('Inventory refresh requested'); },
  'cancel-job': async (el) => { await api('POST', `/api/jobs/${el.dataset.id}/cancel`); toast('Job cancelled'); },
  alert: async (el) => { await api('POST', `/api/alerts/${el.dataset.id}/${el.dataset.op}`); updateAlertBadge(); router(); },
  'uninstall-agent': async (el) => {
    if (!await confirmDialog('Uninstall the agent from this host? It will stop reporting once it processes the request.', { okLabel: 'Uninstall', danger: true })) return;
    await api('DELETE', `/api/agents/${el.dataset.id}?uninstall=1`); toast('Uninstall queued');
  },
  'delete-agent': async (el) => {
    if (!await confirmDialog('Remove this device and all its history? If the agent is still installed it will be locked out (use Uninstall first).', { okLabel: 'Remove', danger: true })) return;
    await api('DELETE', `/api/agents/${el.dataset.id}`); location.hash = '#/devices';
  },
  'new-client': () => newClientModal(),
  'edit-client': () => editClientModal(),
  'delete-client': async (el) => {
    if (!await confirmDialog('Delete this client? Its devices stay but become unassigned, and its enrollment tokens are revoked.', { okLabel: 'Delete', danger: true })) return;
    await api('DELETE', `/api/clients/${el.dataset.id}`); location.hash = '#/clients';
  },
  'new-token': async (el) => { await api('POST', `/api/clients/${el.dataset.id}/tokens`, { expires_days: Number($('#tok-days').value) }); router(); },
  'revoke-token': async (el) => {
    if (!await confirmDialog('Revoke this enrollment token? Already-installed agents are not affected.', { okLabel: 'Revoke', danger: true })) return;
    await api('DELETE', `/api/tokens/${el.dataset.token}`); router();
  },
  'delete-script': async (el) => {
    if (!await confirmDialog('Delete this script? Scheduled tasks using it are deleted too.', { okLabel: 'Delete', danger: true })) return;
    await api('DELETE', `/api/scripts/${el.dataset.id}`); location.hash = '#/scripts';
  },
  'edit-schedule': (el) => editScheduleModal(el.dataset.id),
  'run-schedule': async (el) => { await api('POST', `/api/schedules/${el.dataset.id}/run`); toast('Will run within 30 seconds'); },
  'delete-schedule': async (el) => {
    if (!await confirmDialog('Delete this scheduled task?', { okLabel: 'Delete', danger: true })) return;
    await api('DELETE', `/api/schedules/${el.dataset.id}`); router();
  },
  'test-webhook': async () => { await api('POST', '/api/settings/test-webhook'); toast('Test notification sent'); },
  'reset-pw': (el) => {
    const m = openModal(`Reset password for ${el.dataset.name}`, '<form id="rp-form"><div class="field"><label>New password (min 10 chars)</label><input name="password" type="password" minlength="10" autocomplete="new-password" required></div></form>',
      { foot: '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="rp-form">Reset</button>' });
    $('#rp-form', m).addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      await api('PUT', `/api/users/${el.dataset.id}`, { password: new FormData(e.target).get('password') });
      closeModal(); toast('Password reset; their sessions were signed out');
    }));
  },
  'delete-user': async (el) => {
    if (!await confirmDialog(`Delete user ${el.dataset.name}?`, { okLabel: 'Delete', danger: true })) return;
    await api('DELETE', `/api/users/${el.dataset.id}`); router();
  },
};

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-action]');
  if (act && ACTIONS[act.dataset.action]) {
    if (act.tagName === 'A' || act.tagName === 'BUTTON') e.preventDefault();
    guard(ACTIONS[act.dataset.action])(act, e);
    return;
  }
  if (e.target.closest('[data-stop], a, button, input, select, textarea, label')) return;
  const job = e.target.closest('[data-job]');
  if (job) { guard(openJobModal)(job.dataset.job); return; }
  const row = e.target.closest('[data-href]');
  if (row) location.hash = row.dataset.href;
});

// Dashboard tiles can preset a device filter
document.addEventListener('click', (e) => {
  const p = e.target.closest('[data-preset]');
  if (p) state.devFilter.status = p.dataset.preset;
}, true);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('hashchange', router);

// ---------------- boot ----------------
(async () => {
  try {
    state.user = await api('GET', '/api/me');
    renderShell();
    router();
  } catch { if (!state.user) renderLogin(); }
})();
