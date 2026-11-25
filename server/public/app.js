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
  macos: '<svg viewBox="0 0 24 24" fill="#a3a3a3"><path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9s-2-.9-3.3-.9c-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.8-1.1-2.8-4.2zM14 5.3c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5z"/></svg>',
  linux: '<svg viewBox="0 0 24 24" fill="#f59e0b"><path d="M12 2c-2.2 0-3.5 1.9-3.5 4.3 0 1.5.3 2.4-.6 3.9C6.8 12 5 14.4 5 17c0 .8.2 1.4.5 1.9-.6.4-1 .9-1 1.5C4.5 21.5 6 22 8 22c1.3 0 2.3-.4 3-.9.3.1.6.1 1 .1s.7 0 1-.1c.7.5 1.7.9 3 .9 2 0 3.5-.5 3.5-1.6 0-.6-.4-1.1-1-1.5.3-.5.5-1.1.5-1.9 0-2.6-1.8-5-2.9-6.8-.9-1.5-.6-2.4-.6-3.9C15.5 3.9 14.2 2 12 2z"/></svg>',
};
const osCell = (a) => `<span class="os">${ICONS[a.platform] || ''}${esc(a.os_name || a.platform || '')}</span>`;
const statusDot = (a) => `<span class="dot ${a.maintenance ? 'maint' : a.online ? 'on' : 'off'}" title="${a.maintenance ? 'Maintenance mode' : a.online ? 'Online' : 'Offline'}"></span>`;
const badge = (s, cls = s) => `<span class="badge ${esc(cls)}">${esc(s)}</span>`;
const SHELLS_FOR = { windows: ['powershell', 'cmd', 'python'], linux: ['bash', 'sh', 'python'], macos: ['bash', 'zsh', 'sh', 'python'] };
// shell -> platforms that can run it
const SHELL_OS = { powershell: ['windows'], cmd: ['windows'], bash: ['linux', 'macos'], sh: ['linux', 'macos'], zsh: ['macos', 'linux'], python: ['windows', 'linux', 'macos'] };
const shellIcon = (sh) => { const p = SHELL_OS[sh] || []; return p.length === 1 ? ICONS[p[0]] : p.includes('windows') ? '' : ICONS.linux + ICONS.macos; };
const PLATFORM_NAME = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

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
// network speeds are shown in bits per second, like link speeds
function fmtBits(bps) {
  if (bps == null || isNaN(bps)) return '—';
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let i = 0; bps = Number(bps);
  while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
  return `${bps.toFixed(bps >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
const niceCeil = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 5, 10].map((m) => m * p).find((n) => n >= v); };

/** rows: [{ts, key: value}]; percent series by default, or { rate: true } for bytes/second (auto-scaled). */
function chart(rows, series, { hours = 24, rate = false } = {}) {
  const W = 600, H = 160;
  const end = Date.now(), start = end - hours * 3600000;
  const x = (ts) => ((ts - start) / (end - start)) * W;
  let top = 100, scaleNote = '';
  if (rate) {
    const peak = Math.max(0, ...rows.flatMap((r) => series.map(([k]) => r[k] || 0)));
    top = niceCeil(Math.max(peak * 8, 8000)) / 8; // chart in bits, scale to a round number of bits/s
    scaleNote = `<span class="muted">scale 0 – ${fmtBits(top * 8)} · peak ${fmtBits(peak * 8)}</span>`;
  }
  const y = (v) => H - (Math.max(0, Math.min(top, v)) / top) * H;
  const grid = [0.25, 0.5, 0.75].map((g) => `<line class="grid-line" x1="0" x2="${W}" y1="${y(g * top)}" y2="${y(g * top)}"/>`).join('');
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
  const legend = series.map(([, label, color]) => `<span><i style="background:${color}"></i>${label}</span>`).join('') + scaleNote;
  const t = (ms) => new Date(ms).toLocaleString([], hours > 48 ? { month: 'short', day: 'numeric' }
    : hours < 1 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  return `<div class="legend">${legend}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}</svg>
    <div class="chart-axis"><span>${t(start)}</span><span>${t((start + end) / 2)}</span><span>now</span></div>`;
}

// ---------------- layout & routing ----------------
const NAV = [
  ['#/', 'Dashboard'], ['#/devices', 'Devices'], ['#/clients', 'Clients'], ['#/alerts', 'Alerts', 'alerts'], ['#/messages', 'Messages', 'chat'],
  null, ['#/patching', 'Patching'], ['#/policies', 'Policies'], ['#/scripts', 'Scripts'], ['#/automation', 'Automation'], ['#/jobs', 'Job history'], ['#/software', 'Software'], ['#/network', 'Network'],
  null, ['#/settings', 'Settings'],
];

function renderShell() {
  $('#root').innerHTML = `<div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><img src="/favicon.svg" alt="">HostPilot RMM</div>
      <nav class="nav">${NAV.map((n) => (n ? `<a href="${n[0]}" data-nav="${n[0]}">${n[1]}${n[2] ? `<span class="badge hidden" id="nav-${n[2]}"></span>` : ''}</a>` : '<div class="sep"></div>')).join('')}
        ${window.HostPilotApp ? '<a href="#" data-action="app-settings">Phone app settings</a>' : ''}</nav>
    </aside>
    <div class="sidebar-scrim" data-action="toggle-menu"></div>
    <div class="main">
      <header class="topbar">
        <div class="row"><button class="btn sm menu-toggle" data-action="toggle-menu">☰</button><strong id="page-title"></strong></div>
        <div class="user"><span>${esc(state.user.username)} · ${esc(state.user.role)}</span><button class="btn sm" data-action="logout">Sign out</button></div>
      </header>
      <main id="view"></main>
    </div></div>`;
  updateAlertBadge();
  setInterval(guard(updateAlertBadge), 30000);
  // inside the Android app: let it register this phone for alert / chat notifications
  try { window.HostPilotApp?.signedIn(state.user.username); } catch { /* older app */ }
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
  [/^#\/network$/, pageNetworks, 'Network'],
  [/^#\/messages$/, pageMessages, 'Messages'],
  [/^#\/policies$/, pagePolicies, 'Policies'],
  [/^#\/policies\/(new)$/, pagePolicyEdit, 'New policy'],
  [/^#\/policies\/(\d+)\/edit$/, pagePolicyEdit, 'Edit policy'],
  [/^#\/policies\/(\d+)$/, pagePolicy, 'Policy'],
  [/^#\/network\/(\d+)(?:\/(\w+))?$/, pageNetwork, 'Network'],
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
  state.pageAbort?.abort();
  state.pageAbort = new AbortController();
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
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const devLink = (a, right) => `<tr class="clickable" data-href="#/devices/${a.id}"><td>${statusDot(a)}<strong>${esc(a.hostname)}</strong>${a.client_name ? `<div class="small muted">${esc(a.client_name)}</div>` : ''}</td><td class="right">${right}</td></tr>`;
const listCard = (title, rows, empty, link = '') => `<div class="card flush"><h2 class="row" style="justify-content:space-between">${title}${link}</h2>
  <div class="table-wrap"><table class="dash"><tbody>${rows || `<tr><td class="empty">${empty}</td></tr>`}</tbody></table></div></div>`;

// ---- dashboard widgets: donuts, bar charts and count legends ----
const WC = { red: '#e53b2f', amber: '#f4b400', blue: '#1f7fd1', gray: '#7b8591', green: '#21a446', pink: '#e2338f', teal: '#14b3a4', purple: '#8b5cf6', olive: '#b5b52a', orange: '#f07c1b' };
// parts: [[value, color, label, href?]]
function wLegend(parts) {
  return `<div class="wlegend">${parts.map(([v, c, l, href]) => `<${href ? `a href="${href}"` : 'div'} class="wl-row"><span class="wl-n" style="background:${c}">${v}</span><span class="wl-l">${esc(l)}</span></${href ? 'a' : 'div'}>`).join('')}</div>`;
}
function wDonut(parts, center) {
  const total = parts.reduce((s, [v]) => s + v, 0);
  const R = 42, C = 2 * Math.PI * R;
  let off = 0;
  const segs = total ? parts.filter(([v]) => v > 0).map(([v, c, l]) => {
    const len = (v / total) * C;
    const seg = `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${c}" stroke-width="18" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"><title>${esc(l)}: ${v}</title></circle>`;
    off += len;
    return seg;
  }).join('') : '';
  return `<svg class="wdonut" viewBox="0 0 120 120"><circle r="${R}" cx="60" cy="60" fill="none" stroke="var(--panel-2)" stroke-width="18"/>${segs}
    <text x="60" y="60" text-anchor="middle" dominant-baseline="central" class="wdonut-n">${center}</text></svg>`;
}
function wBars(parts) {
  const max = Math.max(...parts.map(([v]) => v), 0);
  const step = max <= 4 ? 1 : max <= 10 ? 2 : niceCeil(max / 5);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const W = 170, H = 120, L = 22, B = 14, bw = (W - L) / parts.length;
  const y = (v) => H - B - (v / top) * (H - B - 6);
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  return `<svg class="wbars" viewBox="0 0 ${W} ${H}">${ticks.map((v) => `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="wgrid-line"/><text x="${L - 4}" y="${y(v)}" class="wtick" text-anchor="end" dominant-baseline="central">${v}</text>`).join('')}
    ${parts.map(([v, c, l], i) => `<rect x="${L + i * bw + bw * 0.18}" y="${y(v)}" width="${bw * 0.64}" height="${Math.max(0, H - B - y(v))}" fill="${c}"><title>${esc(l)}: ${v}</title></rect>`).join('')}</svg>`;
}
function wHBars(parts) {
  const max = Math.max(...parts.map(([v]) => v), 1);
  return `<div class="whbars">${parts.map(([v, c, l]) => `<div class="whb-row"><div class="whb-track"><span style="width:${(v / max) * 100}%;background:${c}"></span></div></div>`).join('')}</div>`;
}
const widget = (title, sub, body, { span = 1, href = '' } = {}) => `<section class="wcard${span > 1 ? ` span-${span}` : ''}">
  <div class="wtitle">${href ? `<a href="${href}">${esc(title)}</a>` : esc(title)}</div><div class="wsub">${esc(sub)}</div><div class="wbody">${body}</div></section>`;
const wKpi = (title, value, icon, cls, href) => `<a class="wcard wkpi ${cls}" href="${href}"><div class="wtitle">${esc(title)}</div><div class="wkpi-v">${icon}<span>${value}</span></div></a>`;
const ICON_DEV = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2 22 12 12 22 2 12z" fill="#e53b2f"/><path d="M12 7v6M12 16.5v.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';

// Values the widgets share, computed once per refresh.
function dashCtx(d) {
  const t = d.totals, r = d.resources, p = d.patching, n = d.network, h = d.health, sv = d.servers, ws = d.workstations;
  const osColors = [WC.blue, WC.pink, WC.teal, WC.amber, WC.purple, WC.gray];
  const shortOs = (s) => s.replace(/^Microsoft /, '').replace(/ (Standard|Datacenter|Enterprise|Professional)\b.*$/, '').replace(/ GNU\/Linux/, '').replace(/ LTS$/, '');
  const osParts = d.os.slice(0, 5).map((o, i) => [o.n, osColors[i], shortOs(o.name)]);
  const otherOs = d.os.slice(5).reduce((s, o) => s + o.n, 0);
  if (otherOs) osParts.push([otherOs, WC.gray, 'Other']);
  return {
    d, t, r, p, n, h, sv, ws, osParts,
    failed: (d.jobs_24h.failed || 0) + (d.jobs_24h.timeout || 0) + (d.jobs_24h.lost || 0),
    trendRows: d.trend.map((x) => ({ ts: x.ts + 1800000, cpu: x.cpu, mem: x.mem, devices: pct(x.devices, t.devices), net: x.net })),
    reboot: [[sv.uptime.d30, WC.blue, 'Servers > 30 days'], [sv.uptime.d60, WC.pink, 'Servers > 60 days'], [sv.uptime.d90, WC.teal, 'Servers > 90 days'],
      [ws.uptime.d30, WC.purple, 'Workstations > 30 days'], [ws.uptime.d60, WC.olive, 'Workstations > 60 days'], [ws.uptime.d90, WC.orange, 'Workstations > 90 days']],
    patchParts: [[p.devices_security, WC.red, 'Security'], [p.devices_pending - p.devices_security, WC.amber, 'Pending'],
      [p.reboot_required, WC.blue, 'Reboot'], [p.never_scanned, WC.gray, 'Not scanned'], [p.up_to_date, WC.green, 'Up to date']],
    resParts: [[r.high_cpu, WC.red, 'High CPU'], [r.high_mem, WC.amber, 'High memory'], [r.low_disk, WC.orange, 'Low disk'],
      [Math.max(0, t.online - Math.max(r.high_cpu, r.high_mem, 0)), WC.green, 'Normal']],
    agentParts: [[d.agents.outdated, WC.amber, 'Updating'], [d.agents.offline, WC.gray, 'Offline'], [d.agents.current, WC.green, 'Up to date']],
    jobParts: [[d.jobs_24h.failed || 0, WC.red, 'Failed'], [d.jobs_24h.timeout || 0, WC.amber, 'Timed out'],
      [(d.jobs_24h.running || 0) + (d.jobs_24h.queued || 0), WC.blue, 'Running'], [d.jobs_24h.lost || 0, WC.gray, 'Lost'], [d.jobs_24h.success || 0, WC.green, 'Succeeded']],
    clientParts: [[d.clients.filter((c) => c.alerts).length, WC.red, 'With alerts'], [d.clients.filter((c) => !c.alerts && c.patches).length, WC.amber, 'Need patches'],
      [d.clients.filter((c) => !c.alerts && !c.patches && c.devices).length, WC.green, 'Healthy'], [d.clients.filter((c) => !c.devices).length, WC.gray, 'No devices']],
  };
}

const groupDonut = (g) => `<div class="wsplit">${wDonut([[g.problems.failing, WC.red, 'Failing'], [g.problems.warning, WC.amber, 'Warning'], [g.problems.healthy, WC.gray, 'Healthy']], g.total)}
  ${wLegend([[g.problems.failing, WC.red, 'Failing', '#/alerts'], [g.problems.warning, WC.amber, 'Warning', '#/alerts'], [g.problems.healthy, WC.gray, 'Healthy']])}</div>`;
const groupBars = (g) => `<div class="wsplit">${wBars([[g.status.offline, WC.red, 'Offline'], [g.status.reboot, WC.blue, 'Reboot'], [g.status.patches, WC.gray, 'Patches pending'], [g.status.online, WC.green, 'Online']])}
  ${wLegend([[g.status.offline, WC.red, 'Offline'], [g.status.reboot, WC.blue, 'Reboot'], [g.status.patches, WC.gray, 'Patches'], [g.status.online, WC.green, 'Online']])}</div>`;
const warnKpi = (title, v, href) => wKpi(title, v, v ? ICON_WARN : '', v ? 'bad' : 'ok', href);
const COLLECTING = '<div class="muted">Collecting data… (hourly points appear as devices report)</div>';

/**
 * Every dashboard panel. span = default width in columns (1-4); group = section in the "Add widget" list;
 * hidden: true = available but not on the default dashboard.
 */
const DASH_WIDGETS = [
  { id: 'kpi-devices', group: 'Numbers', title: 'Devices', span: 1, render: (c) => wKpi('Devices', c.t.devices, ICON_DEV, '', '#/devices') },
  { id: 'kpi-problems', group: 'Numbers', title: 'Problem devices', span: 1, render: (c) => warnKpi('Problem devices', c.d.problem_devices, '#/devices') },
  { id: 'kpi-alerts', group: 'Numbers', title: 'Active alerts', span: 1, render: (c) => warnKpi('Active alerts', c.t.open_alerts, '#/alerts') },
  { id: 'kpi-security', group: 'Numbers', title: 'Security patches missing', span: 1, render: (c) => warnKpi('Security patches missing', c.p.devices_security, '#/patching') },
  { id: 'kpi-online', group: 'Numbers', title: 'Online devices', span: 1, hidden: true, render: (c) => wKpi('Online devices', c.t.online, ICON_DEV, 'ok', '#/devices') },
  { id: 'kpi-offline', group: 'Numbers', title: 'Offline devices', span: 1, hidden: true, render: (c) => warnKpi('Offline devices', c.t.offline, '#/devices') },
  { id: 'kpi-patches', group: 'Numbers', title: 'Pending patches', span: 1, hidden: true, render: (c) => warnKpi('Pending patches', c.p.pending, '#/patching') },
  { id: 'kpi-reboot', group: 'Numbers', title: 'Reboot required', span: 1, hidden: true, render: (c) => warnKpi('Reboot required', c.p.reboot_required, '#/patching') },
  { id: 'kpi-failed-jobs', group: 'Numbers', title: 'Failed jobs (24 h)', span: 1, hidden: true, render: (c) => warnKpi('Failed jobs (24 h)', c.failed, '#/jobs') },
  { id: 'kpi-clients', group: 'Numbers', title: 'Clients', span: 1, hidden: true, render: (c) => wKpi('Clients', c.t.clients, '', '', '#/clients') },
  { id: 'kpi-software', group: 'Numbers', title: 'Software titles', span: 1, hidden: true, render: (c) => wKpi('Software titles', c.t.software_titles, '', '', '#/software') },

  { id: 'problem-servers', group: 'Charts', title: 'Problem servers', span: 1, render: (c) => widget('Problem servers', 'With one or more active alerts', groupDonut(c.sv)) },
  { id: 'server-status', group: 'Charts', title: 'Server status', span: 1, render: (c) => widget('Server status', 'All clients', groupBars(c.sv)) },
  { id: 'problem-workstations', group: 'Charts', title: 'Problem workstations', span: 1, render: (c) => widget('Problem workstations', 'With one or more active alerts', groupDonut(c.ws)) },
  { id: 'workstation-status', group: 'Charts', title: 'Workstation status', span: 1, render: (c) => widget('Workstation status', 'All clients', groupBars(c.ws)) },
  { id: 'device-types', group: 'Charts', title: 'Device types', span: 1, render: (c) => {
    const parts = (c.d.device_classes || []).map((x) => [x.n, CLASS_INFO[x.class][1], `${CLASS_INFO[x.class][0]}s`.replace('Virtual machines', 'Virtual machines').replace(/machines?s$/, 'machines')]);
    return widget('Device types', 'Desktops, laptops, servers and VMs', `<div class="wsplit">${wDonut(parts, c.t.devices)}${wLegend(parts)}</div>`);
  } },
  { id: 'compliance', group: 'Charts', title: 'Policy compliance', span: 1, render: (c) => {
    const s = c.d.compliance || { policies: 0 };
    const parts = [[s.compliant || 0, WC.green, 'Compliant', '#/policies'], [s.non_compliant || 0, WC.red, 'Not compliant', '#/policies'], [s.not_checked || 0, WC.gray, 'Not checked', '#/policies']];
    return widget('Policy compliance', `${plural(s.policies, 'enabled policy').replace('policys', 'policies')} · device checks`, s.policies
      ? `<div class="wsplit">${wDonut(parts, `${(s.compliant + s.non_compliant) ? Math.round((s.compliant / (s.compliant + s.non_compliant)) * 100) : 0}%`)}${wLegend(parts)}</div>`
      : '<div class="small muted">No policies yet. <a href="#/policies">Create one →</a></div>', { href: '#/policies' });
  } },
  { id: 'devices-os', group: 'Charts', title: 'Devices by OS', span: 1, render: (c) => widget('Devices by OS', 'All clients', `<div class="wsplit">${wDonut(c.osParts, c.t.devices)}${wLegend(c.osParts.map(([v, col, l]) => [v, col, l.length > 26 ? `${l.slice(0, 25)}…` : l]))}</div>`) },
  { id: 'reboot-time', group: 'Charts', title: 'Last reboot time', span: 2, render: (c) => widget('Last reboot time', 'Online devices', `<div class="wsplit wide">${wHBars(c.reboot)}${wLegend(c.reboot)}</div>`) },
  { id: 'patch-status', group: 'Charts', title: 'Patch status', span: 1, render: (c) => widget('Patch status', 'All devices', `<div class="wsplit">${wBars(c.patchParts)}${wLegend(c.patchParts.map(([v, col, l]) => [v, col, l, '#/patching']))}</div>`, { href: '#/patching' }) },
  { id: 'resource-alerts', group: 'Charts', title: 'Resource alerts', span: 1, render: (c) => widget('Resource alerts', `Over ${c.r.thresholds.cpu}% CPU / ${c.r.thresholds.mem}% memory / ${c.r.thresholds.disk}% disk`, `<div class="wsplit">${wBars(c.resParts)}${wLegend(c.resParts)}</div>`) },
  { id: 'agent-status', group: 'Charts', title: 'Agent status', span: 1, render: (c) => widget('Agent status', 'HostPilot agents', `<div class="wsplit">${wBars(c.agentParts)}${wLegend(c.agentParts)}</div>`) },
  { id: 'jobs-24h', group: 'Charts', title: 'Jobs (24 h)', span: 1, render: (c) => widget('Jobs (24 h)', 'Scripts and tasks', `<div class="wsplit">${wBars(c.jobParts)}${wLegend(c.jobParts.map(([v, col, l]) => [v, col, l, '#/jobs']))}</div>`, { href: '#/jobs' }) },
  { id: 'network-now', group: 'Charts', title: 'Network right now', span: 1, render: (c) => widget('Network right now', `${plural(c.n.reporting, 'device')} reporting`, `<div class="wnet"><div><div class="small muted">Download</div><div class="big" style="color:${WC.teal}">${fmtBits(c.n.total_rx * 8)}</div></div>
      <div><div class="small muted">Upload</div><div class="big" style="color:${WC.pink}">${fmtBits(c.n.total_tx * 8)}</div></div></div>`) },
  { id: 'avg-utilisation', group: 'Charts', title: 'Average utilisation', span: 1, render: (c) => widget('Average utilisation', 'Online devices', `<div class="dash-meter"><span class="small">CPU</span>${meter(c.r.avg_cpu)}</div><div class="dash-meter"><span class="small">Memory</span>${meter(c.r.avg_mem)}</div><div class="dash-meter"><span class="small">Fullest disk</span>${meter(c.r.avg_disk)}</div>`) },
  { id: 'clients-chart', group: 'Charts', title: 'Clients', span: 1, render: (c) => widget('Clients', `${plural(c.t.clients, 'client')}${c.t.unassigned ? ` · ${plural(c.t.unassigned, 'device')} unassigned` : ''}`, `<div class="wsplit">${wDonut(c.clientParts, c.t.clients)}${wLegend(c.clientParts.map(([v, col, l]) => [v, col, l, '#/clients']))}</div>`, { href: '#/clients' }) },
  { id: 'fleet-trend', group: 'Charts', title: 'Fleet trend (24 h)', span: 2, render: (c) => widget('Fleet trend (24 h)', 'Devices reporting, average CPU and memory', c.trendRows.length > 1 ? chart(c.trendRows, [['devices', 'Devices reporting %', 'var(--ok)'], ['cpu', 'Avg CPU', 'var(--c1)'], ['mem', 'Avg memory', 'var(--c2)']], { hours: 24 }) : COLLECTING) },
  { id: 'network-trend', group: 'Charts', title: 'Network traffic (24 h)', span: 2, render: (c) => widget('Network traffic (24 h)', 'Whole fleet, download + upload', c.trendRows.filter((x) => x.net != null).length > 1 ? chart(c.trendRows, [['net', 'Download + upload', 'var(--c4)']], { hours: 24, rate: true }) : COLLECTING) },

  { id: 'network-devices', group: 'Charts', title: 'Discovered network devices', span: 1, render: (c) => {
    const rows = (c.d.net_devices || []).slice().sort((x, y) => y.n - x.n);
    const parts = rows.slice(0, 6).map((r) => [r.n, (NET_TYPE_INFO[r.type] || NET_TYPE_INFO.unknown)[1], (NET_TYPE_INFO[r.type] || NET_TYPE_INFO.unknown)[0], '#/network']);
    const rest = rows.slice(6).reduce((s, r) => s + r.n, 0);
    if (rest) parts.push([rest, WC.gray, 'Other', '#/network']);
    const total = rows.reduce((s, r) => s + r.n, 0);
    return widget('Discovered network devices', `${plural(c.d.networks || 0, 'network')} scanned`, total ? `<div class="wsplit">${wDonut(parts, total)}${wLegend(parts)}</div>`
      : '<div class="muted small">No networks scanned yet. <a href="#/network">Add a network →</a></div>', { href: '#/network' });
  } },
  { id: 'list-alerts', group: 'Lists', title: 'Active alerts', span: 1, render: (c) => listCard('Active alerts', c.d.recent_alerts.map((a) => `<tr class="clickable" data-href="#/devices/${a.agent_id}/alerts"><td>${badge(a.severity, a.severity === 'critical' ? 'bad' : 'warn')}</td><td><strong>${esc(a.hostname)}</strong><div class="small muted">${esc(a.message)}</div></td><td class="right muted small nowrap">${fmtAgo(a.created_at)}</td></tr>`).join(''), 'No active alerts 🎉', '<a href="#/alerts" class="small">All alerts →</a>') },
  { id: 'list-clients', group: 'Lists', title: 'Clients list', span: 1, render: (c) => listCard('Clients', c.d.clients.slice(0, 8).map((x) => `<tr class="clickable" data-href="#/clients/${x.id}"><td><strong>${esc(x.name)}</strong><div class="small muted">${x.online}/${x.devices} online</div></td>
      <td class="right">${x.alerts ? badge(`${x.alerts} alert${x.alerts > 1 ? 's' : ''}`, 'bad') : ''} ${x.patches ? badge(`${x.patches} patches`, 'warn') : ''}${!x.alerts && !x.patches ? badge('healthy', 'ok') : ''}</td></tr>`).join(''), 'No clients yet', '<a href="#/clients" class="small">All clients →</a>') },
  { id: 'list-network', group: 'Lists', title: 'Top network users', span: 1, render: (c) => listCard('Top network users', c.n.top.map((a) => devLink(a, `<span class="small"><span style="color:var(--c4)">↓ ${fmtBits(a.rx * 8)}</span> · <span style="color:var(--c5)">↑ ${fmtBits(a.tx * 8)}</span></span>`)).join(''), 'No network data yet') },
  { id: 'list-cpu', group: 'Lists', title: 'Highest CPU', span: 1, render: (c) => listCard('Highest CPU', c.r.top_cpu.map((a) => devLink(a, `<div style="min-width:130px">${meter(a.value)}</div>`)).join(''), 'No data') },
  { id: 'list-memory', group: 'Lists', title: 'Highest memory', span: 1, render: (c) => listCard('Highest memory', c.r.top_mem.map((a) => devLink(a, `<div style="min-width:130px">${meter(a.value)}</div>`)).join(''), 'No data') },
  { id: 'list-disks', group: 'Lists', title: 'Fullest disks', span: 1, render: (c) => listCard('Fullest disks', c.r.top_disk.map((a) => devLink(a, `<div style="min-width:130px">${meter(a.value)}</div>`)).join(''), 'No data') },
  { id: 'list-offline', group: 'Lists', title: 'Recently offline', span: 1, render: (c) => listCard('Recently offline', c.h.recently_offline.map((a) => devLink(a, `<span class="small muted">${fmtAgo(a.last_seen)}</span>`)).join(''), 'All devices are online 🎉',
      c.h.long_offline_count ? `<span class="small bad-text">${c.h.long_offline_count} offline &gt; 7 days</span>` : '') },
  { id: 'list-uptime', group: 'Lists', title: 'Running longest without reboot', span: 1, render: (c) => listCard('Running longest without reboot', c.h.long_uptime.map((a) => devLink(a, `<span class="small">${fmtDur(Date.now() - a.boot_time)}</span>`)).join(''), 'No device has been up for more than 30 days',
      c.h.long_uptime_count ? `<span class="small muted">${c.h.long_uptime_count} up &gt; 30 days</span>` : '') },
  { id: 'list-patches', group: 'Lists', title: 'Devices needing patches', span: 1, hidden: true, render: (c) => listCard('Devices needing patches', c.p.top.map((a) => devLink(a, `${a.security ? badge(`${a.security} security`, 'bad') + ' ' : ''}${badge(`${a.pending} pending`, 'warn')}${a.reboot ? ' ' + badge('reboot', 'info') : ''}`)).join(''), 'Everything scanned is up to date', '<a href="#/patching" class="small">Patching →</a>') },
  { id: 'list-schedules', group: 'Lists', title: 'Scheduled automation', span: 1, render: (c) => listCard('Scheduled automation', c.d.schedules.map((s) => `<tr class="clickable" data-href="#/automation"><td><strong>${esc(s.name || s.script)}</strong><div class="small muted">${esc(s.script)} · every ${fmtDur(s.interval_minutes * 60000)}</div></td>
      <td class="right small nowrap">${s.next_run <= Date.now() ? 'due now' : `in ${fmtDur(s.next_run - Date.now())}`}</td></tr>`).join(''), 'No scheduled tasks', '<a href="#/automation" class="small">Automation →</a>') },
  { id: 'list-jobs', group: 'Lists', title: 'Recent jobs', span: 1, render: (c) => listCard('Recent jobs', c.d.recent_jobs.map((j) => `<tr class="clickable" data-job="${j.id}"><td>${badge(j.status)}</td><td><strong>${esc(j.name)}</strong><div class="small muted">${esc(j.hostname)} · ${esc(j.created_by)}</div></td><td class="right muted small nowrap">${fmtAgo(j.created_at)}</td></tr>`).join(''), 'No jobs yet', '<a href="#/jobs" class="small">Job history →</a>') },
  { id: 'list-failed-jobs', group: 'Lists', title: 'Failed jobs (24 h)', span: 1, render: (c) => listCard('Failed jobs (24 h)', c.d.failed_jobs.map((j) => `<tr class="clickable" data-job="${j.id}"><td>${badge(j.status)}</td><td><strong>${esc(j.name)}</strong><div class="small muted">${esc(j.hostname)}</div></td><td class="right muted small nowrap">${fmtAgo(j.created_at)}</td></tr>`).join(''), 'No failed jobs 🎉') },
  { id: 'list-activity', group: 'Lists', title: 'Recent activity (admins)', span: 1, render: (c) => (c.d.activity ? listCard('Recent activity', c.d.activity.map((x) => `<tr><td><strong>${esc(x.username)}</strong> <span class="mono small">${esc(x.action)}</span><div class="small muted">${esc(x.detail || '')}</div></td><td class="right muted small nowrap">${fmtAgo(x.ts)}</td></tr>`).join(''), 'No activity yet', '<a href="#/settings" class="small">Audit log →</a>')
      : widget('Recent activity', 'Admins only', '<div class="muted small">The audit log is only shown to admins.</div>')) },
];
const WIDGET_BY_ID = new Map(DASH_WIDGETS.map((w) => [w.id, w]));
const DEFAULT_LAYOUT = () => DASH_WIDGETS.filter((w) => !w.hidden).map((w) => ({ id: w.id, span: w.span }));

async function pageDashboard(view) {
  let layout = null;
  try { layout = (await api('GET', '/api/me/dashboard')).layout; } catch { /* use default */ }
  layout = (layout || DEFAULT_LAYOUT()).filter((w) => WIDGET_BY_ID.has(w.id));
  let editing = false, data = null, saveTimer = null, dragId = null;

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api('PUT', '/api/me/dashboard', { layout }).catch((e) => toast(`Couldn't save the layout: ${e.message}`, 'error')), 400);
  };
  const cell = (w, ctx) => {
    const def = WIDGET_BY_ID.get(w.id);
    let html;
    try { html = def.render(ctx); } catch (e) { html = widget(def.title, 'Error', `<div class="small bad-text">${esc(e.message)}</div>`); }
    const tools = editing ? `<div class="wedit" data-stop>
        <span class="wedit-handle" title="Drag to move">⠿</span>
        <button class="btn sm" data-w="left" title="Move earlier">←</button><button class="btn sm" data-w="right" title="Move later">→</button>
        <select data-w="span" title="Width">${[1, 2, 3, 4].map((s) => `<option value="${s}" ${s === w.span ? 'selected' : ''}>${s === 1 ? '1 column' : `${s} columns`}</option>`).join('')}</select>
        <button class="btn sm danger" data-w="remove" title="Remove from dashboard">✕</button></div>` : '';
    return `<div class="wcell span-${w.span}${def.id.startsWith('kpi-') ? ' kpi' : ''}" data-wid="${w.id}"${editing ? ' draggable="true"' : ''}>${tools}${html}</div>`;
  };

  const render = () => {
    if (!data) return;
    const t = data.totals;
    const hiddenList = DASH_WIDGETS.filter((w) => !layout.some((l) => l.id === w.id));
    const head = `<div class="page-head"><h1>Dashboard</h1><div class="row">
      ${editing ? `<select id="dash-add" style="width:auto"><option value="">+ Add widget…</option>${['Numbers', 'Charts', 'Lists'].map((g) => {
        const items = hiddenList.filter((w) => w.group === g);
        return items.length ? `<optgroup label="${g}">${items.map((w) => `<option value="${w.id}">${esc(w.title)}</option>`).join('')}</optgroup>` : '';
      }).join('')}</select>
        <button class="btn" id="dash-reset">Reset to default</button><button class="btn primary" id="dash-done">Done</button>`
      : `<span class="small muted">Updated ${new Date(data.generated_at).toLocaleTimeString()} · refreshes every 15 s</span><button class="btn" id="dash-edit">Customize</button>`}</div></div>`;
    if (t.devices === 0 && !editing) {
      view.innerHTML = `${head}<div class="card"><h2>Get started</h2>
        <p>1. Create a <a href="#/clients">client</a>. 2. On the client page, download the installer (Setup.exe or .sh) or copy the one-line command. 3. Run it on your Windows or Linux hosts. They appear here within a minute.</p></div>`;
    } else {
      const ctx = dashCtx(data);
      view.innerHTML = `${head}${editing ? '<div class="dash-hint small muted">Drag widgets (or use ← →) to reorder, pick a width, remove with ✕, and add more from “Add widget”. Changes save automatically.</div>' : ''}
        <div class="wgrid${editing ? ' editing' : ''}" id="dash-grid">${layout.map((w) => cell(w, ctx)).join('') || '<div class="card muted">No widgets. Use “Add widget” to put some back.</div>'}</div>`;
    }
    $('#dash-edit')?.addEventListener('click', () => { editing = true; render(); });
    $('#dash-done')?.addEventListener('click', () => { editing = false; save(); render(); toast('Dashboard saved'); });
    $('#dash-reset')?.addEventListener('click', guard(async () => {
      if (!await confirmDialog('Reset the dashboard to the default widgets and order?', { okLabel: 'Reset' })) return;
      layout = DEFAULT_LAYOUT();
      await api('PUT', '/api/me/dashboard', { layout: null });
      render();
    }));
    $('#dash-add')?.addEventListener('change', (e) => {
      const def = WIDGET_BY_ID.get(e.target.value);
      if (!def) return;
      layout.push({ id: def.id, span: def.span });
      save(); render();
      $(`[data-wid="${def.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  // edit controls (delegated, so they survive re-renders)
  const idx = (el) => layout.findIndex((w) => w.id === el.closest('[data-wid]')?.dataset.wid);
  view.addEventListener('click', (e) => {
    if (!editing || !e.target.closest('.wcell')) return;
    e.stopPropagation(); // widget links and rows are inactive while editing
    const b = e.target.closest('[data-w]');
    if (b?.dataset.w === 'span') return; // let the width dropdown open
    e.preventDefault();
    if (!b) return;
    const i = idx(b);
    if (i < 0) return;
    if (b.dataset.w === 'remove') layout.splice(i, 1);
    if (b.dataset.w === 'left' && i > 0) [layout[i - 1], layout[i]] = [layout[i], layout[i - 1]];
    if (b.dataset.w === 'right' && i < layout.length - 1) [layout[i + 1], layout[i]] = [layout[i], layout[i + 1]];
    if (b.dataset.w !== 'span') { save(); render(); }
  }, { capture: true, signal: state.pageAbort.signal });
  view.addEventListener('change', (e) => {
    const s = e.target.closest('[data-w="span"]');
    if (!s) return;
    const i = idx(s);
    if (i >= 0) { layout[i].span = Number(s.value); save(); render(); }
  }, { capture: false, signal: state.pageAbort.signal });
  // drag and drop (mouse); phones use the ← → buttons
  view.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('.wcell');
    if (!editing || !c) return;
    dragId = c.dataset.wid;
    c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  }, { capture: false, signal: state.pageAbort.signal });
  view.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const c = e.target.closest('.wcell');
    if (!c || c.dataset.wid === dragId) return;
    e.preventDefault();
    const r = c.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    view.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    c.classList.add(after ? 'drop-after' : 'drop-before');
  }, { capture: false, signal: state.pageAbort.signal });
  view.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const c = e.target.closest('.wcell');
    const from = layout.findIndex((w) => w.id === dragId);
    if (c && from >= 0 && c.dataset.wid !== dragId) {
      const [moved] = layout.splice(from, 1);
      let to = layout.findIndex((w) => w.id === c.dataset.wid);
      if (c.classList.contains('drop-after')) to += 1;
      layout.splice(to, 0, moved);
      save();
    }
    dragId = null;
    render();
  }, { capture: false, signal: state.pageAbort.signal });
  view.addEventListener('dragend', () => { if (dragId) { dragId = null; render(); } }, { signal: state.pageAbort.signal });

  const load = async () => {
    if (editing && data) return; // don't redraw under the user's hands
    data = await api('GET', '/api/dashboard');
    render();
  };
  await load();
  every(15000, load);
}

// ---------------- network discovery & topology ----------------
const NET_TYPE_INFO = {
  router: ['Router', WC.blue], firewall: ['Firewall', WC.red], switch: ['Switch', WC.teal], access_point: ['Access point', WC.purple],
  server: ['Server', '#2563eb'], workstation: ['Workstation', WC.pink], printer: ['Printer', WC.orange], camera: ['Camera', '#0ea5e9'],
  nas: ['NAS / storage', WC.olive], voip: ['VoIP phone', '#14b8a6'], phone: ['Phone / tablet', '#a855f7'], media: ['Media / TV', '#f43f5e'],
  iot: ['IoT / smart home', WC.amber], unknown: ['Unknown', WC.gray],
};
const NET_ORDER = Object.keys(NET_TYPE_INFO);
const ic = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const NET_ICONS = {
  internet: ic('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1 0 9.5z"/>'),
  router: ic('<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M11 16.5h.01M8 13l-2-6M16 13l2-6"/>'),
  firewall: ic('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9.3h18M3 14.6h18M9 4v5.3M15 9.3v5.3M9 14.6V20"/>'),
  switch: ic('<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11h1M9 11h1M12 11h1M15 11h1M18 11h0M6 14h12"/>'),
  access_point: ic('<path d="M5 12.5a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="18.5" r="1"/><path d="M2 9.3a14.5 14.5 0 0 1 20 0"/>'),
  server: ic('<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01M8 17.5h.01"/>'),
  workstation: ic('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
  printer: ic('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
  camera: ic('<path d="M3 8h13l5-3v14l-5-3H3z"/><circle cx="9.5" cy="12" r="2.5"/>'),
  nas: ic('<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6M9 10h6M12 17h.01"/>'),
  voip: ic('<path d="M5 3h4l2 5-3 2a11 11 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2"/>'),
  phone: ic('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
  media: ic('<rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/><path d="m10 9 5 2.5-5 2.5z"/>'),
  iot: ic('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3"/>'),
  unknown: ic('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>'),
};
const netName = (d) => d.name || d.hostname || d.ip;
const PORT_NAMES = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 53: 'DNS', 80: 'HTTP', 135: 'RPC', 139: 'NetBIOS', 443: 'HTTPS', 445: 'SMB', 515: 'LPD', 548: 'AFP', 554: 'RTSP', 631: 'IPP',
  1883: 'MQTT', 3389: 'RDP', 5000: 'UPnP/NAS', 5001: 'NAS (HTTPS)', 5060: 'SIP', 5900: 'VNC', 6668: 'Tuya', 7547: 'TR-069', 8000: 'HTTP alt', 8008: 'Cast', 8009: 'Cast',
  8080: 'HTTP alt', 8443: 'HTTPS alt', 8883: 'MQTT (TLS)', 9100: 'Printing', 37777: 'Dahua', 62078: 'iOS sync' };
const netTypeBadge = (t) => { const [l, c] = NET_TYPE_INFO[t] || NET_TYPE_INFO.unknown; return `<span class="ntype" style="--c:${c}">${NET_ICONS[t] || NET_ICONS.unknown}${l}</span>`; };

async function pageNetworks(view) {
  const draw = async () => {
    const nets = await api('GET', '/api/networks');
    view.innerHTML = `<div class="page-head"><h1>Network discovery</h1>${can('tech') ? '<button class="btn primary" id="net-add">+ Add network</button>' : ''}</div>
      <p class="muted small" style="margin-top:-8px">A HostPilot device on each network acts as the probe: it scans the subnet, identifies what it finds (routers, firewalls, switches, access points, computers, printers, cameras, IoT…) and maps the topology.</p>
      ${nets.length ? `<div class="grid cols-3">${nets.map((n) => `<a class="card netcard" href="#/network/${n.id}">
        <div class="row" style="justify-content:space-between"><strong>${esc(n.name)}</strong>${n.scanning ? badge('scanning…', 'info') : n.scan_error ? badge('scan failed', 'bad') : ''}</div>
        <div class="small muted">${esc(n.subnet)}${n.client_name ? ` · ${esc(n.client_name)}` : ''} · probe: ${esc(n.probe?.hostname || 'none')}</div>
        <div class="netcard-n"><span class="big">${n.total}</span> devices <span class="small muted">(${n.online} online)</span></div>
        <div class="netcard-types">${NET_ORDER.filter((t) => n.by_type[t]).map((t) => `<span title="${NET_TYPE_INFO[t][0]}" style="color:${NET_TYPE_INFO[t][1]}">${NET_ICONS[t]}<b>${n.by_type[t]}</b></span>`).join('') || '<span class="small muted">Not scanned yet</span>'}</div>
        <div class="small muted">${n.last_scan_at ? `Scanned ${fmtAgo(n.last_scan_at)}` : 'Never scanned'}${n.scan_hours ? ` · rescans every ${n.scan_hours} h` : ' · manual scans'}</div></a>`).join('')}</div>`
      : `<div class="card"><h2>No networks yet</h2><p>Click <strong>Add network</strong>, pick a device with the HostPilot agent on that network, and confirm its subnet (for example 192.168.1.0/24). The first scan takes about a minute.</p></div>`}`;
    $('#net-add')?.addEventListener('click', () => networkModal(null));
  };
  await draw();
  every(15000, draw);
}

async function networkModal(n) {
  const [agents, clients] = await Promise.all([api('GET', '/api/agents'), api('GET', '/api/clients')]);
  agents.sort((x, y) => (y.online - x.online) || x.hostname.localeCompare(y.hostname));
  const m = openModal(n ? `Edit ${n.name}` : 'Add network', `<form id="nw-form">
    <div class="field"><label>Name</label><input type="text" name="name" required maxlength="100" value="${esc(n?.name || '')}" placeholder="e.g. Head office LAN"></div>
    <div class="field"><label>Probe device (runs the scan)</label><select name="probe_agent_id" required>${agents.map((a) => `<option value="${a.id}" ${a.id === n?.probe_agent_id ? 'selected' : ''}>${esc(a.hostname)}${a.client_name ? ` (${esc(a.client_name)})` : ''}${a.online ? '' : ' (offline)'}</option>`).join('')}</select></div>
    <div class="field"><label>Subnet</label><input type="text" name="subnet" required value="${esc(n?.subnet || '')}" placeholder="192.168.1.0/24"><div class="small muted" id="nw-sugg"></div></div>
    <div class="form-grid">
      <div class="field"><label>Client (optional)</label><select name="client_id"><option value="">—</option>${clients.map((c) => `<option value="${c.id}" ${c.id === n?.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Rescan</label><select name="scan_hours">${[[0, 'Manually only'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Daily'], [168, 'Weekly']].map(([v, l]) => `<option value="${v}" ${(n?.scan_hours ?? 24) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>SNMP community (optional)</label><input type="text" name="community" value="${n ? '' : 'public'}" placeholder="${n?.community_set ? 'unchanged (leave blank to keep)' : 'public'}" autocomplete="off">
      <div class="small muted">Read-only SNMP lets switches, routers and firewalls report their model. Leave as "public" if you haven't changed it.</div></div>
    ${n ? '' : '<label class="check"><input type="checkbox" name="scan_now" checked> Scan now</label>'}
    <p class="small muted">Only private address ranges can be scanned (up to a /20). Some security tools flag network scans; let your client know.</p></form>`,
  { foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="nw-form">${n ? 'Save' : 'Add and scan'}</button>` });
  const f = $('#nw-form', m);
  const suggest = async () => {
    const id = f.elements.probe_agent_id.value;
    if (!id) return;
    const subs = await api('GET', `/api/agents/${id}/subnets`).catch(() => []);
    $('#nw-sugg', m).innerHTML = subs.length ? `This device is on: ${subs.map((s) => `<a href="#" data-sub="${s}">${s}</a>`).join(', ')}` : '';
    if (!f.elements.subnet.value && subs[0]) f.elements.subnet.value = subs[0];
  };
  f.elements.probe_agent_id.addEventListener('change', suggest);
  $('#nw-sugg', m).addEventListener('click', (e) => { const a = e.target.closest('[data-sub]'); if (a) { e.preventDefault(); f.elements.subnet.value = a.dataset.sub; } });
  suggest();
  f.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    v.scan_now = !!f.elements.scan_now?.checked;
    if (n && !v.community) delete v.community;
    const r = n ? await api('PUT', `/api/networks/${n.id}`, v) : await api('POST', '/api/networks', v);
    closeModal();
    toast(n ? 'Network saved' : 'Network added. The first scan takes about a minute.');
    if (location.hash === `#/network/${r.id}`) router(); else location.hash = `#/network/${r.id}`;
  }));
}

async function pageNetwork(view, id, tab = 'map') {
  let n = null, filter = '', q = '';
  const draw = async () => {
    n = await api('GET', `/api/networks/${id}`);
    const ds = n.devices;
    const head = `<div class="page-head"><div><h1>${esc(n.name)}</h1>
        <div class="small muted" style="margin-top:4px">${esc(n.subnet)} · gateway ${esc(n.gateway || '?')} · probe ${n.probe ? `<a href="#/devices/${n.probe.id}">${esc(n.probe.hostname)}</a>` : 'none'}
        · ${n.scanning ? badge('scanning…', 'info') : n.last_scan_at ? `scanned ${fmtAgo(n.last_scan_at)}` : 'never scanned'}</div></div>
      <div class="row">${can('tech') ? `<button class="btn primary" id="nw-scan" ${n.scanning ? 'disabled' : ''}>${n.scanning ? 'Scanning…' : 'Scan now'}</button>
        <button class="btn" id="nw-edit">Edit</button><button class="btn danger" id="nw-del">Delete</button>` : ''}</div></div>
      ${n.scan_error ? `<div class="card" style="border-color:var(--bad);margin-bottom:12px"><strong>Last scan failed:</strong> <span class="small">${esc(cleanErr(n.scan_error))}</span></div>` : ''}
      <div class="netsum">${NET_ORDER.filter((t) => n.by_type[t]).map((t) => `<a href="#" data-ftype="${t}" class="${filter === t ? 'on' : ''}">${netTypeBadge(t)}<b>${n.by_type[t]}</b></a>`).join('')}</div>
      <nav class="tabs"><a href="#/network/${id}/map" class="${tab === 'map' ? 'active' : ''}">Topology map</a><a href="#/network/${id}/devices" class="${tab === 'devices' ? 'active' : ''}">Devices (${ds.length})</a></nav>`;
    if (!ds.length) {
      view.innerHTML = `${head}<div class="card muted">${n.scanning ? 'Scanning the network… devices appear here in about a minute.' : 'No devices yet. Click Scan now.'}</div>`;
    } else if (tab === 'devices') {
      const list = ds.filter((d) => (!filter || d.type === filter) && (!q || [netName(d), d.ip, d.mac, d.vendor, d.hostname].join(' ').toLowerCase().includes(q)));
      view.innerHTML = `${head}<div class="toolbar"><input type="search" id="nd-q" placeholder="Search name, IP, MAC, vendor…" value="${esc(q)}">
          <select id="nd-type"><option value="">All types</option>${NET_ORDER.filter((t) => n.by_type[t]).map((t) => `<option value="${t}" ${filter === t ? 'selected' : ''}>${NET_TYPE_INFO[t][0]}</option>`).join('')}</select></div>
        <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Status</th><th>Device</th><th>Type</th><th>IP</th><th>MAC / vendor</th><th>Open ports</th><th>Last seen</th></tr></thead><tbody>
        ${list.map((d) => `<tr class="clickable" data-nd="${d.id}"><td>${d.online ? badge('online', 'ok') : badge('offline')}</td>
          <td><strong>${esc(netName(d))}</strong>${d.agent_id ? ` ${badge('HostPilot', 'info')}` : ''}${d.info.self ? ` ${badge('probe', 'info')}` : ''}</td>
          <td>${netTypeBadge(d.type)}</td><td class="mono small">${esc(d.ip)}</td>
          <td class="small"><span class="mono">${esc(d.mac || '—')}</span><div class="muted">${esc(d.vendor || '')}</div></td>
          <td class="small">${esc((d.ports || '').split(',').filter(Boolean).map((p) => PORT_NAMES[p] ? `${p} ${PORT_NAMES[p]}` : p).join(', '))}</td>
          <td class="small nowrap">${d.online ? 'now' : fmtAgo(d.last_seen)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No matching devices</td></tr>'}
        </tbody></table></div></div>`;
      $('#nd-q').addEventListener('input', (e) => { q = e.target.value.toLowerCase(); const pos = e.target.selectionStart; draw().then(() => { const i = $('#nd-q'); i.focus(); i.setSelectionRange(pos, pos); }); });
      $('#nd-type').addEventListener('change', (e) => { filter = e.target.value; draw(); });
    } else {
      view.innerHTML = `${head}<div class="card topo-card"><div class="topo" id="topo">${topoHtml(n, filter)}</div>
        <p class="small muted" style="margin:10px 0 0">Links between devices are inferred from device types (the scan sees which devices exist, not which switch port each one uses). Faded devices weren't found in the last scan. Click a device for details.</p></div>`;
      requestAnimationFrame(() => drawTopoLines($('#topo')));
    }
    view.querySelectorAll('[data-ftype]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); filter = filter === a.dataset.ftype ? '' : a.dataset.ftype; draw(); }));
    $('#nw-scan')?.addEventListener('click', guard(async () => { await api('POST', `/api/networks/${id}/scan`); toast('Scan started. It usually takes about a minute.'); draw(); }));
    $('#nw-edit')?.addEventListener('click', guard(() => networkModal(n)));
    $('#nw-del')?.addEventListener('click', guard(async () => {
      if (!await confirmDialog(`Delete the network "${n.name}" and its ${n.total} discovered devices? Nothing is changed on the devices themselves.`, { okLabel: 'Delete', danger: true })) return;
      await api('DELETE', `/api/networks/${id}`); location.hash = '#/network';
    }));
  };
  view.addEventListener('click', (e) => {
    const el = e.target.closest('[data-nd]');
    if (el && n) { e.preventDefault(); e.stopPropagation(); netDeviceModal(n.devices.find((d) => String(d.id) === el.dataset.nd), draw); }
  }, { capture: true, signal: state.pageAbort.signal });
  window.addEventListener('resize', () => { const t = $('#topo'); if (t) drawTopoLines(t); }, { signal: state.pageAbort.signal });
  await draw();
  every(15000, () => (n?.scanning ? draw() : null));
}

// Topology: internet -> ISP -> gateway -> infrastructure (switches, APs, firewalls, other routers) -> grouped endpoints.
function topoHtml(n, filter) {
  const ds = n.devices.filter((d) => !filter || d.type === filter || ['router', 'firewall', 'switch', 'access_point'].includes(d.type));
  const node = (id, type, title, sub, extra = '', offline = false, nd = null) => `<div class="tnode${offline ? ' off' : ''}" data-tid="${id}"${nd ? ` data-nd="${nd}"` : ''} style="--c:${(NET_TYPE_INFO[type] || ['', WC.blue])[1]}">
    <div class="tnode-ic">${NET_ICONS[type] || NET_ICONS.unknown}</div><div class="tnode-t">${esc(title)}</div><div class="tnode-s">${esc(sub)}</div>${extra}</div>`;
  const gw = ds.find((d) => d.ip === n.gateway);
  const publicHop = (n.hops || []).find((h) => !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h.ip));
  const infra = ds.filter((d) => d !== gw && ['firewall', 'router', 'switch', 'access_point'].includes(d.type))
    .sort((x, y) => ['firewall', 'router', 'switch', 'access_point'].indexOf(x.type) - ['firewall', 'router', 'switch', 'access_point'].indexOf(y.type));
  const ends = ds.filter((d) => d !== gw && !infra.includes(d));
  const groups = NET_ORDER.filter((t) => !['router', 'firewall', 'switch', 'access_point'].includes(t)).map((t) => [t, ends.filter((d) => d.type === t)]).filter(([, l]) => l.length);
  const sw = infra.find((d) => d.type === 'switch');
  const gwId = gw ? `d${gw.id}` : 'gw';
  const edges = [['internet', publicHop ? 'isp' : gwId]];
  if (publicHop) edges.push(['isp', gwId]);
  for (const d of infra) edges.push([d.type === 'access_point' && sw ? `d${sw.id}` : gwId, `d${d.id}`]);
  // every endpoint group hangs off one LAN bar under the main switch (or the gateway when there is no switch)
  if (groups.length) edges.push([sw ? `d${sw.id}` : gwId, 'bus']);
  // a node's title: its name, or its type when all we know is the IP (the IP is shown underneath anyway)
  const title = (d) => (d.name || d.hostname || (NET_TYPE_INFO[d.type] || NET_TYPE_INFO.unknown)[0]);
  const chipName = (d) => d.name || d.hostname || (d.vendor && !/^Private/.test(d.vendor) ? d.vendor : d.ip);
  const chip = (d) => `<div class="tchip${d.online ? '' : ' off'}" data-nd="${d.id}" title="${esc(`${netName(d)} · ${d.ip}${d.vendor ? ` · ${d.vendor}` : ''}`)}"><span class="dot ${d.online ? 'on' : 'off'}"></span><span class="tchip-n">${esc(chipName(d))}</span><span class="tchip-ip">.${esc(d.ip.split('.').pop())}</span></div>`;
  return `<svg class="topo-lines" data-edges='${JSON.stringify(edges)}'></svg>
    <div class="ttier">${node('internet', 'internet', 'Internet', n.probe ? 'via public IP' : '')}</div>
    ${publicHop ? `<div class="ttier">${node('isp', 'router', 'ISP', publicHop.ip)}</div>` : ''}
    <div class="ttier">${gw ? node(gwId, gw.type, title(gw), `${gw.ip} · gateway`, '', !gw.online, gw.id) : node('gw', 'router', 'Gateway', n.gateway || 'unknown')}</div>
    ${infra.length ? `<div class="ttier">${infra.map((d) => node(`d${d.id}`, d.type, title(d), d.ip, '', !d.online, d.id)).join('')}</div>` : ''}
    ${groups.length ? `<div class="tbus" data-tid="bus"><span>LAN · ${esc(n.subnet)}</span></div>` : ''}
    <div class="ttier groups">${groups.map(([t, list]) => `<div class="tgroup" data-tid="g${t}" style="--c:${NET_TYPE_INFO[t][1]}">
      <div class="tgroup-h">${NET_ICONS[t]}${NET_TYPE_INFO[t][0]} <b>${list.length}</b></div>
      <div class="tgroup-b">${list.sort((x, y) => (y.online - x.online) || netName(x).localeCompare(netName(y))).map(chip).join('')}</div></div>`).join('')}</div>`;
}

function drawTopoLines(root) {
  const svg = root.querySelector('.topo-lines');
  if (!svg) return;
  const box = root.getBoundingClientRect();
  svg.setAttribute('width', box.width); svg.setAttribute('height', root.scrollHeight);
  const pos = (id) => { const el = root.querySelector(`[data-tid="${id}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left - box.left + r.width / 2, top: r.top - box.top, bottom: r.bottom - box.top }; };
  svg.innerHTML = JSON.parse(svg.dataset.edges).map(([a, b]) => {
    const p = pos(a), q = pos(b);
    if (!p || !q) return '';
    const my = (p.bottom + q.top) / 2;
    return `<path d="M${p.x},${p.bottom} C${p.x},${my} ${q.x},${my} ${q.x},${q.top}"/>`;
  }).join('');
}

function netDeviceModal(d, onSaved) {
  if (!d) return;
  const kv = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const i = d.info || {};
  const ports = (d.ports || '').split(',').filter(Boolean);
  const web = ports.includes('443') ? `https://${d.ip}` : ports.includes('80') ? `http://${d.ip}` : ports.includes('8443') ? `https://${d.ip}:8443` : ports.includes('8080') ? `http://${d.ip}:8080` : '';
  const m = openModal(netName(d), `<dl class="kv">
      ${kv('Type', `${netTypeBadge(d.type)} <span class="small muted">${esc(d.reason || '')}</span>`)}
      ${kv('Status', d.online ? badge('online', 'ok') : `${badge('offline')} <span class="small muted">last seen ${fmtAgo(d.last_seen)}</span>`)}
      ${kv('IP address', `<span class="mono">${esc(d.ip)}</span>${web ? ` · <a href="${esc(web)}" target="_blank" rel="noopener noreferrer">open web interface ↗</a>` : ''}`)}
      ${kv('MAC address', `<span class="mono">${esc(d.mac)}</span>`)}${kv('Vendor', esc(d.vendor))}
      ${kv('Hostname', esc(d.hostname))}${kv('NetBIOS name', esc(i.netbios))}
      ${kv('Open ports', ports.map((p) => `${p}${PORT_NAMES[p] ? ` <span class="muted">${PORT_NAMES[p]}</span>` : ''}`).join(', '))}
      ${kv('SNMP', esc([i.snmp_name, i.snmp_descr].filter(Boolean).join(' — ')))}
      ${kv('Web server', esc([i.http_server, i.http_title && `“${i.http_title}”`].filter(Boolean).join(' ')))}
      ${kv('UPnP', esc([i.ssdp_name, i.ssdp_mfr, i.ssdp_model, i.ssdp_type && i.ssdp_type.replace(/^urn:schemas-upnp-org:device:/, '')].filter(Boolean).join(' · ')))}
      ${kv('Managed', d.agent_id ? `<a href="#/devices/${d.agent_id}">Open in HostPilot →</a>` : '')}
      ${kv('First seen', fmtDate(d.first_seen))}</dl>
    ${can('tech') ? `<form id="nd-form" style="margin-top:14px"><div class="form-grid">
      <div class="field"><label>Name</label><input type="text" name="name" maxlength="100" value="${esc(d.name || '')}" placeholder="${esc(d.hostname || d.ip)}"></div>
      <div class="field"><label>Type</label><select name="type"><option value="auto">Automatic (${esc((NET_TYPE_INFO[d.type] || [''])[0])})</option>
        ${NET_ORDER.map((t) => `<option value="${t}" ${d.type_manual && d.type === t ? 'selected' : ''}>${NET_TYPE_INFO[t][0]}</option>`).join('')}</select></div></div></form>` : ''}`,
  { wide: true, foot: can('tech') ? '<button class="btn danger" id="nd-forget">Forget device</button><span class="grow"></span><button class="btn" data-action="close-modal">Close</button><button class="btn primary" form="nd-form">Save</button>' : '<button class="btn" data-action="close-modal">Close</button>' });
  $('#nd-form', m)?.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    await api('PUT', `/api/net-devices/${d.id}`, v);
    closeModal(); toast('Saved'); onSaved();
  }));
  $('#nd-forget', m)?.addEventListener('click', guard(async () => {
    await api('DELETE', `/api/net-devices/${d.id}`);
    closeModal(); toast('Device removed (it reappears if found again)'); onSaved();
  }));
}

// ---------------- device class, per-core CPU ----------------
const CLASS_INFO = { desktop: ['Desktop', WC.pink], laptop: ['Laptop', WC.purple], server: ['Server', WC.blue], vm: ['Virtual machine', WC.teal] };
const classBadge = (c) => { const [l, col] = CLASS_INFO[c] || CLASS_INFO.desktop; return `<span class="badge" style="color:${col};border-color:${col}55">${l}</span>`; };
function coreGrid(loads) {
  const color = (v) => (v >= 90 ? 'var(--bad)' : v >= 70 ? 'var(--warn)' : 'var(--ok)');
  return `<div class="cores">${loads.map((v, i) => `<div class="core" title="CPU ${i}: ${v}%"><div class="core-bar"><span style="height:${Math.max(2, v)}%;background:${color(v)}"></span></div><div class="core-n">${v}</div></div>`).join('')}</div>`;
}

// ---------------- task manager: processes & services ----------------
async function devTaskManager(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">The task manager requires the tech role.</div>'; return; }
  let view = 'proc', procs = [], svcs = [], sort = 'cpu', q = '', svcFilter = '';
  el.innerHTML = `<div class="toolbar"><div class="seg"><button class="btn sm" data-v="proc">Processes</button><button class="btn sm" data-v="svc">Services</button></div>
      <input type="search" id="tm-q" placeholder="Filter…"><select id="tm-sf" class="hidden"><option value="">All services</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="auto-stopped">Automatic but stopped</option></select>
      <span class="grow"></span><span class="small muted" id="tm-status"></span><button class="btn sm" id="tm-refresh">Refresh</button></div>
    <div class="card flush"><div class="table-wrap" id="tm-body"><div class="empty muted" style="padding:28px;text-align:center">Loading…</div></div></div>
    <p class="small muted">Runs in the background as ${isWin(a) ? 'SYSTEM' : 'root'}; the signed-in user isn't interrupted. CPU is measured over one second.</p>`;
  const status = (t) => { $('#tm-status').textContent = t; };
  const draw = () => {
    el.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('primary', b.dataset.v === view));
    $('#tm-sf').classList.toggle('hidden', view !== 'svc');
    if (view === 'proc') {
      const list = procs.filter((p) => !q || `${p.name} ${p.pid} ${p.user} ${p.path} ${p.desc}`.toLowerCase().includes(q))
        .sort((x, y) => (sort === 'name' ? x.name.localeCompare(y.name) : sort === 'mem' ? y.mem - x.mem : sort === 'pid' ? x.pid - y.pid : y.cpu - x.cpu || y.mem - x.mem));
      const th = (k, l, right) => `<th class="${right ? 'right' : ''}"><a href="#" data-sort="${k}">${l}${sort === k ? ' ▾' : ''}</a></th>`;
      $('#tm-body').innerHTML = `<table><thead><tr>${th('name', 'Process')}${th('pid', 'PID', 1)}${th('cpu', 'CPU', 1)}${th('mem', 'Memory', 1)}<th>User</th><th>Started</th><th></th></tr></thead><tbody>
        ${list.slice(0, 500).map((p) => `<tr data-pid="${p.pid}"><td><strong>${esc(p.name)}</strong>${p.desc && p.desc !== p.name ? `<div class="small muted">${esc(p.desc.slice(0, 120))}</div>` : ''}${p.path ? `<div class="small muted mono" title="${esc(p.path)}">${esc(p.path.length > 70 ? '…' + p.path.slice(-69) : p.path)}</div>` : ''}</td>
          <td class="right mono small">${p.pid}</td><td class="right nowrap"><span style="color:${p.cpu >= 50 ? 'var(--bad)' : p.cpu >= 10 ? 'var(--warn)' : 'inherit'}">${p.cpu.toFixed(1)}%</span></td>
          <td class="right nowrap">${fmtBytes(p.mem)}</td><td class="small">${esc(p.user || '')}</td><td class="small nowrap">${p.start ? fmtAgo(p.start) : ''}</td>
          <td class="right nowrap"><button class="btn sm danger" data-tm="kill">End</button> <button class="btn sm" data-tm="tree" title="End the process and everything it started">End tree</button></td></tr>`).join('')
          || '<tr><td colspan="7" class="empty">No processes</td></tr>'}</tbody></table>`;
      status(`${procs.length} processes · ${procs.reduce((s, p) => s + p.cpu, 0).toFixed(0)}% CPU · ${fmtBytes(procs.reduce((s, p) => s + p.mem, 0))}`);
    } else {
      const list = svcs.filter((s) => (!q || `${s.name} ${s.display} ${s.desc}`.toLowerCase().includes(q))
        && (!svcFilter || (svcFilter === 'auto-stopped' ? s.start.startsWith('auto') && s.state !== 'running' : s.state === svcFilter)))
        .sort((x, y) => (x.display || x.name).localeCompare(y.display || y.name));
      $('#tm-body').innerHTML = `<table><thead><tr><th>Service</th><th>Status</th><th>Startup</th><th>Account</th><th></th></tr></thead><tbody>
        ${list.map((s) => `<tr data-svc="${esc(s.name)}"><td><strong>${esc(s.display || s.name)}</strong><div class="small muted mono">${esc(s.name)}</div></td>
          <td>${s.state === 'running' ? badge('running', 'ok') : s.state === 'failed' ? badge('failed', 'bad') : badge(s.state)}</td>
          <td class="small">${esc(s.start)}</td><td class="small">${esc(s.account || '')}</td>
          <td class="right nowrap">${s.state === 'running' ? '<button class="btn sm" data-tm="restart">Restart</button> <button class="btn sm danger" data-tm="stop">Stop</button>' : '<button class="btn sm primary" data-tm="start">Start</button>'}
            <select data-tm="startup" style="width:auto;display:inline-block"><option value="">Startup…</option><option value="auto">Automatic</option><option value="manual">Manual</option><option value="disabled">Disabled</option></select></td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">No services</td></tr>'}</tbody></table>`;
      status(`${svcs.filter((s) => s.state === 'running').length} running of ${svcs.length}`);
    }
  };
  const load = async () => {
    status('Loading…');
    try {
      if (view === 'proc') {
        const j = await deviceTask(a.id, 'proc.list');
        procs = parseTsv(j.stdout, 'T').map(([pid, name, cpu, mem, user, path, start, desc]) => ({ pid: Number(pid), name, cpu: Number(cpu) || 0, mem: Number(mem) || 0, user, path, start: Number(start) * 1000 || 0, desc }));
      } else {
        const j = await deviceTask(a.id, 'svc.list');
        svcs = parseTsv(j.stdout, 'S').map(([name, display, state, start, account, pid, desc]) => ({ name, display, state, start, account, pid, desc }));
      }
      draw();
    } catch (err) { status(err.message); }
  };
  el.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', guard(async () => { view = b.dataset.v; draw(); await load(); })));
  $('#tm-q').addEventListener('input', (e) => { q = e.target.value.toLowerCase(); draw(); });
  $('#tm-sf').addEventListener('change', (e) => { svcFilter = e.target.value; draw(); });
  $('#tm-refresh').addEventListener('click', guard(load));
  $('#tm-body').addEventListener('click', guard(async (e) => {
    const s = e.target.closest('[data-sort]');
    if (s) { e.preventDefault(); sort = s.dataset.sort; draw(); return; }
    const b = e.target.closest('button[data-tm]');
    if (!b) return;
    const tr = b.closest('tr');
    if (tr.dataset.pid) {
      const p = procs.find((x) => x.pid === Number(tr.dataset.pid));
      if (!await confirmDialog(`End ${p.name} (PID ${p.pid})${b.dataset.tm === 'tree' ? ' and all the processes it started' : ''}? Unsaved work in it will be lost.`, { okLabel: 'End process', danger: true })) return;
      const j = await deviceTask(a.id, 'proc.kill', { pid: p.pid, tree: b.dataset.tm === 'tree' });
      toast(j.stdout.trim()); await load();
    } else {
      b.disabled = true;
      const j = await deviceTask(a.id, 'svc.control', { name: tr.dataset.svc, action: b.dataset.tm });
      toast(j.stdout.trim()); await load();
    }
  }));
  $('#tm-body').addEventListener('change', guard(async (e) => {
    const sel = e.target.closest('select[data-tm="startup"]');
    if (!sel || !sel.value) return;
    const j = await deviceTask(a.id, 'svc.control', { name: sel.closest('tr').dataset.svc, action: sel.value });
    toast(j.stdout.trim()); await load();
  }));
  await load();
}

