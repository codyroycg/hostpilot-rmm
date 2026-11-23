// HostPilot RMM remote-control viewer
const $ = (s) => document.querySelector(s);
const agentId = decodeURIComponent(location.hash.slice(1));
const canvas = $('#r-canvas');
const ctx = canvas.getContext('2d');
const overlay = $('#r-overlay');
let ws = null;
let connected = false;
let fit = true;
let drawChain = Promise.resolve();
let bytes = 0, frames = 0;
const pressed = new Set();

// KeyboardEvent.code -> Windows virtual-key code
const VK = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163,
  AltLeft: 164, AltRight: 165, Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44, Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 92,
  ContextMenu: 93, NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
  NumLock: 144, ScrollLock: 145, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
  BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226,
};
for (let i = 0; i < 26; i++) VK[`Key${String.fromCharCode(65 + i)}`] = 65 + i;
for (let i = 0; i < 10; i++) { VK[`Digit${i}`] = 48 + i; VK[`Numpad${i}`] = 96 + i; }
for (let i = 1; i <= 24; i++) VK[`F${i}`] = 111 + i;

function setStatus(text, cls = 'info', overlayText = null) {
  const b = $('#r-status');
  b.textContent = text;
  b.className = `badge ${cls}`;
  overlay.textContent = overlayText || '';
  overlay.classList.toggle('hidden', !overlayText);
}

const send = (msg) => { if (ws && ws.readyState === 1 && connected) ws.send(msg); };

async function start() {
  if (!agentId) { setStatus('error', 'bad', 'No device specified.'); return; }
  try {
    const a = await fetch(`/api/agents/${encodeURIComponent(agentId)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 401 ? 'Please sign in to HostPilot first.' : 'Device not found.'))));
    $('#r-host').textContent = a.hostname;
    document.title = `${a.hostname} · Remote control`;
    if (!a.online) setStatus('offline', 'warn', 'This device appears to be offline. Trying anyway…');
    const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/remote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || 'Could not start session');
    connect(s);
  } catch (e) {
    setStatus('error', 'bad', e.message);
  }
}

function connect({ session, token }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/remote?role=viewer&session=${session}&token=${token}`);
  ws.binaryType = 'arraybuffer';
  setStatus('waiting', 'info', 'Waiting for the device to start the remote session…');
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      bytes += ev.data.byteLength;
      const buf = ev.data;
      drawChain = drawChain.then(() => drawBatch(buf)).catch(() => {}).then(() => send('ack'));
      return;
    }
    const m = JSON.parse(ev.data);
    if (m.t === 'status') {
      if (m.state === 'connected') {
        connected = true;
        setStatus('connected', 'ok', null);
        const q = localStorage.getItem('hp-remote-quality');
        if (q) $('#r-quality').value = q;
        send(`q ${$('#r-quality').value}`);
        canvas.focus();
      } else if (m.state === 'waiting') {
        setStatus('waiting', 'info', 'Waiting for the device to start the remote session…');
      } else if (m.state === 'ended') {
        connected = false;
        setStatus('ended', 'bad', m.message || 'Session ended.');
      }
    } else if (m.t === 'info') {
      canvas.width = m.w;
      canvas.height = m.h;
      layout();
      $('#r-stats').dataset.desktop = m.desktop === 'Winlogon' ? 'secure desktop' : '';
    }
  };
  ws.onclose = () => {
    if (connected) setStatus('disconnected', 'bad', 'Disconnected.');
    else if (!overlay.textContent || overlay.textContent.startsWith('Waiting')) setStatus('disconnected', 'bad', 'Could not connect to the device.');
    connected = false;
  };
}

async function drawBatch(buf) {
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 2) return;
  const parts = [];
  let off = 1;
  while (off + 12 <= buf.byteLength) {
    const x = dv.getUint16(off, true), y = dv.getUint16(off + 2, true);
    const len = dv.getUint32(off + 8, true);
    off += 12;
    parts.push({ x, y, blob: new Blob([new Uint8Array(buf, off, len)], { type: 'image/jpeg' }) });
    off += len;
  }
  const bitmaps = await Promise.all(parts.map((p) => createImageBitmap(p.blob)));
  bitmaps.forEach((bm, i) => { ctx.drawImage(bm, parts[i].x, parts[i].y); bm.close(); });
  frames++;
}

setInterval(() => {
  const desk = $('#r-stats').dataset.desktop;
  $('#r-stats').textContent = connected ? `${frames} fps · ${(bytes / 1024).toFixed(0)} KB/s${desk ? ` · ${desk}` : ''}` : '';
  bytes = 0; frames = 0;
}, 1000);

// ---------- layout ----------
function layout() {
  const stage = $('#r-stage');
  if (!canvas.width) return;
  if (fit) {
    const s = Math.min(stage.clientWidth / canvas.width, stage.clientHeight / canvas.height);
    canvas.style.width = `${Math.floor(canvas.width * s)}px`;
    canvas.style.height = `${Math.floor(canvas.height * s)}px`;
  } else {
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
  }
  stage.classList.toggle('scroll', !fit);
}
window.addEventListener('resize', layout);

// ---------- mouse ----------
function norm(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return `${x.toFixed(5)} ${y.toFixed(5)}`;
}
let pendingMove = null;
canvas.addEventListener('mousemove', (e) => {
  if (!pendingMove) requestAnimationFrame(() => { send(`mm ${pendingMove}`); pendingMove = null; });
  pendingMove = norm(e);
});
canvas.addEventListener('mousedown', (e) => { e.preventDefault(); canvas.focus(); send(`md ${e.button} ${norm(e)}`); });
canvas.addEventListener('mouseup', (e) => { e.preventDefault(); send(`mu ${e.button} ${norm(e)}`); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
let wheelAcc = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  if (Math.abs(wheelAcc) >= 50) { send(`wh ${wheelAcc > 0 ? -120 : 120}`); wheelAcc = 0; }
}, { passive: false });

