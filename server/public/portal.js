// HostPilot end-user support portal: sign in with the email your IT provider registered, see your devices,
// open tickets and follow up on them.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}
const STATUS = { new: ['Received', 'info'], open: ['In progress', 'warn'], pending: ['Waiting for your reply', 'info'], resolved: ['Solved', 'ok'], closed: ['Closed', ''] };
const badge = (s, cls = '') => `<span class="badge ${cls}">${esc(s)}</span>`;
const status = (s) => badge(...(STATUS[s] || [s, '']));

async function api(method, path, body) {
  const opts = { method, headers: { 'X-HostPilot': '1' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/portal/login') { me = null; login(); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), 4500);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e.message !== 'Signed out') toast(e.message, 'error'); } };

let me = null;

function login(error = '') {
  $('#root').innerHTML = `<div class="login-wrap"><form class="card login" id="lf">
    <div class="brand"><img src="/favicon.svg" alt="">IT Support</div>
    <p class="small muted">Sign in to see your computers and support tickets.</p>
    <div class="field"><label for="le">Email</label><input id="le" name="email" type="email" autocomplete="username" required autofocus></div>
    <div class="field"><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>
    <div class="error-text">${esc(error)}</div>
    <button class="btn primary" style="width:100%;justify-content:center">Sign in</button>
    <p class="small muted" style="margin-top:12px">No password yet? Ask your IT provider to give you access to the support portal.</p></form></div>`;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('POST', '/api/portal/login', { email: f.get('email'), password: f.get('password') }); boot(); }
    catch (err) { login(err.message); }
  });
}

function shell() {
  $('#root').innerHTML = `<div class="portal-wrap">
    <header class="portal-top"><div class="brand"><img src="/favicon.svg" alt="">IT Support<span class="muted small"> · ${esc(me.client_name || '')}</span></div>
      <div class="row"><span class="small muted hide-sm">${esc(me.name)}</span><button class="btn sm" id="p-pw">Password</button><button class="btn sm" id="p-out">Sign out</button></div></header>
    <nav class="tabs"><a href="#/">My tickets</a><a href="#/new">New request</a><a href="#/devices">${me.all ? 'Our devices' : 'My devices'}</a></nav>
    <main id="view"></main></div>`;
  $('#p-out').addEventListener('click', guard(async () => { await api('POST', '/api/portal/logout'); me = null; login(); }));
  $('#p-pw').addEventListener('click', () => { location.hash = '#/password'; });
}

async function route() {
  if (!me) return;
  const h = location.hash || '#/';
  document.querySelectorAll('.portal-wrap .tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === h || (h.startsWith('#/t/') && a.getAttribute('href') === '#/')));
  const v = $('#view');
  v.innerHTML = '<div class="muted">Loading…</div>';
  try {
    let m;
    if (h === '#/new') await newTicket(v);
    else if (h === '#/devices') await devices(v);
    else if (h === '#/password') password(v);
    else if ((m = /^#\/t\/(\d+)$/.exec(h))) await ticket(v, m[1]);
    else await tickets(v);
  } catch (e) { if (e.message !== 'Signed out') v.innerHTML = `<div class="card">Error: ${esc(e.message)}</div>`; }
}

async function tickets(v, all = false) {
  const list = await api('GET', `/api/portal/tickets${all ? '?status=all' : ''}`);
  v.innerHTML = `<div class="page-head"><h1>${all ? 'All tickets' : 'Open tickets'}</h1><div class="row"><button class="btn sm" id="t-all">${all ? 'Show open only' : 'Show solved too'}</button><a class="btn primary" href="#/new">+ New request</a></div></div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>#</th><th>Subject</th>${me.all ? '<th>From</th>' : ''}<th>Status</th><th>Updated</th></tr></thead><tbody>
    ${list.map((t) => `<tr class="clickable" data-t="${t.id}"><td class="mono small">#${t.id}</td><td><strong>${esc(t.subject)}</strong>${t.hostname ? `<div class="small muted">${esc(t.hostname)}</div>` : ''}</td>
      ${me.all ? `<td class="small">${esc(t.contact_name || '')}</td>` : ''}<td>${status(t.status)}</td><td class="small nowrap">${fmtAgo(t.updated_at)}</td></tr>`).join('')
      || `<tr><td colspan="5" class="empty">${all ? 'No tickets yet.' : 'Nothing open. Need help? Start a new request.'}</td></tr>`}</tbody></table></div></div>`;
  $('#t-all').addEventListener('click', guard(() => tickets(v, !all)));
  v.querySelectorAll('[data-t]').forEach((r) => r.addEventListener('click', () => { location.hash = `#/t/${r.dataset.t}`; }));
}

async function newTicket(v) {
  const devs = await api('GET', '/api/portal/devices');
  v.innerHTML = `<div class="page-head"><h1>New support request</h1></div><form class="card" id="nt" style="max-width:720px">
    <div class="field"><label>What do you need help with?</label><input type="text" name="subject" required maxlength="200" placeholder="e.g. The printer on the 2nd floor doesn't print"></div>
    ${devs.length ? `<div class="field"><label>Which computer? (optional)</label><select name="agent_id"><option value="">— not about a specific computer —</option>${devs.map((d) => `<option value="${esc(d.id)}">${esc(d.hostname)}${d.logged_user ? ` (${esc(d.logged_user)})` : ''}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label>Describe the problem</label><textarea name="body" rows="7" required maxlength="20000" placeholder="What happens, since when, any error messages…"></textarea></div>
    <label class="check"><input type="checkbox" name="urgent"> It's urgent: I can't work</label>
    <div class="row" style="margin-top:12px"><button class="btn primary">Send request</button><a class="btn" href="#/">Cancel</a></div></form>`;
  $('#nt').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const t = await api('POST', '/api/portal/tickets', { subject: f.get('subject'), body: f.get('body'), agent_id: f.get('agent_id') || null, urgent: !!f.get('urgent') });
    toast(`Request #${t.id} sent. We'll get back to you.`); location.hash = `#/t/${t.id}`;
  }));
}

async function ticket(v, id) {
  const t = await api('GET', `/api/portal/tickets/${id}`);
  const closed = t.status === 'closed';
  v.innerHTML = `<div class="page-head"><div><div class="small"><a href="#/">← My tickets</a></div><h1>#${t.id} ${esc(t.subject)}</h1>
      <div class="small muted" style="margin-top:4px">${status(t.status)} · opened ${fmtDate(t.created_at)}${t.hostname ? ` · ${esc(t.hostname)}` : ''}</div></div>
      ${['resolved', 'closed'].includes(t.status) ? '' : '<button class="btn" id="t-solve">✓ My problem is solved</button>'}</div>
    <div class="card" style="max-width:860px"><div class="tk-thread" style="max-height:none">${t.thread.map((m) => `<div class="tk-msg ${m.mine ? 'contact' : 'tech'}">
        <div class="tk-meta"><strong>${esc(m.mine ? 'You' : m.author)}</strong><span class="muted small" title="${fmtDate(m.created_at)}">${fmtAgo(m.created_at)}</span></div>
        <div style="white-space:pre-wrap">${esc(m.body)}</div></div>`).join('') || '<div class="muted">No messages yet.</div>'}</div>
      ${closed ? '<p class="muted small">This ticket is closed. Start a new request if you still need help.</p>' : `<form id="rp" class="tk-reply"><textarea name="body" rows="4" required maxlength="20000" placeholder="Write a reply…"></textarea>
        <div class="row"><button class="btn primary">Send reply</button></div></form>`}</div>`;
  $('#rp')?.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('POST', `/api/portal/tickets/${t.id}/comments`, { body: new FormData(e.target).get('body') });
    toast('Reply sent'); route();
  }));
  $('#t-solve')?.addEventListener('click', guard(async () => { await api('POST', `/api/portal/tickets/${t.id}/resolve`); toast('Thanks! Marked as solved.'); route(); }));
}