// ---------------- registry editor (Windows) ----------------
const REG_TYPES = [['String', 'REG_SZ'], ['ExpandString', 'REG_EXPAND_SZ'], ['MultiString', 'REG_MULTI_SZ'], ['DWord', 'REG_DWORD'], ['QWord', 'REG_QWORD'], ['Binary', 'REG_BINARY']];
const regTypeName = (t) => (REG_TYPES.find(([k]) => k === t) || [t, t])[1];
async function devRegistry(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">The registry editor requires the tech role.</div>'; return; }
  if (!state.reg) state.reg = new Map();
  let path = state.reg.get(a.id) || '';
  let keys = [], values = [];
  el.innerHTML = `<div class="toolbar"><button class="btn sm" id="rg-up" title="Parent key">↑</button>
      <input type="text" id="rg-path" class="mono" placeholder="HKLM\\SOFTWARE\\…" style="flex:1;min-width:200px">
      <button class="btn sm" id="rg-go">Go</button><button class="btn sm" id="rg-refresh">Refresh</button>
      <button class="btn sm" id="rg-newkey">New key</button><button class="btn sm primary" id="rg-newval">New value</button></div>
    <div class="small muted" id="rg-status" style="margin-bottom:6px"></div>
    <div class="grid regsplit"><div class="card flush"><div class="table-wrap"><table><thead><tr><th>Keys</th><th></th></tr></thead><tbody id="rg-keys"></tbody></table></div></div>
      <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Data</th><th></th></tr></thead><tbody id="rg-vals"></tbody></table></div></div></div>
    <p class="small muted">Edits apply immediately as SYSTEM. HKCU is per user: open HKU and pick the user's SID. Careful: wrong registry changes can break Windows.</p>`;
  const parent = (p) => (p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : '');
  const draw = () => {
    $('#rg-path').value = path;
    $('#rg-newkey').disabled = !path; $('#rg-newval').disabled = !path;
    $('#rg-keys').innerHTML = keys.map(([n, c]) => `<tr><td><a href="#" data-key="${esc(n)}">📁 ${esc(n)}</a></td><td class="right nowrap">${path ? `<button class="btn sm danger" data-delkey="${esc(n)}">Delete</button>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="2" class="empty">No subkeys</td></tr>';
    const show = (v) => { const d = v.data; if (v.type === 'DWord' || v.type === 'QWord') return `${d} <span class="muted">(0x${BigInt(d || 0).toString(16)})</span>`; return esc(d.length > 200 ? d.slice(0, 200) + '…' : d).replace(/\n/g, '<br>'); };
    $('#rg-vals').innerHTML = !path ? '<tr><td colspan="4" class="empty">Pick a hive on the left</td></tr>' : values.map((v, i) => `<tr data-i="${i}"><td><strong>${esc(v.name || '(Default)')}</strong></td><td class="small nowrap">${regTypeName(v.type)}</td>
        <td class="small mono">${show(v)}</td><td class="right nowrap"><button class="btn sm" data-rv="edit">Edit</button> <button class="btn sm danger" data-rv="del">Delete</button></td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">No values</td></tr>';
  };
  const load = async () => {
    state.reg.set(a.id, path);
    $('#rg-status').textContent = 'Loading…';
    try {
      const j = await deviceTask(a.id, 'reg.list', { path });
      keys = parseTsv(j.stdout, 'K');
      values = parseTsv(j.stdout, 'V').map(([name, type, b]) => ({ name, type, data: new TextDecoder().decode(Uint8Array.from(atob(b || ''), (c) => c.charCodeAt(0))) }));
      $('#rg-status').textContent = path ? `${keys.length} subkeys · ${values.length} values` : 'Registry hives';
    } catch (err) { $('#rg-status').textContent = err.message; keys = []; values = []; }
    draw();
  };
  const go = (p) => { path = p.replace(/\//g, '\\').replace(/\\+$/, ''); return load(); };
  $('#rg-up').addEventListener('click', guard(() => go(parent(path))));
  $('#rg-go').addEventListener('click', guard(() => go($('#rg-path').value.trim())));
  $('#rg-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') guard(() => go(e.target.value.trim()))(); });
  $('#rg-refresh').addEventListener('click', guard(load));
  $('#rg-keys').addEventListener('click', guard(async (e) => {
    const k = e.target.closest('[data-key]');
    if (k) { e.preventDefault(); return go(path ? `${path}\\${k.dataset.key}` : k.dataset.key); }
    const d = e.target.closest('[data-delkey]');
    if (d && await confirmDialog(`Delete the key ${path}\\${d.dataset.delkey} and everything under it? This cannot be undone.`, { okLabel: 'Delete key', danger: true })) {
      const j = await deviceTask(a.id, 'reg.delete', { path: `${path}\\${d.dataset.delkey}`, what: 'key' }); toast(j.stdout.trim()); await load();
    }
  }));
  const valueModal = (v) => {
    const m = openModal(v ? `Edit ${v.name || '(Default)'}` : 'New registry value', `<form id="rv-form">
      <div class="field"><label>Name</label><input type="text" name="name" value="${esc(v?.name || '')}" ${v ? 'readonly' : ''} placeholder="(leave empty for the default value)"></div>
      <div class="field"><label>Type</label><select name="type" ${v ? 'disabled' : ''}>${REG_TYPES.map(([k, l]) => `<option value="${k}" ${(v?.type || 'String') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Data</label><textarea name="data" rows="4" class="mono">${esc(v?.data || '')}</textarea>
        <div class="small muted">DWORD/QWORD: decimal or 0x hex. Multi-string: one per line. Binary: hex bytes (e.g. 01 a0 ff).</div></div></form>`,
    { foot: '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="rv-form">Save</button>' });
    $('#rv-form', m).addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const j = await deviceTask(a.id, 'reg.set', { path, name: f.name.value, type: v?.type || f.type.value, data: f.data.value });
      closeModal(); toast(j.stdout.trim()); await load();
    }));
  };
  $('#rg-vals').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-rv]');
    if (!b) return;
    const v = values[Number(b.closest('tr').dataset.i)];
    if (b.dataset.rv === 'edit') valueModal(v);
    else if (await confirmDialog(`Delete the value "${v.name || '(Default)'}"?`, { okLabel: 'Delete', danger: true })) {
      const j = await deviceTask(a.id, 'reg.delete', { path, name: v.name, what: 'value' }); toast(j.stdout.trim()); await load();
    }
  }));
  $('#rg-newval').addEventListener('click', () => valueModal(null));
  $('#rg-newkey').addEventListener('click', guard(async () => {
    const name = await promptDialog('New key', 'Key name');
    if (!name) return;
    const j = await deviceTask(a.id, 'reg.newkey', { path, name }); toast(j.stdout.trim()); await load();
  }));
  await load();
}

