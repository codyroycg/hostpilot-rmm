// Wake-on-LAN: magic packets are broadcast on the sleeping machine's own network, so they are sent by an
// online HostPilot device on that subnet (the "relay"). The server also sends one itself, which only
// helps when the container shares that network (e.g. network_mode: host).
import dgram from 'node:dgram';
import { all, audit } from './db.js';
import { HttpError } from './util.js';
import { queueJobs, isPolling } from './jobs.js';
import { buildTask, supportsTask } from './task-catalog.js';

const ONLINE_WINDOW = 3 * 60 * 1000;
const isOnline = (a) => isPolling(a.id) || (a.last_seen && Date.now() - a.last_seen < ONLINE_WINDOW);

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

/** MAC addresses (wired first, no VPN/virtual) and private IPv4 addresses HostPilot knows for an agent row. */
export function agentWakeTarget(a) {
  const ifaces = a.net_ifaces ? JSON.parse(a.net_ifaces) : [];
  const physical = ifaces.filter((i) => !['vpn', 'virtual', 'bluetooth', 'cellular'].includes(i.kind));
  physical.sort((x, y) => (y.kind === 'ethernet') - (x.kind === 'ethernet')); // most machines only wake from Ethernet
  const macs = [...new Set(physical.map((i) => normMac(i.mac)).filter(Boolean))].slice(0, 8);
  for (const d of all('SELECT mac FROM net_devices WHERE agent_id=? AND mac IS NOT NULL', a.id)) { // seen by network discovery
    const m = normMac(d.mac);
    if (m && !macs.includes(m)) macs.push(m);
  }
  const ips = [...new Set([...(a.ip_addrs ? JSON.parse(a.ip_addrs) : []), ...physical.flatMap((i) => i.ips || [])])].filter(isPrivateV4);
  return { macs, ips };
}

/**
 * Sends magic packets for `macs` from an online HostPilot device on the same subnet as `ips`
 * (preferring `prefer`, then devices of the same client), plus a best-effort broadcast from the server.
 */
export async function wakeOnLan({ macs, ips, subnets = [], prefer = null, clientId = null, exclude = null, label, user }) {
  const nets = [...subnets];
  for (const n of all('SELECT subnet FROM networks')) if (ips.some((ip) => ipInCidr(ip, n.subnet))) nets.push(n.subnet);
  for (const ip of ips) nets.push(slash24(ip));
  const uniqNets = [...new Set(nets.filter((n) => broadcastFor(n)))];
  if (!uniqNets.length) throw new HttpError(400, `HostPilot doesn't know which network ${label} is on (no private IPv4 address recorded).`);

  const candidates = all('SELECT id, hostname, platform, client_id, ip_addrs, last_seen FROM agents WHERE id IS NOT ?', exclude)
    .filter((r) => isOnline(r) && supportsTask('net.wake', r.platform))
    .map((r) => ({ ...r, ips: r.ip_addrs ? JSON.parse(r.ip_addrs) : [] }));
  let relay = null, subnet = uniqNets[0];
  for (const n of uniqNets) {
    const onNet = candidates.filter((r) => r.ips.some((ip) => ipInCidr(ip, n)))
      .sort((x, y) => (y.id === prefer) - (x.id === prefer) || (y.client_id === clientId) - (x.client_id === clientId));
    if (onNet.length) { relay = onNet[0]; subnet = n; break; }
  }
  const bcasts = [...new Set([broadcastFor(subnet), ...ips.filter((ip) => ipInCidr(ip, subnet)), '255.255.255.255'])];
  let job = null;
  if (relay) {
    const r = queueJobs({
      agents: [relay], name: `Wake-on-LAN ${label}`, task: 'net.wake', createdBy: user.username, timeout: 60,
      build: (a) => buildTask('net.wake', a.platform, { macs: macs.join(','), bcasts: bcasts.join(','), label }, { allowInternal: true }),
    });
    job = r.jobs[0] || null;
  }
  const serverSent = await sendFromServer(macs, [broadcastFor(subnet), '255.255.255.255']);
  audit(user.username, 'wake-on-lan', `${label} (${macs.join(', ')}) via ${relay ? relay.hostname : 'server only'}`);
  return { macs, subnet, relay: relay ? { id: relay.id, hostname: relay.hostname } : null, job, server_sent: serverSent };
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
