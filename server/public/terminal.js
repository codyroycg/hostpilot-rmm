// HostPilot RMM terminal viewer (Linux devices)
const $ = (s) => document.querySelector(s);
// #<agent id>[/cmd|/powershell]
const [agentId, shellName = ''] = decodeURIComponent(location.hash.slice(1)).split('/');
const SHELL_LABEL = { cmd: 'Command Prompt', powershell: 'PowerShell' };
const overlay = $('#t-overlay');
let ws = null;
let connected = false;

const term = new window.Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace',
  fontSize: 14,
  scrollback: 5000,
  theme: { background: '#0b0f14', foreground: '#e2e8f0', cursor: '#93c5fd', selectionBackground: '#334155' },
});
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('#t-term'));
fit.fit();

function setStatus(text, cls = 'info', overlayText = null) {
  const b = $('#t-status');
  b.textContent = text;
  b.className = `badge ${cls}`;
  overlay.textContent = overlayText || '';
  overlay.classList.toggle('hidden', !overlayText);
}

const send = (m) => { if (ws && ws.readyState === 1) ws.send(m); };
const enc = new TextEncoder();
function sendInput(data) {
  if (!connected) return;
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  // chunk to keep each line reasonable (pastes)
  for (let i = 0; i < bytes.length; i += 3000) {
    let s = '';
    for (const b of bytes.subarray(i, i + 3000)) s += String.fromCharCode(b);
    send(`d ${btoa(s)}`);
  }
}
const sendSize = () => send(`r ${term.rows} ${term.cols}`);

// extra-keys bar for phones: Esc, Tab, arrows, and a sticky Ctrl for the next key typed
let ctrlArmed = false;
const KEYS = { esc: '\x1b', tab: '\t', ctrlc: '\x03', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', pipe: '|', slash: '/', tilde: '~' };
$('#t-keys').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]');
  if (!b) return;
  if (b.dataset.k === 'ctrl') { ctrlArmed = !ctrlArmed; b.classList.toggle('primary', ctrlArmed); }
  else sendInput(KEYS[b.dataset.k]);
  term.focus();
});
term.onData((d) => {
  if (ctrlArmed && d.length === 1 && /[a-z@\[\\\]^_ ]/i.test(d)) {
    ctrlArmed = false;
    $('#t-ctrl').classList.remove('primary');
    sendInput(String.fromCharCode(d.toUpperCase().charCodeAt(0) & 0x1f));
    return;
  }
  sendInput(d);
});
term.onBinary((d) => sendInput(Uint8Array.from(d, (c) => c.charCodeAt(0))));
window.addEventListener('resize', () => { fit.fit(); sendSize(); });
// phones: the on-screen keyboard shrinks the visual viewport; refit so the prompt stays visible
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { fit.fit(); sendSize(); });

async function start() {
  if (!agentId) { setStatus('error', 'bad', 'No device specified.'); return; }
  try {
    const r0 = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
    if (!r0.ok) throw new Error(r0.status === 401 ? 'Please sign in to HostPilot first.' : 'Device not found.');
    const a = await r0.json();
    const label = a.platform === 'windows' ? SHELL_LABEL[shellName] || 'PowerShell' : 'Terminal';
    $('#t-host').textContent = a.hostname;
    $('#t-kind').textContent = a.platform === 'windows' ? `${label} · SYSTEM · hidden from the user` : 'root shell';
    document.title = `${a.hostname} · ${label}`;
    const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/terminal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shell: shellName || 'powershell' }) });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || 'Could not start terminal');
    connect(s);
  } catch (e) {
    setStatus('error', 'bad', e.message);
  }
}

function connect({ session, token }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/terminal?session=${session}&token=${token}`);
  ws.binaryType = 'arraybuffer';
  setStatus('waiting', 'info', 'Waiting for the device to open a shell…');
  ws.onopen = () => sendSize(); // queued server-side until the device connects
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { term.write(new Uint8Array(ev.data)); return; }
    const m = JSON.parse(ev.data);
    if (m.t !== 'status') return;
    if (m.state === 'connected') {
      connected = true;
      setStatus('connected', 'ok', null);
      fit.fit(); sendSize();
      term.focus();
    } else if (m.state === 'ended') {
      connected = false;
      setStatus('ended', 'bad', m.message || 'Session ended.');
    }
  };
  ws.onclose = () => {
    if (connected) setStatus('disconnected', 'bad', 'Disconnected.');
    else if (!overlay.textContent || overlay.textContent.startsWith('Waiting')) setStatus('disconnected', 'bad', 'Could not connect to the device.');
    connected = false;
  };
}

$('#t-paste').addEventListener('click', async () => {
  try { sendInput(await navigator.clipboard.readText()); }
  catch { term.write('\r\n[Clipboard access was blocked by the browser. Use Ctrl+Shift+V / right-click paste instead.]\r\n'); }
  term.focus();
});
$('#t-fs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => setTimeout(() => { fit.fit(); sendSize(); }, 80));
$('#t-end').addEventListener('click', () => {
  if (ws) ws.close();
  connected = false;
  setStatus('ended', 'bad', 'You ended the session. You can close this tab.');
});
window.addEventListener('beforeunload', () => { if (ws) ws.close(); });

start();