// ---------------- compliance (policies on one device) ----------------
const RESULT_BADGE = { pass: ['Compliant', 'ok'], fixed: ['Fixed', 'info'], fail: ['Not compliant', 'bad'], error: ['Error', 'warn'], na: ['N/A', ''] };
const resultBadge = (s) => { const [l, c] = RESULT_BADGE[s] || [s || 'not checked', '']; return badge(l, c); };
async function devCompliance(el, a) {
  const [pols, catalog] = await Promise.all([api('GET', `/api/agents/${a.id}/compliance`), api('GET', '/api/policy-rules')]);
  const ruleTitle = (r) => (r.type === 'custom_script' ? r.params.label : catalog.find((c) => c.id === r.type)?.title || r.type) + (r.params?.name && r.type.startsWith('service_') ? `: ${r.params.name}` : '');
  el.innerHTML = pols.length ? pols.map((p) => {
    const res = new Map(p.results.map((r) => [r.rule_key, r]));
    const at = Math.max(0, ...p.results.map((r) => r.checked_at));
    return `<div class="card" style="margin-bottom:14px"><div class="row" style="justify-content:space-between;margin-bottom:8px">
        <div><strong>${esc(p.name)}</strong> ${p.enforce ? badge('enforced', 'info') : badge('report only')}${p.enabled ? '' : ` ${badge('disabled', 'warn')}`}
          <div class="small muted">${at ? `Checked ${fmtAgo(at)}` : 'Not checked yet'}</div></div>
        ${can('tech') ? `<button class="btn sm" data-run="${p.id}">Check now</button>` : ''}</div>
      <table class="dash"><tbody>${p.rules.map((r) => { const x = res.get(r.key); return `<tr><td>${esc(ruleTitle(r))}</td><td class="small muted">${esc(x?.detail || '')}</td><td class="right">${x ? resultBadge(x.status) : badge('not checked')}</td></tr>`; }).join('')}
      ${res.get('_run') ? `<tr><td colspan="3" class="small bad-text">${esc(res.get('_run').detail)}</td></tr>` : ''}</tbody></table></div>`;
  }).join('') : `<div class="card">No policies apply to this device. ${can('admin') ? '<a href="#/policies">Create a policy →</a>' : ''}</div>`;
  el.addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-run]');
    if (!b) return;
    b.disabled = true;
    const r = await api('POST', `/api/policies/${b.dataset.run}/run`, { agent_id: a.id });
    toast(r.created ? 'Policy check queued. Results appear here when it finishes.' : 'A check is already queued for this device');
    if (r.jobs?.[0]) { await pollJob(r.jobs[0].id); router(); }
  }));
}