// ---------- touch (phones/tablets) ----------
// tap = left click, long-press = right click, drag = left-button drag, two fingers = scroll wheel
let touch = null;
const LONG_PRESS = 550;
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length >= 2) {
    if (touch) { clearTimeout(touch.timer); if (touch.down) send(`mu 0 ${touch.pos}`); }
    touch = { two: true, y: (e.touches[0].clientY + e.touches[1].clientY) / 2, acc: 0 };
    return;
  }
  const t = e.touches[0];
  const pos = norm(t);
  touch = { x: t.clientX, y: t.clientY, pos, moved: false, down: false, long: false };
  send(`mm ${pos}`);
  touch.timer = setTimeout(() => {
    if (touch && !touch.moved && !touch.two) { touch.long = true; send(`md 2 ${pos}`); send(`mu 2 ${pos}`); if (navigator.vibrate) navigator.vibrate(15); }
  }, LONG_PRESS);
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!touch) return;
  if (touch.two) {
    if (e.touches.length < 2) return;
    const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    touch.acc += touch.y - y; // fingers moving up scrolls the content down
    touch.y = y;
    while (Math.abs(touch.acc) >= 40) { send(`wh ${touch.acc > 0 ? -120 : 120}`); touch.acc -= Math.sign(touch.acc) * 40; }
    return;
  }
  const t = e.touches[0];
  if (!touch.moved && Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 8) {
    touch.moved = true;
    clearTimeout(touch.timer);
    if (!touch.long) { send(`md 0 ${touch.pos}`); touch.down = true; }
  }
  if (touch.moved) { touch.pos = norm(t); send(`mm ${touch.pos}`); }
}, { passive: false });
const touchEnd = (e) => {
  e.preventDefault();
  if (!touch || e.touches.length) return; // wait until every finger is up
  clearTimeout(touch.timer);
  if (!touch.two) {
    if (touch.down) send(`mu 0 ${touch.pos}`);
    else if (!touch.long) { send(`md 0 ${touch.pos}`); send(`mu 0 ${touch.pos}`); }
  }
  touch = null;
};
canvas.addEventListener('touchend', touchEnd, { passive: false });
canvas.addEventListener('touchcancel', touchEnd, { passive: false });

// On-screen keyboard: a hidden text field receives the phone keyboard's input.
const kbd = $('#r-kbd');
const tapKey = (vk) => { send(`kd ${vk}`); send(`ku ${vk}`); };
$('#r-kbd-btn').addEventListener('click', () => { kbd.value = ''; kbd.focus(); });
kbd.addEventListener('beforeinput', (e) => {
  e.preventDefault();
  if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText' || e.inputType === 'insertReplacementText') {
    if (e.data) send(`type ${btoa(String.fromCharCode(...new TextEncoder().encode(e.data)))}`);
  } else if (e.inputType === 'deleteContentBackward') tapKey(8);
  else if (e.inputType === 'deleteContentForward') tapKey(46);
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') tapKey(13);
});
kbd.addEventListener('keydown', (e) => {
  // keys that don't produce text (Android reports printable keys as keyCode 229, handled by beforeinput)
  const vk = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }[e.key];
  if (vk) { e.preventDefault(); tapKey(vk); }
});

// ---------- keyboard ----------
canvas.addEventListener('keydown', (e) => {
  const vk = VK[e.code];
  if (!vk) return;
  e.preventDefault();
  pressed.add(vk);
  send(`kd ${vk}`);
});
canvas.addEventListener('keyup', (e) => {
  const vk = VK[e.code];
  if (!vk) return;
  e.preventDefault();
  pressed.delete(vk);
  send(`ku ${vk}`);
});
function releaseAll() { for (const vk of pressed) send(`ku ${vk}`); pressed.clear(); }
canvas.addEventListener('blur', releaseAll);
window.addEventListener('blur', releaseAll);

// ---------- toolbar ----------
$('#r-quality').addEventListener('change', (e) => {
  try { localStorage.setItem('hp-remote-quality', e.target.value); } catch { /* storage unavailable */ }
  send(`q ${e.target.value}`);
  canvas.focus();
});
$('#r-keys').addEventListener('change', (e) => {
  const keys = e.target.value.split(',').filter(Boolean).map(Number);
  keys.forEach((k) => send(`kd ${k}`));
  [...keys].reverse().forEach((k) => send(`ku ${k}`));
  e.target.value = '';
  canvas.focus();
});
$('#r-fit').addEventListener('click', (e) => { fit = !fit; e.target.textContent = fit ? 'Actual size' : 'Fit to window'; layout(); });
$('#r-fs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => setTimeout(layout, 50));
$('#r-end').addEventListener('click', () => {
  releaseAll();
  if (ws) ws.close();
  connected = false;
  setStatus('ended', 'bad', 'You ended the session. You can close this tab.');
});
$('#r-type').addEventListener('click', () => { $('#r-type-panel').classList.remove('hidden'); $('#r-type-text').focus(); });
$('#r-type-cancel').addEventListener('click', () => { $('#r-type-panel').classList.add('hidden'); canvas.focus(); });
$('#r-type-send').addEventListener('click', () => {
  const text = $('#r-type-text').value;
  if (text) {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    send(`type ${b64}`);
  }
  $('#r-type-text').value = '';
  $('#r-type-panel').classList.add('hidden');
  canvas.focus();
});
window.addEventListener('beforeunload', () => { releaseAll(); if (ws) ws.close(); });

start();
