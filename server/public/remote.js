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
        drawPointer();
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
  if (typeof applyView === 'function') applyView();
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
// Two modes (toolbar "Touch" selector, remembered per browser):
//  trackpad (default): the screen works like a laptop touchpad. Slide one finger to move the pointer,
//    tap = click, double-tap and hold then slide = drag, long-press or two-finger tap = right-click,
//    two fingers = scroll, pinch = zoom (the view follows the pointer).
//  direct: tap exactly where you touch; slide = drag; long-press = right-click; two fingers = scroll / pinch zoom.
const LONG_PRESS = 550, TAP_MS = 250, DOUBLE_TAP_MS = 300, MOVE_SLOP = 8, SPEED = 1.6;
let touchMode = 'trackpad';
try { touchMode = localStorage.getItem('hp-remote-touch') || 'trackpad'; } catch { /* storage unavailable */ }
const cur = { x: 0.5, y: 0.5 };           // remote pointer position (0..1)
const view = { zoom: 1, tx: 0, ty: 0 };   // pinch zoom + pan
const pointerEl = $('#r-pointer');
const posStr = () => `${cur.x.toFixed(5)} ${cur.y.toFixed(5)}`;
let touch = null, lastTapEnd = 0;

function moveCursor(nx, ny) {
  cur.x = Math.min(1, Math.max(0, nx));
  cur.y = Math.min(1, Math.max(0, ny));
  send(`mm ${posStr()}`);
  followCursor();
  drawPointer();
}
function drawPointer() {
  const show = touchMode === 'trackpad' && canvas.width && connected;
  pointerEl.classList.toggle('hidden', !show);
  if (!show) return;
  const r = canvas.getBoundingClientRect(), s = $('#r-stage').getBoundingClientRect();
  pointerEl.style.transform = `translate(${r.left - s.left + cur.x * r.width}px, ${r.top - s.top + cur.y * r.height}px)`;
}
// keep the pointer inside the visible part of the stage while zoomed in
function followCursor() {
  if (view.zoom <= 1) return;
  const s = $('#r-stage').getBoundingClientRect(), r = canvas.getBoundingClientRect();
  const px = r.left + cur.x * r.width, py = r.top + cur.y * r.height, m = 50;
  if (px < s.left + m) view.tx += s.left + m - px; else if (px > s.right - m) view.tx -= px - (s.right - m);
  if (py < s.top + m) view.ty += s.top + m - py; else if (py > s.bottom - m) view.ty -= py - (s.bottom - m);
  applyView();
}
function applyView() {
  if (!canvas.width || !canvas.style.width) return;
  const s = $('#r-stage');
  const w = parseFloat(canvas.style.width) * view.zoom, h = parseFloat(canvas.style.height) * view.zoom;
  const mx = Math.max(0, (w - s.clientWidth) / 2), my = Math.max(0, (h - s.clientHeight) / 2);
  view.tx = Math.min(mx, Math.max(-mx, view.tx));
  view.ty = Math.min(my, Math.max(-my, view.ty));
  canvas.style.transform = view.zoom > 1 ? `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})` : '';
  drawPointer();
}
const mid = (ts) => ({ x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2, d: Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY) });
const click = (btn) => { send(`md ${btn} ${posStr()}`); send(`mu ${btn} ${posStr()}`); };
const buzz = () => { if (navigator.vibrate) navigator.vibrate(15); };

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const now = Date.now();
  if (e.touches.length >= 2) {
    if (touch) { clearTimeout(touch.timer); if (touch.down) send(`mu 0 ${posStr()}`); }
    const m = mid(e.touches);
    touch = { two: true, start: now, last: m, startD: m.d, startZoom: view.zoom, acc: 0, gesture: null };
    return;
  }
  const t = e.touches[0];
  touch = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, start: now, moved: false, down: false, long: false };
  if (touchMode === 'direct') {
    const r = canvas.getBoundingClientRect();
    moveCursor((t.clientX - r.left) / r.width, (t.clientY - r.top) / r.height);
  } else if (now - lastTapEnd < DOUBLE_TAP_MS) {
    // second tap of a double-tap: hold the button so sliding drags
    touch.dragArmed = true;
  }
  touch.timer = setTimeout(() => {
    if (touch && !touch.moved && !touch.two && !touch.dragArmed) { touch.long = true; click(2); buzz(); }
  }, LONG_PRESS);
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!touch) return;
  if (touch.two) {
    if (e.touches.length < 2) return;
    const m = mid(e.touches);
    // decide once whether this is a pinch (distance changes) or a scroll (fingers move together)
    if (!touch.gesture) {
      if (Math.abs(m.d - touch.startD) > 24) touch.gesture = 'pinch';
      else if (Math.abs(m.y - touch.last.y) + Math.abs(m.x - touch.last.x) > 10) touch.gesture = 'scroll';
    }
    if (touch.gesture === 'pinch') {
      view.zoom = Math.min(5, Math.max(1, touch.startZoom * (m.d / touch.startD)));
      if (view.zoom === 1) { view.tx = 0; view.ty = 0; }
      view.tx += m.x - touch.last.x; view.ty += m.y - touch.last.y; // two-finger pan while zoomed
      applyView();
    } else if (touch.gesture === 'scroll') {
      touch.acc += touch.last.y - m.y; // fingers moving up scrolls the content down
      while (Math.abs(touch.acc) >= 40) { send(`wh ${touch.acc > 0 ? -120 : 120}`); touch.acc -= Math.sign(touch.acc) * 40; }
    }
    touch.last = m;
    return;
  }
  const t = e.touches[0];
  if (!touch.moved && Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > MOVE_SLOP) {
    touch.moved = true;
    clearTimeout(touch.timer);
    // direct mode: sliding drags; trackpad mode: sliding only drags after a double-tap
    if (!touch.long && (touchMode === 'direct' || touch.dragArmed)) { send(`md 0 ${posStr()}`); touch.down = true; }
  }
  if (!touch.moved) return;
  if (touchMode === 'direct') {
    const r = canvas.getBoundingClientRect();
    moveCursor((t.clientX - r.left) / r.width, (t.clientY - r.top) / r.height);
  } else {
    // relative movement, a little faster than the finger (scaled to the displayed desktop)
    const r = canvas.getBoundingClientRect();
    moveCursor(cur.x + ((t.clientX - touch.lx) * SPEED) / r.width, cur.y + ((t.clientY - touch.ly) * SPEED) / r.height);
  }
  touch.lx = t.clientX; touch.ly = t.clientY;
}, { passive: false });

const touchEnd = (e) => {
  e.preventDefault();
  if (!touch || e.touches.length) return; // wait until every finger is up
  clearTimeout(touch.timer);
  const quick = Date.now() - touch.start < TAP_MS;
  if (touch.two) {
    if (!touch.gesture && quick) { click(2); buzz(); } // two-finger tap = right-click
  } else if (touch.down) {
    send(`mu 0 ${posStr()}`);
  } else if (!touch.long && !touch.moved) {
    click(0);
    lastTapEnd = touch.dragArmed ? 0 : Date.now();
  }
  touch = null;
};
canvas.addEventListener('touchend', touchEnd, { passive: false });
canvas.addEventListener('touchcancel', touchEnd, { passive: false });

$('#r-touch').value = touchMode;
$('#r-touch').addEventListener('change', (e) => {
  touchMode = e.target.value;
  try { localStorage.setItem('hp-remote-touch', touchMode); } catch { /* storage unavailable */ }
  drawPointer();
});
$('#r-zoom-reset').addEventListener('click', () => { view.zoom = 1; view.tx = 0; view.ty = 0; applyView(); });

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