// ---------------- chat with the signed-in user ----------------
async function devChat(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">Chat requires the tech role.</div>'; return; }
  let lastId = 0, msgs = [], alive = true;
  el.innerHTML = `<div class="card chatcard"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">Chat with ${esc(a.logged_user || 'the signed-in user')}</h3>
      <span class="small muted" id="ch-status"></span></div>
    <div class="chatlog" id="ch-log"><div class="muted small">Loading…</div></div>
    <form id="ch-form" class="chatform"><textarea name="body" rows="2" placeholder="Write a message… (Enter to send, Shift+Enter for a new line)" maxlength="4000"></textarea><button class="btn primary">Send</button></form>
    <p class="small muted" style="margin:8px 0 0">The message pops up on the device through the HostPilot taskbar/tray icon, and the user can reply. Users can also start a chat from the icon's menu. Needs the icon (Settings → Taskbar / tray icon)${a.platform === 'linux' ? ', which runs on Linux machines with a desktop (GNOME, KDE, Xfce, Cinnamon, MATE…) and python3-gi' : ''}.</p></div>`;
  const draw = () => {
    const log = $('#ch-log');
    if (!log) { alive = false; return; }
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.innerHTML = msgs.map((m) => `<div class="msg ${m.direction}"><div class="msg-b">${esc(m.body).replace(/\n/g, '<br>')}</div>
      <div class="msg-m">${m.direction === 'tech' ? esc(m.author) : esc(m.author || 'User')} · ${new Date(m.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}${m.direction === 'tech' ? (m.read_at ? ' · delivered' : ' · waiting for the device') : ''}</div></div>`).join('')
      || '<div class="muted small">No messages yet. Say hello!</div>';
    if (stick) log.scrollTop = log.scrollHeight;
  };
  const merge = (list) => { for (const m of list) { const i = msgs.findIndex((x) => x.id === m.id); if (i >= 0) msgs[i] = m; else msgs.push(m); lastId = Math.max(lastId, m.id); } };
  const first = await api('GET', `/api/agents/${a.id}/chat`);
  merge(first.messages);
  draw(); $('#ch-log').scrollTop = 1e9;
  $('#ch-status').textContent = a.online ? 'Device online' : 'Device offline: messages are delivered when it reconnects';
  (async () => { // long-poll for replies and delivery receipts
    while (alive && $('#ch-log')) {
      try {
        const r = await api('GET', `/api/agents/${a.id}/chat?after=${lastId}&wait=25`);
        merge(r.messages);
        // refresh delivery state of our own recent messages
        const pending = msgs.filter((m) => m.direction === 'tech' && !m.read_at);
        if (pending.length) { const all2 = await api('GET', `/api/agents/${a.id}/chat`); merge(all2.messages); }
        draw();
      } catch { await new Promise((r) => setTimeout(r, 5000)); }
    }
  })();
  const form = $('#ch-form');
  form.body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const body = form.body.value.trim();
    if (!body) return;
    const m = await api('POST', `/api/agents/${a.id}/chat`, { body });
    form.body.value = '';
    merge([m]); draw(); $('#ch-log').scrollTop = 1e9;
  }));
  form.body.focus();
}