async function devices(v) {
  const list = await api('GET', '/api/portal/devices');
  v.innerHTML = `<div class="page-head"><h1>${me.all ? 'Our devices' : 'My devices'}</h1></div>
    <div class="portal-devs">${list.map((d) => `<div class="card"><div class="row" style="justify-content:space-between"><strong>${esc(d.hostname)}</strong>${d.online ? badge('online', 'ok') : badge(`offline · ${fmtAgo(d.last_seen)}`, '')}</div>
      <dl class="kv" style="margin-top:8px"><dt>System</dt><dd>${esc(d.os_name || d.platform)}</dd>${d.model ? `<dt>Model</dt><dd>${esc(d.model)}</dd>` : ''}${d.serial ? `<dt>Serial</dt><dd class="mono">${esc(d.serial)}</dd>` : ''}
        ${d.logged_user ? `<dt>Signed in</dt><dd>${esc(d.logged_user)}</dd>` : ''}${d.warranty_end ? `<dt>Warranty until</dt><dd>${esc(d.warranty_end)}</dd>` : ''}
        <dt>Updates</dt><dd>${d.reboot_required ? badge('restart needed', 'warn') : d.pending_updates ? `${d.pending_updates} waiting to install` : 'up to date'}</dd>
        ${d.disk_free.length ? `<dt>Disks</dt><dd>${d.disk_free.map((x) => `${esc(x.mount)} ${x.pct}% full`).join(', ')}</dd>` : ''}</dl>
      <a class="btn sm" style="margin-top:10px" href="#/new" data-dev="${esc(d.id)}">Get help with this computer</a></div>`).join('') || '<div class="card muted">No devices are linked to your account yet.</div>'}</div>`;
  v.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => {
    setTimeout(() => { const s = document.querySelector('select[name=agent_id]'); if (s) s.value = b.dataset.dev; }, 300);
  }));
}

function password(v) {
  v.innerHTML = `<div class="page-head"><h1>Change password</h1></div><form class="card" id="pw" style="max-width:480px">
    <div class="field"><label>Current password</label><input type="password" name="current" autocomplete="current-password" required></div>
    <div class="field"><label>New password (at least 10 characters)</label><input type="password" name="password" minlength="10" autocomplete="new-password" required></div>
    <button class="btn primary">Save</button></form>`;
  $('#pw').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('POST', '/api/portal/password', { current: f.get('current'), password: f.get('password') });
    toast('Password changed'); location.hash = '#/';
  }));
}

async function boot() {
  try { me = await api('GET', '/api/portal/me'); }
  catch (e) { if (e.message !== 'Signed out') { $('#root').innerHTML = `<div class="login-wrap"><div class="card login">${esc(e.message)}</div></div>`; } return; }
  shell(); route();
}
window.addEventListener('hashchange', route);
boot();
