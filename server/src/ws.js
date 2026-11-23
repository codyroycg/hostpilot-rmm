// Minimal RFC 6455 WebSocket server connection (no dependencies).
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setTimeout(0);
  return new WsConn(socket);
}

export function rejectUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragText = false;
    this.closed = false;
    socket.on('data', (d) => this.#onData(d));
    socket.on('close', () => this.#onClose());
    socket.on('error', () => this.#onClose());
    // keepalive so idle proxies don't drop the connection
    this.pinger = setInterval(() => this.#frame(9, Buffer.alloc(0)), 25000);
  }

  get buffered() { return this.socket.writableLength; }

  send(data, isText = typeof data === 'string') {
    this.#frame(isText ? 1 : 2, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason).subarray(0, 120);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.#frame(8, p);
    this.#finish();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  #finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    this.emit('close');
  }

  #onClose() { this.#finish(); }

  #onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed && this.#parseOne());
  }

  #parseOne() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return false; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return false; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_MESSAGE) { this.close(1009, 'too big'); return false; }
    const maskAt = off;
    if (masked) off += 4;
    if (b.length < off + len) return false;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (masked) {
      const m = b.subarray(maskAt, maskAt + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
    }
    this.buf = b.subarray(off + len);
    this.#handle(fin, op, payload);
    return true;
  }

  #handle(fin, op, payload) {
    if (op === 8) { this.close(); return; }
    if (op === 9) { this.#frame(10, payload); return; }
    if (op === 10) return;
    if (op === 0) {
      this.frags.push(payload);
      if (fin) {
        const all = Buffer.concat(this.frags);
        this.frags = [];
        this.emit('message', this.fragText ? all.toString('utf8') : all, this.fragText);
      }
      return;
    }
    if (!fin) { this.fragText = op === 1; this.frags = [payload]; return; }
    this.emit('message', op === 1 ? payload.toString('utf8') : payload, op === 1);
  }

  #frame(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x80 | op;
    this.socket.write(h);
    if (len) this.socket.write(payload);
  }
}