async function pageMessages(view) {
  const draw = async () => {
    const list = await api('GET', '/api/chat/conversations');
    view.innerHTML = `<div class="page-head"><h1>Messages</h1></div>
      <p class="small muted" style="margin-top:-8px">Chats with signed-in users through the HostPilot taskbar/tray icon (Windows and Linux desktops). Open a device's Chat tab to start one.</p>
      <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Device</th><th>Last message</th><th>When</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr class="clickable" data-href="#/devices/${c.agent_id}/chat"><td><strong>${esc(c.hostname)}</strong><div class="small muted">${esc(c.logged_user || '')}</div></td>
        <td class="small">${c.last_dir === 'tech' ? '<span class="muted">You: </span>' : ''}${esc((c.last_body || '').slice(0, 120))}</td><td class="small nowrap">${fmtAgo(c.last_at)}</td>
        <td class="right">${c.unread ? badge(`${c.unread} new`, 'bad') : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No conversations yet</td></tr>'}</tbody></table></div></div>`;
  };
  await draw();
  every(10000, draw);
}

// ---------------- policies (configuration baselines) ----------------
const TARGET_CLASSES = [['desktop', 'Desktops'], ['laptop', 'Laptops'], ['server', 'Servers'], ['vm', 'Virtual machines']];
function targetSummary(t, clients) {
  if (t.agents?.length) return `${plural(t.agents.length, 'selected device')}`;
  const parts = [t.platform === 'any' ? 'All platforms' : t.platform === 'windows' ? 'Windows' : 'Linux'];
  parts.push(t.classes?.length ? t.classes.map((c) => (TARGET_CLASSES.find(([k]) => k === c) || [c, c])[1]).join(', ') : 'all device types');
  if (t.clients?.length) parts.push(t.clients.map((id) => clients.find((c) => c.id === id)?.name || `#${id}`).join(', '));
  else parts.push('all clients');
  return parts.join(' · ');
}

async function pagePolicies(view) {
  const [pols, clients] = await Promise.all([api('GET', '/api/policies'), api('GET', '/api/clients')]);
  view.innerHTML = `<div class="page-head"><h1>Policies</h1>${can('admin') ? '<a class="btn primary" href="#/policies/new">+ New policy</a>' : ''}</div>
    <p class="small muted" style="margin-top:-8px">Configuration baselines and security policies. Each policy targets a group of devices (by client, device type, platform, or a hand-picked list) and checks its rules on a schedule. With <strong>Enforce</strong> on, settings that drift are fixed automatically.</p>
    ${pols.length ? `<div class="grid cols-2">${pols.map((p) => { const c = p.compliance; const pc = c.checked ? Math.round((c.compliant / c.checked) * 100) : null; return `<a class="card netcard" href="#/policies/${p.id}">
      <div class="row" style="justify-content:space-between"><strong>${esc(p.name)}</strong><span>${p.enforce ? badge('enforce', 'info') : badge('report only')}${p.enabled ? '' : ` ${badge('disabled', 'warn')}`}</span></div>
      <div class="small muted">${esc(targetSummary(p.target, clients))} · ${plural(p.rules.length, 'rule')} · every ${p.interval_hours} h</div>
      <div>${pc == null ? '<span class="small muted">Not checked yet</span>' : `<div class="meter"><div class="bar ${pc < 70 ? 'bad' : pc < 100 ? 'warn' : ''}"><span style="width:${pc}%"></span></div><span class="n">${pc}%</span></div>`}</div>
      <div class="small">${badge(`${c.compliant} compliant`, 'ok')} ${c.non_compliant ? badge(`${c.non_compliant} not compliant`, 'bad') : ''} ${c.not_checked ? badge(`${c.not_checked} not checked`) : ''}${c.fixed ? ` ${badge(`${c.fixed} auto-fixed`, 'info')}` : ''}</div></a>`; }).join('')}</div>`
    : `<div class="card"><h2>No policies yet</h2><p>Start with a baseline such as: firewall on, Defender real-time protection, SMBv1 off, screen lock after 15 minutes, and "Spooler stopped" on servers.</p></div>`}`;
}

