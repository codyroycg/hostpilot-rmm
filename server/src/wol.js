// Wake-on-LAN: magic packets are broadcast on the sleeping machine's own network, so they are sent by an
// online HostPilot device on that subnet (the "relay"). The server also sends one itself, which only
// helps when the container shares that network (e.g. network_mode: host).
import dgram from 'node:dgram';

/** "AA-BB-CC-DD-EE-FF" / "aabb.ccdd.eeff" → "aa:bb:cc:dd:ee:ff"; null for anything that can't be a NIC. */
export function normMac(m) {
  const hex = String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /^0+$|^f+$/.test(hex)) return null;
  if (parseInt(hex.slice(0, 2), 16) & 1) return null; // multicast
  return hex.match(/../g).join(':');
}

const ipToInt = (ip) => {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
};
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export const isPrivateV4 = (ip) => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(String(ip)) && ipToInt(ip) != null;

function parseCidr(cidr) {
  const [ip, b] = String(cidr).split('/');
  const base = ipToInt(ip), bits = Number(b ?? 32);
  if (base == null || !Number.isInteger(bits) || bits < 8 || bits > 30) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (base & mask) >>> 0, mask };
}

export function ipInCidr(ip, cidr) {
  const c = parseCidr(cidr), n = ipToInt(ip);
  return !!c && n != null && ((n & c.mask) >>> 0) === c.net;
}

export function broadcastFor(cidr) {
  const c = parseCidr(cidr);
  return c ? intToIp((c.net | (~c.mask >>> 0)) >>> 0) : null;
}

export const slash24 = (ip) => `${String(ip).split('.').slice(0, 3).join('.')}.0/24`;

export function magicPacket(mac) {
  const m = Buffer.from(mac.replace(/:/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
}

/** Best-effort broadcast from the server itself. Resolves to the number of packets sent. */
export function sendFromServer(macs, targets, ports = [9, 7]) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let sent = 0, pending = 0;
    const done = () => { try { sock.close(); } catch { /* closed */ } resolve(sent); };
    sock.on('error', done);
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { return done(); }
      for (const mac of macs) for (const host of targets) for (const port of ports) {
        pending++;
        sock.send(magicPacket(mac), port, host, (err) => { if (!err) sent++; if (--pending === 0) done(); });
      }
      if (!pending) done();
    });
    setTimeout(done, 3000).unref();
  });
}