async function pagePolicyEdit(view, id) {
  if (!can('admin')) { view.innerHTML = '<div class="card">Only admins can create or edit policies.</div>'; return; }
  const [catalog, clients, agents, existing] = await Promise.all([api('GET', '/api/policy-rules'), api('GET', '/api/clients'), api('GET', '/api/agents'),
    id === 'new' ? null : api('GET', `/api/policies/${id}`)]);
  const p = existing || { name: '', description: '', enabled: true, enforce: false, interval_hours: 24, target: { platform: 'any', clients: [], classes: [], agents: [] }, rules: [] };
  let rules = p.rules.map((r) => ({ type: r.type, params: { ...r.params } }));
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const paramInput = (r, i, d) => {
    const v = r.params[d.key] ?? d.default ?? '';
    const name = `p-${i}-${d.key}`;
    if (d.type === 'select') return `<select name="${name}">${d.options.map(([o, l]) => `<option value="${esc(o)}" ${String(v) === o ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    if (d.type === 'textarea') return `<textarea name="${name}" rows="4" class="code" style="min-height:80px">${esc(v)}</textarea>`;
    return `<input type="${d.type === 'number' ? 'number' : 'text'}" name="${name}" value="${esc(v)}" ${d.required ? 'required' : ''}>`;
  };
  const drawRules = () => {
    $('#pe-rules').innerHTML = rules.map((r, i) => { const d = byId.get(r.type); return `<div class="rulecard" data-i="${i}">
      <div class="row" style="justify-content:space-between"><div><strong>${esc(d.title)}</strong> <span class="small muted">${d.platforms.map((x) => (x === 'windows' ? 'Windows' : 'Linux')).join(' + ')}${d.fixable ? '' : ' · report only'}</span></div>
        <button type="button" class="btn sm danger" data-rm="${i}">Remove</button></div>
      ${d.description ? `<div class="small muted" style="margin:4px 0 6px">${esc(d.description)}</div>` : ''}
      ${d.params.length ? `<div class="form-grid">${d.params.map((pd) => `<div class="field" ${pd.type === 'textarea' ? 'style="grid-column:1/-1"' : ''}><label>${esc(pd.label)}</label>${paramInput(r, i, pd)}</div>`).join('')}</div>` : ''}</div>`; }).join('')
      || '<div class="muted small">No rules yet. Add some below.</div>';
  };
  const cats = [...new Set(catalog.map((c) => c.category))];
  view.innerHTML = `<div class="page-head"><h1>${existing ? `Edit policy` : 'New policy'}</h1></div>
    <form id="pe-form" class="stack">
      <div class="card"><div class="form-grid"><div class="field"><label>Name</label><input type="text" name="name" required maxlength="100" value="${esc(p.name)}" placeholder="e.g. Workstation security baseline"></div>
        <div class="field"><label>Check every</label><select name="interval_hours">${[[1, '1 hour'], [4, '4 hours'], [12, '12 hours'], [24, 'Day'], [168, 'Week']].map(([v, l]) => `<option value="${v}" ${p.interval_hours === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <div class="field"><label>Description (optional)</label><input type="text" name="description" maxlength="500" value="${esc(p.description)}"></div>
        <label class="check"><input type="checkbox" name="enabled" ${p.enabled ? 'checked' : ''}> Enabled</label>
        <label class="check" style="margin-top:6px"><input type="checkbox" name="enforce" ${p.enforce ? 'checked' : ''}> <span><strong>Enforce</strong>: automatically fix settings that aren't compliant (otherwise report only)</span></label></div>
      <div class="card"><h2>Devices</h2>
        <div class="form-grid"><div class="field"><label>Platform</label><select name="platform">${[['any', 'Windows and Linux'], ['windows', 'Windows only'], ['linux', 'Linux only']].map(([v, l]) => `<option value="${v}" ${p.target.platform === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <div class="field"><label>Device types (none ticked = all)</label><div class="row">${TARGET_CLASSES.map(([k, l]) => `<label class="check"><input type="checkbox" name="cls-${k}" ${p.target.classes?.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
        <div class="field"><label>Clients (none ticked = all)</label><div class="row">${clients.map((c) => `<label class="check"><input type="checkbox" name="cli-${c.id}" ${p.target.clients?.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('') || '<span class="small muted">No clients</span>'}</div></div>
        <details ${p.target.agents?.length ? 'open' : ''}><summary class="small">Or pick specific devices (overrides the filters above)</summary>
          <div class="pickgrid">${agents.map((x) => `<label class="check small"><input type="checkbox" name="agt-${x.id}" ${p.target.agents?.includes(x.id) ? 'checked' : ''}> ${esc(x.hostname)} <span class="muted">${esc(x.client_name || '')}</span></label>`).join('')}</div></details>
        <div class="small muted" id="pe-count" style="margin-top:8px"></div></div>
      <div class="card"><h2>Rules</h2><div id="pe-rules" class="stack"></div>
        <div class="row" style="margin-top:12px"><select id="pe-add" style="width:auto"><option value="">+ Add rule…</option>${cats.map((c) => `<optgroup label="${esc(c)}">${catalog.filter((x) => x.category === c).map((x) => `<option value="${x.id}">${esc(x.title)}${x.platforms.length === 1 ? ` (${x.platforms[0] === 'windows' ? 'Windows' : 'Linux'})` : ''}</option>`).join('')}</optgroup>`).join('')}</select></div></div>
      <div class="row"><button class="btn primary">${existing ? 'Save' : 'Create and run'}</button>${existing ? '<label class="check"><input type="checkbox" name="run_now" checked> Run now after saving</label>' : ''}
        <a class="btn" href="${existing ? `#/policies/${existing.id}` : '#/policies'}">Cancel</a>${existing ? '<span class="grow"></span><button type="button" class="btn danger" id="pe-del">Delete policy</button>' : ''}</div>
    </form>`;
  const f = $('#pe-form');
  const collectParams = () => rules.forEach((r, i) => byId.get(r.type).params.forEach((d) => { const el2 = f.elements.namedItem(`p-${i}-${d.key}`); if (el2) r.params[d.key] = el2.value; }));
  const target = () => ({
    platform: f.elements.platform.value,
    classes: TARGET_CLASSES.map(([k]) => k).filter((k) => f.elements.namedItem(`cls-${k}`).checked),
    clients: clients.map((c) => c.id).filter((cid) => f.elements.namedItem(`cli-${cid}`).checked),
    agents: agents.map((x) => x.id).filter((aid) => f.elements.namedItem(`agt-${aid}`)?.checked),
  });
  const count = () => {
    const t = target();
    const n = t.agents.length ? t.agents.length : agents.filter((x) => (t.platform === 'any' || x.platform === t.platform) && (!t.classes.length || t.classes.includes(x.device_class)) && (!t.clients.length || t.clients.includes(x.client_id))).length;
    $('#pe-count').textContent = `Applies to ${plural(n, 'device')} right now (new devices that match are included automatically${t.agents.length ? ', except with hand-picked devices' : ''}).`;
  };
  drawRules(); count();
  f.addEventListener('change', (e) => { if (!e.target.name?.startsWith('p-')) count(); });
  $('#pe-add').addEventListener('change', (e) => {
    const d = byId.get(e.target.value);
    e.target.value = '';
    if (!d) return;
    collectParams();
    rules.push({ type: d.id, params: Object.fromEntries(d.params.map((pd) => [pd.key, pd.default ?? ''])) });
    drawRules();
  });
  $('#pe-rules').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { collectParams(); rules.splice(Number(b.dataset.rm), 1); drawRules(); } });
  f.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    collectParams();
    const body = { name: f.elements.name.value, description: f.elements.description.value, enabled: f.elements.enabled.checked, enforce: f.elements.enforce.checked,
      interval_hours: Number(f.elements.interval_hours.value), target: target(), rules, run_now: existing ? f.elements.run_now?.checked : true };
    if (body.enforce && !existing?.enforce && !await confirmDialog('Enforce mode changes settings on the targeted devices automatically. Continue?', { okLabel: 'Enforce' })) return;
    const r = existing ? await api('PUT', `/api/policies/${existing.id}`, body) : await api('POST', '/api/policies', body);
    toast(existing ? 'Policy saved' : 'Policy created and queued on the targeted devices');
    location.hash = `#/policies/${r.id}`;
  }));
  $('#pe-del')?.addEventListener('click', guard(async () => {
    if (!await confirmDialog(`Delete the policy "${existing.name}"? Settings already applied to devices stay as they are.`, { okLabel: 'Delete', danger: true })) return;
    await api('DELETE', `/api/policies/${existing.id}`); location.hash = '#/policies';
  }));
}

async function pagePolicy(view, id) {
  const draw = async () => {
    const [p, clients, catalog] = await Promise.all([api('GET', `/api/policies/${id}`), api('GET', '/api/clients'), api('GET', '/api/policy-rules')]);
    const c = p.compliance;
    const title = (r) => (r.type === 'custom_script' ? r.params.label : catalog.find((x) => x.id === r.type)?.title || r.type) + (r.params?.name && r.type.startsWith('service_') ? `: ${r.params.name}` : '');
    const cell = (res) => { if (!res) return '<span class="cstat none" title="Not checked">–</span>'; const cls = { pass: 'ok', fixed: 'fix', fail: 'bad', error: 'err', na: 'na' }[res.status] || 'none';
      return `<span class="cstat ${cls}" title="${esc(`${RESULT_BADGE[res.status]?.[0] || res.status}: ${res.detail || ''}`)}">${{ pass: '✓', fixed: '✓', fail: '✕', error: '!', na: '–' }[res.status] || '?'}</span>`; };
    view.innerHTML = `<div class="page-head"><div><h1>${esc(p.name)}</h1><div class="small muted" style="margin-top:4px">${esc(targetSummary(p.target, clients))} · every ${p.interval_hours} h · ${p.enforce ? 'enforced' : 'report only'}${p.enabled ? '' : ' · disabled'}${p.last_run ? ` · last run ${fmtAgo(p.last_run)}` : ''}</div></div>
      <div class="row">${can('tech') ? '<button class="btn primary" id="pp-run">Run now</button>' : ''}${can('admin') ? `<a class="btn" href="#/policies/${p.id}/edit">Edit</a>` : ''}</div></div>
      ${p.description ? `<p class="small muted" style="margin-top:-8px">${esc(p.description)}</p>` : ''}
      <div class="row" style="margin-bottom:12px">${badge(`${c.compliant} compliant`, 'ok')} ${badge(`${c.non_compliant} not compliant`, c.non_compliant ? 'bad' : '')} ${badge(`${c.not_checked} not checked`)} ${c.fixed ? badge(`${c.fixed} auto-fixed`, 'info') : ''}</div>
      <div class="card flush"><div class="table-wrap"><table class="matrix"><thead><tr><th>Device</th>${p.rules.map((r) => `<th class="rot" title="${esc(title(r))}"><span>${esc(title(r))}</span></th>`).join('')}<th>Checked</th></tr></thead><tbody>
      ${p.devices.map((d) => { const res = new Map(d.results.map((x) => [x.rule_key, x])); const at = Math.max(0, ...d.results.map((x) => x.checked_at));
        return `<tr><td><a href="#/devices/${d.id}/compliance"><strong>${esc(d.hostname)}</strong></a><div class="small muted">${esc(CLASS_INFO[d.device_class]?.[0] || '')} · ${esc(d.platform)}</div></td>
          ${p.rules.map((r) => `<td class="center">${cell(res.get(r.key))}</td>`).join('')}<td class="small nowrap">${at ? fmtAgo(at) : '—'}${res.get('_run') ? ` ${badge('failed', 'bad')}` : ''}</td></tr>`; }).join('')
        || `<tr><td colspan="${p.rules.length + 2}" class="empty">No devices match this policy</td></tr>`}</tbody></table></div></div>
      <p class="small muted">✓ compliant (blue: fixed automatically) · ✕ not compliant · ! error · – not applicable / not checked. Hover a cell for details.</p>`;
    $('#pp-run')?.addEventListener('click', guard(async () => { const r = await api('POST', `/api/policies/${id}/run`); toast(`Queued on ${plural(r.created, 'device')}`); }));
  };
  await draw();
  every(15000, draw);
}

// unread chat badge in the menu
async function updateChatBadge() {
  try {
    const u = await api('GET', '/api/chat/unread');
    const n = u.reduce((s, x) => s + x.unread, 0);
    const b = $('#nav-chat');
    if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
    const known = state.chatSeen || 0;
    const newest = Math.max(0, ...u.map((x) => x.last_at));
    if (newest > known && state.chatSeen != null && !location.hash.endsWith('/chat')) {
      const c = u.find((x) => x.last_at === newest);
      toast(`New message from ${c.hostname}: ${c.last_body.slice(0, 80)}`);
    }
    state.chatSeen = Math.max(known, newest);
  } catch { /* signed out */ }
}
setInterval(() => { if (state.user && can('tech')) updateChatBadge(); }, 15000);

// ---------------- devices ----------------
async function pageDevices(view) {
  const clients = await api('GET', '/api/clients');
  const f = state.devFilter;
  view.innerHTML = `
    <div class="page-head"><h1>Devices</h1>
      <div class="row">
        ${can('tech') ? `<select id="bulk-sel" style="width:auto" disabled><option value="">More actions…</option>
          <option value="scan">Scan for OS updates</option><option value="patch">Install all OS updates</option>
          <option value="patch-reboot">Install all OS updates + reboot if required</option><option value="software">Install software…</option>
          <option value="agent-update">Update HostPilot agent now</option></select>
          <button class="btn primary" data-action="run-selected" id="run-sel" disabled>Run script on selected</button>` : ''}
        <a class="btn" href="#/clients">+ Add devices</a></div></div>
    <div class="toolbar">
      <input type="search" id="dev-q" placeholder="Search hostname, IP, user, OS…" value="${esc(f.q)}">
      <select id="dev-client"><option value="">All clients</option>${clients.map((c) => `<option value="${c.id}" ${String(f.client) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="dev-status"><option value="">Any status</option><option value="online">Online</option><option value="offline">Offline</option><option value="alerts">With alerts</option><option value="maintenance">Maintenance</option></select>
      <select id="dev-platform"><option value="">All platforms</option><option value="windows">Windows</option><option value="linux">Linux</option><option value="macos">macOS</option></select>
      <select id="dev-class"><option value="">All device types</option><option value="desktop">Desktops</option><option value="laptop">Laptops</option><option value="server">Servers</option><option value="vm">Virtual machines</option></select>
      <span class="muted small" id="dev-count"></span>
    </div>
    <div class="card flush"><div class="table-wrap"><table>
      <thead><tr><th style="width:32px"><input type="checkbox" id="dev-all"></th><th>Hostname</th><th>Client</th><th>Type</th><th>OS</th><th>IP</th><th>User</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Last seen</th></tr></thead>
      <tbody id="dev-body"><tr><td colspan="10" class="empty">Loading…</td></tr></tbody></table></div></div>`;
  $('#dev-status').value = f.status;
  $('#dev-platform').value = f.platform;
  $('#dev-class').value = f.cls || '';
  let agents = [];
  const filtered = () => {
    const q = f.q.toLowerCase();
    return agents.filter((a) => {
      if (f.client && String(a.client_id) !== String(f.client)) return false;
      if (f.platform && a.platform !== f.platform) return false;
      if (f.cls && a.device_class !== f.cls) return false;
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
      <td>${esc(a.client_name || '—')}</td><td>${classBadge(a.device_class)}</td><td>${osCell(a)}</td>
      <td class="mono small">${esc((a.ip_addrs || [])[0] || '')}</td><td class="small">${esc(a.logged_user || '')}</td>
      <td>${a.online ? meter(a.cpu_pct) : '<span class="muted">—</span>'}</td><td>${a.online ? meter(a.mem_pct) : '<span class="muted">—</span>'}</td><td>${meter(a.disk_pct)}</td>
      <td class="nowrap small ${a.online ? '' : 'muted'}">${a.online ? 'Online' : fmtAgo(a.last_seen)}</td></tr>`).join('')
      || `<tr><td colspan="11" class="empty">${agents.length ? 'No devices match the filters' : 'No devices yet. Go to a client page to get an install command.'}</td></tr>`;
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
  $('#dev-class').addEventListener('change', (e) => { f.cls = e.target.value; drawRows(); });
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
    if (op === 'agent-update') {
      if (!await confirmDialog(`Update the HostPilot agent on ${ids.length} device(s)? Each agent downloads the latest version and restarts (running jobs are abandoned).`, { okLabel: 'Update' })) return;
      const r = await api('POST', '/api/agents/update-agent', { agent_ids: ids });
      toast(`Agent update queued on ${r.created} device(s)`);
      location.hash = `#/jobs/batch/${r.batch_id}`;
      return;
    }
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
  const win = a.platform === 'windows';
  const tabs = [['overview', 'Overview'], ['terminal', 'Run command'], ['files', 'Files'], ['tasks', 'Task manager'], ...(win ? [['registry', 'Registry']] : []),
    ['updates', 'Updates'], ['software', 'Software'], ['users', 'Users'], ['hardware', 'Hardware'], ['firewall', 'Firewall'], ['compliance', 'Compliance'],
    ...(win || a.platform === 'linux' ? [['chat', 'Chat']] : []), ['jobs', 'Script history'], ['alerts', 'Alerts'], ['settings', 'Settings']];
  const term = (shell, label) => `<a class="btn" href="/terminal.html#${encodeURIComponent(a.id)}${shell ? `/${shell}` : ''}" target="_blank" rel="noopener" title="Opens a background session as SYSTEM/root; the signed-in user sees nothing">${label}</a>`;
  view.innerHTML = `
    <div class="page-head"><div>
      <h1>${statusDot(a)}${esc(a.hostname)}</h1>
      <div class="muted small" style="margin-top:4px">${osCell(a)} · ${classBadge(a.device_class)} · ${a.client_name ? `<a href="#/clients/${a.client_id}">${esc(a.client_name)}</a>` : 'No client'} · ${a.maintenance ? badge('maintenance', 'warn') : a.online ? badge('online', 'ok') : badge(`offline · ${fmtAgo(a.last_seen)}`, 'bad')}</div></div>
      <div class="row">${can('tech') && win ? `<a class="btn primary" href="/remote.html#${encodeURIComponent(a.id)}" target="_blank" rel="noopener">Remote control</a>${term('powershell', 'PowerShell')}${term('cmd', 'Command Prompt')}` : ''}
      ${can('tech') && !win ? `<a class="btn primary" href="/terminal.html#${encodeURIComponent(a.id)}" target="_blank" rel="noopener">Terminal</a>` : ''}
      ${can('tech') ? `<button class="btn" data-action="run-on" data-ids="${a.id}">Run script</button><button class="btn" data-action="refresh-inv" data-id="${a.id}">Refresh inventory</button>` : ''}</div></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/devices/${a.id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <div id="tab"></div>`;
  const el = $('#tab');
  const fn = {
    overview: devOverview, terminal: devTerminal, files: devFiles, updates: devUpdates, software: devSoftware, users: devUsers,
    hardware: devHardware, firewall: devFirewall, tasks: devTaskManager, registry: devRegistry, compliance: devCompliance, chat: devChat,
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
      <dl class="kv">${kv('CPU', meter(a.cpu_pct))}
      ${Array.isArray(a.core_load) && a.core_load.length ? kv(`Per core <span class="small muted">(${a.core_load.length})</span>`, coreGrid(a.core_load)) : ''}
      ${kv('Memory', meter(a.mem_pct))}${kv('Uptime', a.boot_time ? fmtDur(Date.now() - a.boot_time) : '')}
      ${(a.disks || []).map((d) => kv(can('tech') ? `<a href="#/devices/${a.id}/files" data-action="open-drive" data-id="${a.id}" data-path="${esc(drivePath(a, d.mount))}" title="Browse in Files">${esc(d.mount)}</a>` : esc(d.mount),
        `${meter(d.total ? ((d.total - d.free) / d.total) * 100 : null)}<div class="small muted">${fmtBytes(d.free)} free of ${fmtBytes(d.total)}</div>`)).join('')}</dl>
      ${can('tech') ? `<div class="small muted">Click a drive to browse it · <a href="#/devices/${a.id}/hardware">Disk health & details</a></div>` : ''}</div>
    <div class="card"><h3>Monitored services</h3>${(a.services || []).length ? `<table class="dash"><tbody>${a.services.map((s) => `<tr><td><strong>${esc(s.display || s.name)}</strong>${s.display ? `<div class="small muted mono">${esc(s.name)}</div>` : ''}</td>
        <td class="small muted">${esc(s.start)}</td><td class="right">${s.status === 'running' ? badge('running', 'ok') : s.status === 'missing' ? badge('not installed', 'warn') : badge(s.status, 'bad')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="small muted">No services are monitored on this device. Add them in Settings (all devices), on this device\'s Settings tab, or with a "Service running" policy rule. You get an alert when a monitored service stops.</div>'}</div>
    ${chartCard('perf', 'Performance')}
    ${chartCard('net', 'Network traffic')}
    <div class="card" style="grid-column:1/-1"><h3>Network interfaces</h3>${ifaceTable(a.net_ifaces)}</div>
    ${a.notes ? `<div class="card"><h3>Notes</h3><div style="white-space:pre-wrap">${esc(a.notes)}</div></div>` : ''}
  </div>`;
  const perf = chartPanel(a, 'perf', [['cpu', 'CPU', 'var(--c1)'], ['mem', 'Memory', 'var(--c2)'], ['disk', 'Fullest disk', 'var(--c3)']]);
  const net = chartPanel(a, 'net', [['net_rx', 'Download', 'var(--c4)'], ['net_tx', 'Upload', 'var(--c5)']], { rate: true });
  await Promise.all([perf(), net()]);
}

const chartCard = (id, title) => `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">${title}</h3>
  <select id="${id}-range" style="width:auto"><option value="live">1 minute (live)</option><option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option></select></div>
  <div id="${id}-chart" class="muted">Loading…</div></div>`;

/** Wires a chartCard: history from /metrics, or live 2-second samples (shared device sampler) for "1 minute". */
function chartPanel(a, id, series, { rate = false } = {}) {
  const box = () => $(`#${id}-chart`);
  const sel = () => $(`#${id}-range`)?.value;
  let liveTimer = null, lastStart = 0;
  const stopLive = () => { clearInterval(liveTimer); liveTimer = null; };
  const drawLive = async () => {
    if (!box() || sel() !== 'live') return stopLive(); // navigated away or range changed
    const r = await api('GET', `/api/agents/${a.id}/live`);
    // (re)start the device-side sampler if it isn't running
    if (!r.active && Date.now() - lastStart > 20000) { lastStart = Date.now(); await api('POST', `/api/agents/${a.id}/live`); }
    const rows = r.samples.filter((s) => series.some(([k]) => s[k] != null));
    box().innerHTML = rows.length
      ? chart(rows, series, { hours: 1 / 60, rate }) + '<div class="small muted">Live · a sample every 2 seconds</div>'
      : '<div class="muted">Starting live monitoring on the device… (usually a few seconds)</div>';
  };
  const draw = async () => {
    const v = sel();
    if (!v) return;
    if (v === 'live') {
      if (!liveTimer) {
        box().innerHTML = '<div class="muted">Starting live monitoring on the device…</div>';
        lastStart = Date.now();
        try { await api('POST', `/api/agents/${a.id}/live`); } catch (e) { box().innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
        liveTimer = setInterval(guard(drawLive), 2000);
        state.timers.push(liveTimer);
      }
      return drawLive();
    }
    stopLive();
    const hours = Number(v);
    const rows = (await api('GET', `/api/agents/${a.id}/metrics?hours=${hours}`)).filter((r) => series.some(([k]) => r[k] != null));
    box().innerHTML = rows.length ? chart(rows, series, { hours, rate })
      : `<div class="muted">${rate ? 'No network data yet. It appears after the agent has checked in twice with this version.' : 'No metrics yet.'}</div>`;
  };
  $(`#${id}-range`).addEventListener('change', guard(draw));
  every(60000, () => { if (sel() !== 'live') return draw(); });
  return draw;
}

const IFACE_KIND = { ethernet: 'Ethernet', wifi: 'Wi-Fi', vpn: 'VPN', virtual: 'Virtual', bluetooth: 'Bluetooth', cellular: 'Cellular', other: 'Other' };
function ifaceTable(list) {
  if (!list) return '<div class="muted">Not reported yet. The interface list appears after the agent updates itself and checks in.</div>';
  if (!list.length) return '<div class="muted">No network interfaces reported.</div>';
  const rows = [...list].sort((x, y) => (y.connected - x.connected) || (x.kind === 'vpn') - (y.kind === 'vpn'));
  return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Make</th><th>Model</th><th>Status</th><th>Speed</th><th>MAC</th><th>IP addresses</th></tr></thead><tbody>
    ${rows.map((i) => `<tr><td><strong>${esc(i.name)}</strong></td><td>${i.kind === 'vpn' ? badge('VPN', 'info') : esc(IFACE_KIND[i.kind] || i.kind)}</td>
      <td>${esc(i.make) || '<span class="muted">—</span>'}</td><td>${esc(i.model) || '<span class="muted">—</span>'}</td>
      <td>${i.connected ? badge('Connected', 'ok') : badge('Disconnected', 'muted')}</td>
      <td class="nowrap">${i.connected && i.speed ? fmtBits(i.speed) : '<span class="muted">—</span>'}</td>
      <td class="mono small">${esc(i.mac) || '<span class="muted">—</span>'}</td>
      <td class="mono small">${i.ips.map(esc).join('<br>') || '<span class="muted">—</span>'}</td></tr>`).join('')}
  </tbody></table></div>`;
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
      ${tech && a.platform !== 'macos' ? '<button class="btn primary" id="sw-install">Install software…</button>' : ''}</div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Version</th><th>Publisher</th>${tech ? '<th></th>' : ''}</tr></thead><tbody id="sw-body"></tbody></table></div></div>`;
  const draw = () => {
    const q = $('#sw-q').value.toLowerCase();
    const rows = sw.filter((s) => !q || `${s.name} ${s.publisher}`.toLowerCase().includes(q));
    $('#sw-body').innerHTML = rows.slice(0, 2000).map((s) => `<tr><td>${esc(s.name)}</td><td class="mono small">${esc(s.version)}</td><td class="small muted">${esc(s.publisher)}</td>
      ${tech && a.platform === 'macos' ? '<td class="right small muted">—</td>' : ''}${tech && a.platform !== 'macos' ? `<td class="right nowrap"><button class="btn sm" data-sw="reinstall" data-name="${esc(s.name)}">Reinstall</button> <button class="btn sm danger" data-sw="uninstall" data-name="${esc(s.name)}">Uninstall</button></td>` : ''}</tr>`).join('')
      || `<tr><td colspan="4" class="empty">No software inventory yet</td></tr>`;
  };
  $('#sw-q').addEventListener('input', draw);
  draw();
  if (!tech) return;
  $('#sw-install')?.addEventListener('click', () => installSoftwareModal(a));
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
// "C:" -> "C:\" ; Linux mount points are already paths
const drivePath = (a, mount) => (isWin(a) && /^[A-Za-z]:$/.test(mount) ? `${mount}\\` : mount);
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

// ---------------- hardware: disks (SMART), USB, printers & scanners ----------------
const USB_VENDORS = {
  '03f0': 'HP', '0403': 'FTDI', '040a': 'Kodak', '041e': 'Creative', '0424': 'Microchip (SMSC)', '0451': 'Texas Instruments', '045e': 'Microsoft', '046a': 'Cherry',
  '046d': 'Logitech', '04a9': 'Canon', '04b8': 'Epson', '04d9': 'Holtek', '04e6': 'Identiv', '04e8': 'Samsung', '04f2': 'Chicony', '04f9': 'Brother',
  '0502': 'Acer', '0518': 'EzKEY', '054c': 'Sony', '056a': 'Wacom', '05ac': 'Apple', '05e3': 'Genesys Logic', '0624': 'Avocent', '067b': 'Prolific',
  '06cb': 'Synaptics', '0781': 'SanDisk', '07ca': 'AVerMedia', '0846': 'NETGEAR', '08bb': 'Texas Instruments (audio)', '090c': 'Silicon Motion', '0930': 'Toshiba',
  '0951': 'Kingston', '0a12': 'Cambridge Silicon Radio', '0a5c': 'Broadcom', '0b05': 'ASUS', '0b95': 'ASIX', '0bc2': 'Seagate', '0bda': 'Realtek', '0c45': 'Microdia',
  '0cf3': 'Qualcomm Atheros', '0d8c': 'C-Media', '0e6f': 'PDP', '0e8d': 'MediaTek', '0fd9': 'Elgato', '1050': 'Yubico', '1058': 'Western Digital', '10c4': 'Silicon Labs',
  '1209': 'Generic (pid.codes)', '13fe': 'Phison', '1395': 'Sennheiser', '1462': 'MSI', '152a': 'Thesycon / XMOS', '1532': 'Razer', '154b': 'PNY', '1631': 'Good Way',
  '17ef': 'Lenovo', '18d1': 'Google', '1915': 'Nordic Semiconductor', '1a40': 'Terminus Technology', '1a86': 'QinHeng (CH340)', '1b1c': 'Corsair', '1d6b': 'Linux Foundation',
  '1e71': 'NZXT', '2109': 'VIA Labs', '2357': 'TP-Link', '2516': 'Cooler Master', '258a': 'SINO WEALTH', '2717': 'Xiaomi', '22b8': 'Motorola', '2a70': 'OnePlus',
  '2f96': 'Ugreen', '3297': 'ZSA', '413c': 'Dell', '8087': 'Intel', '8086': 'Intel', '8564': 'Transcend', '0c76': 'JMTek', '2833': 'Oculus',
  '28de': 'Valve', '0079': 'DragonRise', '1038': 'SteelSeries', '0b0e': 'Jabra', '047f': 'Plantronics (Poly)', '0d8d': 'Generic audio', '048d': 'ITE Tech', '1d50': 'OpenMoko',
};
const DISK_MAKERS = [[/^samsung/i, 'Samsung'], [/^(wdc|wd[ _]|western)/i, 'Western Digital'], [/^(st\d|seagate)/i, 'Seagate'], [/^toshiba|^kioxia/i, 'Toshiba / Kioxia'],
  [/^(ct\d|crucial)/i, 'Crucial'], [/^kingston|^sa400|^suv|^skc|^sedc/i, 'Kingston'], [/^intel|^ssdpe|^ssdsc/i, 'Intel'], [/^sandisk|^sd[0-9a-z]{2}/i, 'SanDisk'],
  [/^micron|^mtfd/i, 'Micron'], [/^(hgst|hitachi|hds|hus)/i, 'HGST / Hitachi'], [/^sk ?hynix|^hfs|^hfm/i, 'SK hynix'], [/^adata|^asx|^su\d/i, 'ADATA'],
  [/^corsair/i, 'Corsair'], [/^lexar/i, 'Lexar'], [/^transcend|^ts\d/i, 'Transcend'], [/^(pny|cs\d{4})/i, 'PNY'], [/^mkn|^mushkin/i, 'Mushkin'], [/^phison|^ps\d/i, 'Phison'],
  [/^teamgroup|^t-force|^team/i, 'TEAMGROUP'], [/^patriot/i, 'Patriot'], [/^(msft|microsoft) virtual/i, 'Microsoft (virtual)'], [/^vmware/i, 'VMware (virtual)'],
  [/^qemu/i, 'QEMU (virtual)'], [/^virtual|^vbox/i, 'Virtual disk'], [/^apple/i, 'Apple'], [/^lenovo/i, 'Lenovo'], [/^hp\b|^hewlett/i, 'HP'], [/^dell/i, 'Dell'],
  [/^nvme ?(ca|ss)/i, ''], [/^wd/i, 'Western Digital'], [/^my passport|^elements|^easystore/i, 'Western Digital']];
function diskMake(make, model) {
  const m = String(make || '').trim();
  if (m && !/^\(standard|^ata$|^nvme$|^usb$/i.test(m)) return m === 'WD' ? 'Western Digital' : m;
  const hit = DISK_MAKERS.find(([re]) => re.test(String(model || '').trim()));
  return hit ? hit[1] : '';
}
const fmtHours = (h) => (h === '' || h == null ? '' : `${Number(h).toLocaleString()} h <span class="muted">(${(Number(h) / 8766).toFixed(1)} years)</span>`);
const HEALTH_BADGE = { OK: ['Healthy', 'ok'], Warning: ['Warning', 'warn'], Failing: ['Failing', 'bad'], Unknown: ['Unknown', ''] };

async function devHardware(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">Hardware details require the tech role.</div>'; return; }
  const section = (id, title, extra = '') => `<div class="card" id="${id}" style="margin-bottom:16px"><div class="row" style="justify-content:space-between;margin-bottom:10px">
    <h3 style="margin:0">${title}</h3><div class="row">${extra}<button class="btn sm" data-hw-refresh="${id}">Refresh</button></div></div><div class="hw-body muted">Loading…</div></div>`;
  el.innerHTML = section('hw-disks', 'Disks')
    + section('hw-usb', 'USB devices', `<label class="check small"><input type="checkbox" id="usb-hubs"> Show hubs</label>
        <select id="usb-filter" style="width:auto"><option value="all">Connected & previously connected</option><option value="on">Connected only</option><option value="off">Not connected only</option></select>`)
    + section('hw-print', 'Printers & scanners');
  const body = (id) => $(`#${id} .hw-body`);
  const fail = (id, err) => { body(id).innerHTML = `<div class="small" style="color:var(--bad)">${esc(err.message)}</div>`; };

  const loadDisks = async () => {
    body('hw-disks').innerHTML = '<div class="muted">Reading disks and SMART data…</div>';
    try {
      const j = await deviceTask(a.id, 'hardware.disks');
      const disks = parseTsv(j.stdout, 'D').map(([id, make, model, serial, size, media, bus, health, temp, poh, wear, realloc, errs, vols, fw, note]) =>
        ({ id, make: diskMake(make, model), model, serial, size: Number(size), media, bus, health, temp, poh, wear, realloc, errs, vols: (vols || '').split(' ').filter(Boolean), fw, note }));
      const kv = (k, v) => (v === '' || v == null ? '' : `<dt>${k}</dt><dd>${v}</dd>`);
      body('hw-disks').innerHTML = disks.length ? `<div class="grid cols-2">${disks.map((d) => {
        const [hl, hc] = HEALTH_BADGE[d.health] || HEALTH_BADGE.Unknown;
        const vols = d.vols.map((v) => `<a href="#" data-action="open-drive" data-id="${a.id}" data-path="${esc(drivePath(a, v))}">${esc(v)}</a>`).join(' ');
        return `<div class="card" style="background:var(--panel-2)"><div class="row" style="justify-content:space-between;margin-bottom:8px">
            <strong>${esc((d.make && !d.model.toLowerCase().startsWith(d.make.toLowerCase().split(' ')[0]) ? `${d.make} ${d.model}` : d.model) || `Disk ${d.id}`)}</strong><span class="row">${badge(hl, hc)}${d.media ? badge(d.media, 'info') : ''}</span></div>
          <dl class="kv">${kv('Make', esc(d.make))}${kv('Model', esc(d.model))}${kv('Serial number', `<span class="mono">${esc(d.serial)}</span>`)}${kv('Capacity', fmtBytes(d.size))}
            ${kv('Interface', esc(d.bus))}${kv('Firmware', esc(d.fw))}${kv(isWin(a) ? 'Drives' : 'Mounted at', vols)}
            ${kv('Temperature', d.temp ? `${esc(d.temp)} °C` : '')}${kv('Powered on', fmtHours(d.poh))}
            ${kv('Life used', d.wear !== '' ? `${meter(Number(d.wear))}` : '')}${kv('Reallocated sectors', esc(d.realloc))}${kv('Uncorrected errors', esc(d.errs))}</dl>
          ${d.note ? `<div class="small muted" style="margin-top:8px">${esc(d.note)}</div>` : ''}</div>`;
      }).join('')}</div>` : '<div class="muted">No physical disks reported.</div>';
    } catch (err) { fail('hw-disks', err); }
  };

  let usb = [];
  const drawUsb = () => {
    const hubs = $('#usb-hubs').checked, f = $('#usb-filter').value;
    const rows = usb.filter((u) => (hubs || !u.hub) && (f === 'all' || (f === 'on') === u.on))
      .sort((x, y) => (y.on - x.on) || (y.arrived - x.arrived) || x.name.localeCompare(y.name));
    const n = usb.filter((u) => !u.hub);
    body('hw-usb').innerHTML = `<div class="small muted" style="margin-bottom:8px">${n.filter((u) => u.on).length} connected · ${n.filter((u) => !u.on).length} previously connected${isWin(a) ? '' : ' (from the kernel log)'}</div>
      <div class="table-wrap"><table class="rtable"><thead><tr><th>Status</th><th>Device</th><th>Manufacturer</th><th>Type</th><th>VID:PID</th><th>Serial</th><th>Last connected</th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td data-label="Status">${u.on ? badge('Connected', 'ok') : badge('Not connected')}</td><td data-label="Device"><strong>${esc(u.name || 'Unknown device')}</strong></td>
        <td data-label="Manufacturer">${esc(u.make) || '<span class="muted">—</span>'}</td><td data-label="Type">${esc(u.cls)}</td>
        <td data-label="VID:PID" class="mono small">${esc(u.vid)}:${esc(u.pid)}</td><td data-label="Serial" class="mono small">${esc(u.serial) || '<span class="muted">—</span>'}</td>
        <td data-label="Last connected" class="small nowrap">${u.on ? 'now' : u.arrived ? fmtAgo(u.arrived) : '<span class="muted">unknown</span>'}</td></tr>`).join('')
        || '<tr><td colspan="7" class="empty">No USB devices</td></tr>'}</tbody></table></div>`;
  };
  const loadUsb = async () => {
    body('hw-usb').innerHTML = '<div class="muted">Listing USB devices…</div>';
    try {
      const j = await deviceTask(a.id, 'hardware.usb');
      usb = parseTsv(j.stdout, 'U').map(([on, name, mfr, cls, vid, pid, serial, hub, arr]) => ({
        on: on === '1', name, make: mfr || USB_VENDORS[String(vid).toLowerCase()] || '', cls: cls === 'HIDClass' ? 'Input (HID)' : cls,
        vid: String(vid).toLowerCase(), pid: String(pid).toLowerCase(), serial, hub: hub === '1', arrived: Number(arr) * 1000 || 0 }));
      drawUsb();
    } catch (err) { fail('hw-usb', err); }
  };

  const loadPrinters = async () => {
    body('hw-print').innerHTML = '<div class="muted">Listing printers and scanners…</div>';
    try {
      const j = await deviceTask(a.id, 'hardware.printers');
      const queues = parseTsv(j.stdout, 'P').map(([name, driver, port, status, conn, shared, def, loc, virt]) => ({ name, driver, port, status, conn, shared: shared === '1', def: def === '1', loc, virt: virt === '1' }));
      const hw = parseTsv(j.stdout, 'H').map(([kind, on, name, mfr, arr]) => ({ kind, on: on === '1', name, mfr, arrived: Number(arr) * 1000 || 0 }));
      const note = parseTsv(j.stdout, 'NOTE').map(([t]) => t);
      const connCell = (q) => (q.virt ? badge('Virtual') : q.conn === '1' ? badge('Connected', 'ok') : badge('Not connected', 'bad'));
      body('hw-print').innerHTML = `${note.map((t) => `<div class="small muted">${esc(t)}</div>`).join('')}
        <div class="small muted" style="margin:4px 0 6px">Printers (print queues)</div>
        <div class="table-wrap"><table class="rtable"><thead><tr><th>Name</th><th>Connection</th><th>Status</th><th>Driver / model</th><th>Port</th><th>Shared</th></tr></thead><tbody>
        ${queues.sort((x, y) => (x.virt - y.virt) || x.name.localeCompare(y.name)).map((q) => `<tr><td data-label="Name"><div><strong>${esc(q.name)}</strong>${q.def ? ' ' + badge('default', 'info') : ''}${q.loc ? `<div class="small muted">${esc(q.loc)}</div>` : ''}</div></td>
          <td data-label="Connection">${connCell(q)}</td><td data-label="Status" class="small">${esc(q.status)}</td><td data-label="Driver" class="small">${esc(q.driver)}</td>
          <td data-label="Port" class="small mono">${esc(q.port)}</td><td data-label="Shared">${q.shared ? 'Yes' : 'No'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No printers</td></tr>'}
        </tbody></table></div>
        <div class="small muted" style="margin:14px 0 6px">Printer & scanner hardware</div>
        <div class="table-wrap"><table class="rtable"><thead><tr><th>Type</th><th>Device</th><th>Manufacturer</th><th>Status</th><th>Last connected</th></tr></thead><tbody>
        ${hw.sort((x, y) => (y.on - x.on) || x.kind.localeCompare(y.kind)).map((h) => `<tr><td data-label="Type">${h.kind === 'scanner' ? 'Scanner' : 'Printer'}</td><td data-label="Device"><strong>${esc(h.name)}</strong></td>
          <td data-label="Manufacturer">${esc(h.mfr) || '<span class="muted">—</span>'}</td><td data-label="Status">${h.on ? badge('Connected', 'ok') : badge('Not connected')}</td>
          <td data-label="Last connected" class="small">${h.on ? 'now' : h.arrived ? fmtAgo(h.arrived) : '<span class="muted">unknown</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">None found</td></tr>'}
        </tbody></table></div>`;
    } catch (err) { fail('hw-print', err); }
  };

  const loaders = { 'hw-disks': loadDisks, 'hw-usb': loadUsb, 'hw-print': loadPrinters };
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-hw-refresh]'); if (b) guard(loaders[b.dataset.hwRefresh])(); });
  $('#usb-hubs').addEventListener('change', drawUsb);
  $('#usb-filter').addEventListener('change', drawUsb);
  await Promise.all([loadDisks(), loadUsb(), loadPrinters()]);
}

// ---------------- firewall ----------------
async function devFirewall(el, a) {
  if (!can('tech')) { el.innerHTML = '<div class="card">Firewall management requires the tech role.</div>'; return; }
  el.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Firewall</h3>
      <span class="muted small" id="fw-status">Loading…</span></div><div id="fw-profiles" class="row" style="margin-top:10px"></div></div>
    <div class="toolbar"><input type="search" id="fw-q" placeholder="Search name, port, address, program…">
      <select id="fw-dir"><option value="">In & out</option><option value="in">Inbound</option><option value="out">Outbound</option></select>
      <select id="fw-show"><option value="enabled">Enabled rules</option><option value="all">All rules</option><option value="custom">Custom rules (no group)</option><option value="block">Block rules</option></select>
      <span class="grow"></span><button class="btn sm" id="fw-refresh">Refresh</button><button class="btn primary" id="fw-new">New rule</button></div>
    <div class="card flush"><div class="table-wrap"><table class="rtable"><thead><tr><th>Name</th><th>Direction</th><th>Action</th><th>Protocol / ports</th><th>Remote address</th>${isWin(a) ? '<th>Program</th><th>Profiles</th>' : ''}<th>Enabled</th><th></th></tr></thead>
      <tbody id="fw-body"><tr><td colspan="9" class="empty">Loading…</td></tr></tbody></table></div></div>
    <p class="small muted" id="fw-foot"></p>`;
  let rules = [], backend = isWin(a) ? 'windows' : '';
  const managed = () => isWin(a) || ['ufw', 'firewalld'].includes(backend);
  const draw = () => {
    const q = $('#fw-q').value.toLowerCase(), dir = $('#fw-dir').value, show = $('#fw-show').value;
    const list = rules.filter((r) => (!dir || r.dir === dir)
      && (show === 'all' || (show === 'enabled' && r.enabled) || (show === 'custom' && !r.group) || (show === 'block' && r.action === 'block'))
      && (!q || [r.name, r.lport, r.rport, r.raddr, r.program, r.group, r.proto, r.desc].join(' ').toLowerCase().includes(q)));
    const shown = list.slice(0, 400);
    $('#fw-body').innerHTML = shown.map((r, i) => {
      const ro = r.source !== 'local' || !managed();
      const ports = r.proto === 'Any' || r.proto === 'any' ? 'Any' : `${esc(r.proto)}${r.lport && r.lport.toLowerCase() !== 'any' ? ` ${esc(r.lport)}` : ''}${r.rport && r.rport.toLowerCase() !== 'any' ? ` → ${esc(r.rport)}` : ''}`;
      return `<tr data-i="${rules.indexOf(r)}"><td data-label="Name"><div><strong>${esc(r.name || r.id)}</strong>${r.group ? `<div class="small muted">${esc(r.group)}</div>` : ''}</div></td>
        <td data-label="Direction">${r.dir === 'out' ? 'Outbound' : 'Inbound'}</td><td data-label="Action">${r.action === 'block' ? badge('Block', 'bad') : badge('Allow', 'ok')}</td>
        <td data-label="Protocol / ports" class="small">${ports}</td><td data-label="Remote address" class="small mono">${esc(r.raddr || 'Any')}</td>
        ${isWin(a) ? `<td data-label="Program" class="small" title="${esc(r.program)}">${esc(r.program ? r.program.split('\\').pop() : '')}</td><td data-label="Profiles" class="small">${esc(r.profiles)}</td>` : ''}
        <td data-label="Enabled">${ro || !isWin(a) ? (r.enabled ? 'Yes' : 'No') : `<label class="switch"><input type="checkbox" data-fw="toggle" ${r.enabled ? 'checked' : ''}><span></span></label>`}</td>
        <td class="right nowrap">${ro ? `<span class="small muted">${r.source === 'gpo' ? 'Group Policy' : 'read-only'}</span>` : '<button class="btn sm" data-fw="edit">Edit</button> <button class="btn sm danger" data-fw="delete">Delete</button>'}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="empty">No matching rules</td></tr>';
    $('#fw-foot').textContent = `${list.length} of ${rules.length} rules shown${list.length > shown.length ? ' (first 400; search to narrow down)' : ''}.`;
  };
  const load = async () => {
    $('#fw-status').textContent = 'Loading…';
    try {
      const j = await deviceTask(a.id, 'fw.list');
      backend = parseTsv(j.stdout, 'B')[0]?.[0] || backend;
      const profs = parseTsv(j.stdout, 'F');
      rules = parseTsv(j.stdout, 'R').map(([id, name, en, dir, action, proto, lport, rport, raddr, program, profiles, group, source, desc]) =>
        ({ id, name, enabled: en === '1', dir, action, proto, lport, rport, raddr, program, profiles, group, source, desc }));
      $('#fw-profiles').innerHTML = profs.map(([name, on, din, dout]) => `<span class="badge ${on === '1' ? 'ok' : 'bad'}">${esc(name)}: ${on === '1' ? 'on' : 'off'}</span>
        ${din ? `<span class="small muted">in: ${esc(din)} · out: ${esc(dout)}</span>` : ''}`).join(' ');
      $('#fw-status').textContent = isWin(a) ? 'Windows Defender Firewall' : ({ ufw: 'ufw', firewalld: 'firewalld', 'ufw-inactive': 'ufw (not enabled)', nftables: 'nftables (read-only)', iptables: 'iptables (read-only)', none: 'No firewall found' }[backend] || backend);
      $('#fw-new').disabled = !managed();
      if (!managed()) $('#fw-foot').textContent = a.platform === 'macos' ? 'macOS Application Firewall (read-only): it allows or blocks apps, not ports. Change it in System Preferences or with a script.' : 'Rule management needs ufw or firewalld on Linux.';
    } catch (err) { $('#fw-status').textContent = err.message; }
    draw();
  };
  ['fw-q', 'fw-dir', 'fw-show'].forEach((id) => $(`#${id}`).addEventListener('input', draw));
  $('#fw-refresh').addEventListener('click', guard(load));
  const save = async (task, args, msg) => { const j = await deviceTask(a.id, task, args); toast(msg || (j.stdout || 'Done').trim().split('\n').pop()); await load(); };
  $('#fw-new').addEventListener('click', () => fwRuleModal(a, null, guard(async (vals) => { await save('fw.create', vals); closeModal(); })));
  $('#fw-body').addEventListener('change', guard(async (e) => {
    const c = e.target.closest('[data-fw="toggle"]');
    if (!c) return;
    const r = rules[Number(c.closest('tr').dataset.i)];
    c.disabled = true;
    try { await save('fw.update', { id: r.id, enabled: c.checked }, `${c.checked ? 'Enabled' : 'Disabled'} "${r.name}"`); } catch (err) { c.checked = !c.checked; c.disabled = false; throw err; }
  }));
  $('#fw-body').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-fw]');
    if (!b || b.dataset.fw === 'toggle') return;
    const r = rules[Number(b.closest('tr').dataset.i)];
    if (b.dataset.fw === 'edit') fwRuleModal(a, r, guard(async (vals) => { await save('fw.update', { id: r.id, ...vals }); closeModal(); }));
    if (b.dataset.fw === 'delete' && await confirmDialog(`Delete the firewall rule "${r.name || r.id}" on ${a.hostname}?`, { okLabel: 'Delete', danger: true })) await save('fw.delete', { id: r.id });
  }));
  await load();
}

function fwRuleModal(a, r, onSubmit) {
  const win = isWin(a);
  const v = r || { name: '', dir: 'in', action: 'allow', proto: 'TCP', lport: '', rport: '', raddr: '', program: '', profiles: 'Any', enabled: true, desc: '' };
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([val, label]) => `<option value="${val}" ${String(cur).toLowerCase() === val ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  const anyBlank = (s) => (!s || String(s).toLowerCase() === 'any' ? '' : s);
  const profs = String(v.profiles || 'Any').toLowerCase();
  const m = openModal(r ? 'Edit firewall rule' : `New firewall rule on ${a.hostname}`, `<form id="fw-form">
    <div class="field"><label>Name</label><input type="text" name="name" required maxlength="200" value="${esc(v.name)}"></div>
    <div class="form-grid">
      <div class="field"><label>Direction</label>${sel('direction', [['in', 'Inbound (to this device)'], ['out', 'Outbound (from this device)']], v.dir)}</div>
      <div class="field"><label>Action</label>${sel('action', [['allow', 'Allow'], ['block', 'Block']], v.action)}</div>
      <div class="field"><label>Protocol</label>${sel('protocol', [['tcp', 'TCP'], ['udp', 'UDP'], ['any', 'Any'], ['icmpv4', 'ICMPv4 (ping)'], ['icmpv6', 'ICMPv6']], String(v.proto).toLowerCase())}</div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Local port(s)</label><input type="text" name="local_port" value="${esc(anyBlank(v.lport))}" placeholder="Any, or 443, 8000-8100, 80,443"></div>
      ${win ? `<div class="field"><label>Remote port(s)</label><input type="text" name="remote_port" value="${esc(anyBlank(v.rport))}" placeholder="Any"></div>` : ''}
    </div>
    <div class="field"><label>Remote address(es)</label><input type="text" name="remote_address" value="${esc(anyBlank(v.raddr))}" placeholder="Any, or 192.168.1.0/24, 10.0.0.5${win ? ', LocalSubnet' : ''}"></div>
    ${win ? `<div class="field"><label>Program (optional)</label><input type="text" name="program" value="${esc(v.program)}" placeholder="C:\\Program Files\\App\\app.exe"></div>
      <div class="field"><label>Profiles</label><div class="row">${['domain', 'private', 'public'].map((p) => `<label class="check"><input type="checkbox" name="prof_${p}" ${profs === 'any' || profs.includes(p) ? 'checked' : ''}> ${p[0].toUpperCase() + p.slice(1)}</label>`).join('')}</div></div>
      <div class="field"><label>Description (optional)</label><input type="text" name="description" maxlength="500" value="${esc(v.desc)}"></div>
      <label class="check"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}> Enabled</label>`
    : '<p class="small muted">On Linux the rule is added with ufw or firewalld. The name is stored as the rule comment (ufw).</p>'}
    </form>`, { foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="fw-form">${r ? 'Save changes' : 'Create rule'}</button>` });
  $('#fw-form', m).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const val = (n) => f.namedItem(n)?.value.trim() ?? '';
    const vals = { name: val('name'), direction: val('direction'), action: val('action'), protocol: val('protocol'), local_port: val('local_port') || 'any', remote_address: val('remote_address') || 'any' };
    if (win) {
      const ps = ['domain', 'private', 'public'].filter((p) => f.namedItem(`prof_${p}`).checked);
      if (!ps.length) { toast('Pick at least one profile', 'error'); return; }
      Object.assign(vals, { remote_port: val('remote_port') || 'any', program: val('program'), profile: ps.length === 3 ? 'any' : ps.join(','), description: val('description'), enabled: f.namedItem('enabled').checked });
    }
    onSubmit(vals);
  });
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
      <div class="field"><label>Extra services to monitor on this device</label><input type="text" name="watch_services" value="${esc(a.watch_services || '')}" placeholder="${a.platform === 'windows' ? 'e.g. MSSQLSERVER, W3SVC' : 'e.g. nginx, postgresql'}">
        <div class="small muted">Comma separated service names. You get an alert when one stops. Services for all devices are set in Settings.</div></div>
      <button class="btn primary">Save</button></form>
    <div class="card"><h2>Agent</h2>
      <p class="small muted">Installed version <span class="mono">${esc(a.agent_version) || '—'}</span>${a.update_pending ? ' · a newer version is available (it installs automatically)' : ' · up to date'}.
      "Update agent now" makes the agent download the latest version${a.platform === 'windows' ? ', runner and taskbar icon' : ''} and restart, even if it looks up to date.
      ${a.online ? '' : 'The device is offline, so the update runs when it reconnects.'}</p>
      <button class="btn" data-action="update-agent" data-id="${a.id}">Update agent now</button></div>
    ${can('admin') ? `<div class="card"><h2>Danger zone</h2>
      <p class="small muted">Uninstall removes the agent from the host the next time it checks in, then you can remove the device record.</p>
      <div class="row"><button class="btn danger" data-action="uninstall-agent" data-id="${a.id}">Uninstall agent</button>
      <button class="btn danger solid" data-action="delete-agent" data-id="${a.id}">Remove device record</button></div></div>` : ''}
  </div>`;
  $('#dev-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('PUT', `/api/agents/${a.id}`, { client_id: f.get('client_id') || null, notes: f.get('notes'), maintenance: f.get('maintenance') === 'on', watch_services: f.get('watch_services') });
    toast('Device saved');
    router();
  }));
}

// ---------------- run-script modal ----------------
async function openRunModal(agentIds) {
  const [scripts, agents] = await Promise.all([api('GET', '/api/scripts'), api('GET', '/api/agents')]);
  const targets = agents.filter((a) => agentIds.includes(a.id));
  const platforms = new Set(targets.map((t) => t.platform));
  const compatible = (shell) => (SHELL_OS[shell] || []).some((p) => platforms.has(p));
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
    macos: `curl -fsSL '${server}/install/macos?token=${token}' | sudo bash`,
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
        <div class="row field">
          <a class="btn primary" href="${esc(dlUrl(c.server_url, latest.token, 'HostPilot-Installer.pkg'))}">⬇ macOS installer (.pkg)</a>
          <button class="btn sm" data-action="copy" data-text="${esc(dlUrl(c.server_url, latest.token, 'HostPilot-Installer.pkg'))}">Copy link</button>
          <span style="width:12px"></span>
          <a class="btn" href="${esc(dlUrl(c.server_url, latest.token, 'hostpilot-install-macos.sh'))}">⬇ macOS install script (.sh)</a>
          <button class="btn sm" data-action="copy" data-text="${esc(dlUrl(c.server_url, latest.token, 'hostpilot-install-macos.sh'))}">Copy link</button>
        </div>
        <p class="small muted">Email the link to the client. Windows: double-click the .exe and approve the admin prompt. It isn't code-signed, so SmartScreen may warn
          ("More info → Run anyway"); <code>HostPilot-Setup.exe /quiet</code> installs silently (e.g. via GPO/Intune). Linux: <code>sudo bash hostpilot-install.sh</code>. macOS (10.15 Catalina or newer): open the .pkg; it isn't signed, so the first time right-click it → <strong>Open</strong> → Open (or System Preferences → Security &amp; Privacy → Open Anyway). Silent: <code>sudo installer -pkg HostPilot-Installer.pkg -target /</code>.
          Links stop working when the token expires or is revoked.</p>
        <h3>Or use a one-line command</h3>
        <label>Windows: elevated PowerShell (Windows 10 / Server 2016 or newer)</label>
        <div class="copybox field"><code>${esc(cmds.windows)}</code><button class="btn" data-action="copy" data-text="${esc(cmds.windows)}">Copy</button></div>
        <label>Linux: any systemd distro, as root</label>
        <div class="copybox field"><code>${esc(cmds.linux)}</code><button class="btn" data-action="copy" data-text="${esc(cmds.linux)}">Copy</button></div>
        <label>macOS: Terminal (10.15 Catalina or newer)</label>
        <div class="copybox field"><code>${esc(cmds.macos)}</code><button class="btn" data-action="copy" data-text="${esc(cmds.macos)}">Copy</button></div>
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
      <select id="sc-os"><option value="">All platforms</option><option value="windows">Windows</option><option value="linux">Linux</option><option value="macos">macOS</option></select></div>
    <div id="sc-list"></div>`;
  const draw = () => {
    const q = $('#sc-q').value.toLowerCase();
    const os = $('#sc-os').value;
    const vis = scripts.filter((s) => (!q || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q)) && (!os || (SHELL_OS[s.shell] || []).includes(os)));
    $('#sc-list').innerHTML = cats.map((cat) => {
      const rows = vis.filter((s) => s.category === cat);
      if (!rows.length) return '';
      return `<h3 style="margin-top:18px">${esc(cat)}</h3><div class="card flush"><div class="table-wrap"><table><tbody>
        ${rows.map((s) => `<tr class="clickable" data-href="#/scripts/${s.id}"><td style="width:34%"><strong>${esc(s.name)}</strong></td>
          <td><span class="os">${shellIcon(s.shell)}${esc(s.shell)}</span></td><td class="small muted">${esc(s.description)}</td><td class="small nowrap">${s.timeout}s</td></tr>`).join('')}
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
      <div class="field"><label>Taskbar / tray icon (Windows and Linux desktops)</label><select name="tray_icon" style="width:auto">
        <option value="1" ${s.tray_icon ? 'selected' : ''}>Show the HostPilot status icon to logged-in users</option>
        <option value="0" ${s.tray_icon ? '' : 'selected'}>Hidden (removed from devices on their next check-in)</option></select></div>
      <div class="form-grid">
        <div class="field"><label>Services monitored on all Windows devices</label><input type="text" name="watch_services_windows" value="${esc(s.watch_services_windows)}" placeholder="e.g. Spooler, WinDefend"></div>
        <div class="field"><label>Services monitored on all Linux devices</label><input type="text" name="watch_services_linux" value="${esc(s.watch_services_linux)}" placeholder="e.g. sshd, cron"></div>
        <div class="field"><label>Services monitored on all Macs (launchd labels)</label><input type="text" name="watch_services_macos" value="${esc(s.watch_services_macos)}" placeholder="e.g. com.openssh.sshd"></div></div>
      <div class="small muted" style="margin:-6px 0 12px">Comma separated service names. A critical alert opens when one stops and resolves when it runs again.</div>
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
  logout: async () => {
    try { window.HostPilotApp?.signedOut(); } catch { /* older app */ }
    await api('POST', '/api/logout'); state.user = null; renderLogin();
  },
  'app-settings': () => { try { window.HostPilotApp?.openSettings(); } catch { /* older app */ } },
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
  'open-drive': (el) => {
    if (!state.files) state.files = new Map();
    state.files.set(el.dataset.id, { path: el.dataset.path });
    location.hash = `#/devices/${el.dataset.id}/files`;
  },
  'update-agent': async (el) => {
    const r = await api('POST', `/api/agents/${el.dataset.id}/update-agent`);
    toast('Agent update queued. The device restarts its agent and reconnects within a minute.');
    if (r.jobs?.[0]) openJobModal(r.jobs[0].id);
  },
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
window.addEventListener('hashchange', () => { $('#sidebar')?.classList.remove('open'); router(); });

// Phones: tables become stacked cards (see table.rtable in styles.css). Label every cell with its column
// header, so any table rendered anywhere in the app works without per-table markup.
function labelTables(root) {
  for (const table of root.querySelectorAll('table')) {
    const ths = table.tHead ? [...table.tHead.rows[0]?.cells || []] : [];
    if (!ths.length) continue;
    table.classList.add('rtable');
    const names = ths.map((th) => th.textContent.trim());
    for (const tr of table.tBodies[0]?.rows || []) {
      let col = 0;
      for (const td of tr.cells) {
        if (!td.hasAttribute('data-label') && !td.classList.contains('empty')) td.setAttribute('data-label', names[col] || '');
        col += td.colSpan || 1;
      }
    }
  }
}
let labelQueued = false;
new MutationObserver(() => {
  if (labelQueued) return;
  labelQueued = true;
  requestAnimationFrame(() => { labelQueued = false; labelTables(document.body); });
}).observe(document.body, { childList: true, subtree: true });

// ---------------- boot ----------------
(async () => {
  try {
    state.user = await api('GET', '/api/me');
    renderShell();
    router();
  } catch { if (!state.user) renderLogin(); }
})();
