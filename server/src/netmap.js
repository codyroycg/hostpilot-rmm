// Network discovery: store scan results from a probe device and classify what was found.
import { all, get, run, tx } from './db.js';
import { HttpError } from './util.js';

// ---------- MAC vendor (OUI) hints for common network, IoT and peripheral makers ----------
// category: fw firewall · rt router · net switching/routing gear · ap wireless · prn printer · cam camera · nas · voip
//           iot smart home · media TV/speakers · vm virtual machine · sbc single-board computer · pc computer maker · phone
const OUI_GROUPS = [
  ['Fortinet', 'fw', '00090f 085b0e 704ca5 906cac e81cba 04d590'],
  ['Palo Alto Networks', 'fw', '001b17 b40c25 08306b 00869c d4f4be 7c89c1'],
  ['SonicWall', 'fw', '0006b1 c0eae4 18b169 2cb8ed'],
  ['WatchGuard', 'fw', '00907f'],
  ['Sophos', 'fw', '001a8c 7c5a1c c84f86'],
  ['Netgate', 'fw', '0008a2 90ec77'],
  ['Cisco', 'net', '000c85 001aa1 002584 f872ea 5897bd 002414 00270d 503de5 6886a7 001bd4 0019e8 a0f849 70db98 e8b748 00a289 cc46d6 b0aa77'],
  ['Cisco Meraki', 'net', '00180a 881544 e0553d 0c8ddb ac17c8 3456fe'],
  ['Ubiquiti', 'net', '24a43c 44d9e7 687251 788a20 802aa8 b4fbe4 dc9fdb f09fc2 fcecda 7483c2 e063da 18e829 245a4c 602232 70a741 9c05d6 d8b370 68d79a 784558 ac8ba9 e43883 f492bf 0cea14 28704e'],
  ['MikroTik', 'rt', '4c5e0c 64d154 6c3b6b b869f4 cc2de0 d4ca6d e48d8c 2cc81b 488f5a 744d28 085531 18fd74 dc2c6e c4ad34'],
  ['TP-Link', 'net', '50c7bf 98dac4 b04e26 c006c3 ec086b f4f26d 6032b1 14ebb6 1c61b4 30de4b 3c846a 54af97 5c628b 68ff7b 788cb5 84d81b a0f3c1 ac84c6 b09575 c46e1f d807b6 e848b8 003192 9ca2f4 1c3bf3 60a4b7 704f57 98254a b0be76 5091e3'],
  ['TP-Link (Kasa/Tapo)', 'iot', '2887ba 5c628b 6c5ab0 b0a7b9 d84732 3460f9'],
  ['Netgear', 'net', '00146c 001b2f 0024b2 204e7f 28c68e 2c3033 30469a 4494fc 6cb0ce 9c3dcf a040a0 b07fb9 c0ffd4 e0469a e4f4c6 08028e 80cc9c 94a67e 3c3786'],
  ['D-Link', 'net', '002191 00055d 000d88 001195 001346 0015e9 00179a 00195b 001b11 001cf0 001e58 0022b0 002401 00265a 14d64d 1c7ee5 28107b 340804 5cd998 78542e 84c9b2 9094e4 b8a386 c0a0bb c8be19 ccb255 f07d68 fc7516'],
  ['ASUS', 'net', '04d4c4 2c4d54 50465d 6045cb 704d7b ac220b f832e4 1c872c 305a3a 38d547 40167e 88d7f6 b06ebf d850e6 e03f49 f07959 08606e 107b44 244bfe 9c5c8e'],
  ['Aruba / HPE', 'ap', '000b86 001a1e 00246c 04bd88 186472 204c03 24dec6 40e3d6 6cf37f 703a0e 84d47e 94b40f aca31e d8c7c8 b45d50'],
  ['Ruckus', 'ap', '00227f 001392 2c5d93 58b633 6caab3 c08adc d4684d ec58ea'],
  ['Synology', 'nas', '001132 9009d0'],
  ['QNAP', 'nas', '00089b 245ebe'],
  ['HP', 'prn', '3cd92b 001b78 9457a5 a0d3c1 645106 ecb1d7 705a0f 9c8e99 b05ada 101f74 2c44fd 3863bb 480fcf 80ce62 843497 a0b3cc c8d9d2 f43909 fc15b4'],
  ['Brother', 'prn', '001ba9 008077 30055c 3c2af4 b42200'],
  ['Canon', 'prn', '001e8f 180cac 2c9efc 60128b 888717 f48139'],
  ['Epson', 'prn', '0026ab 44d244 64eb8c 9caed3 ac1826 b0e892 e0bb9e f8d027 381a52'],
  ['Hikvision', 'cam', '2857be 4419b6 4cbd8f 54c415 5803fb 686dbc 8ce748 a41437 bcad28 c056e3 e0ca3c 1868cb 2432ae 807c62 08a189 98df82 accb51 c42f90 e4d58b'],
  ['Dahua', 'cam', '08eded 14a78b 38af29 3cef8c 4c11bf 9002a9 9c1463 a0bd1d b44c3b bc325f e0508b f4b1c2'],
  ['Axis', 'cam', '00408c accc8e b8a44f e82725'],
  ['Reolink', 'cam', 'ec71db'],
  ['Wyze', 'cam', '2caa8e d03f27 7c78b2'],
  ['Espressif (ESP32/ESP8266)', 'iot', '240ac4 30aea4 246f28 84f3eb a4cf12 cc50e3 ecfabc 600194 5ccf7f 18fe34 2cf432 bcddc2 840d8e 483fda 349454 c82b96 d8f15b 10521c e8db84 7c9ebd 083af2 94b97e a4e57c c44f33 40f520 3c6105 8caab5 2462ab 98cdac b4e62d'],
  ['Philips Hue (Signify)', 'iot', '001788 ecb5fa'],
  ['Google Nest', 'iot', '18b430 641666'],
  ['ecobee', 'iot', '446132'],
  ['Amazon', 'media', '74c246 44650d f0272d 6837e9 fc65de 84d6d0 0c47c9 50dce7 a002dc 18742e 40b4cd 747548 b47c9c 38f73d 6c5697 10ae60'],
  ['Google', 'media', '00f620 f4f5d8 f4f5e8 546009 6cadf8 3c5ab4 1cf29a d86c63 48d6d5 20dfb9 a47733 30fd38 f80ff9 44070b ccf411'],
  ['Sonos', 'media', '000e58 347e5c 48a6b8 542a1b 5caafd 7828ca 949f3e b8e937 f0f6c1'],
  ['Roku', 'media', '080581 b0a737 b83e59 c83a6b d83134 dc3a5e 105932 ac3a7a cc6da0'],
  ['Apple', 'phone', 'f01898 3c22fb a483e7 acbc32 705681 9801a7 dca904 8866a5 28cfe9 f40f24 bc52b7 90b21f 7cd1c3 147dda 001b63 d0817a 8c8590 40cbc0'],
  ['Xiaomi', 'iot', '286c07 34ce00 50642b 640980 7811dc 7c49eb 98fa9b f0b429 04cf8c'],
  ['Yealink', 'voip', '805ec0 001565'],
  ['Polycom', 'voip', '0004f2 64167f'],
  ['Grandstream', 'voip', '000b82 c074ad'],
  ['Raspberry Pi', 'sbc', 'b827eb dca632 e45f01 2ccf67 d83add 28cdc1'],
  ['Proxmox VE (virtual)', 'vm', 'bc2411'],
  ['QEMU/KVM (virtual)', 'vm', '525400'],
  ['VMware (virtual)', 'vm', '005056 000c29 000569'],
  ['Hyper-V (virtual)', 'vm', '00155d'],
  ['VirtualBox (virtual)', 'vm', '080027'],
  ['Dell', 'pc', '001422 180373 1866da 3417eb 549f35 74867a 842b2b b82a72 b8ca3a d4bed9 f8b156 141877 989096 e4b97a'],
  ['Micro-Star (MSI)', 'pc', '309c23 00d861 d8bbc1'],
  ['Gigabyte', 'pc', 'fcaa14 1c1b0d 74d435 50e549 b42e99 e0d55e'],
  ['ASRock', 'pc', '7085c2 a8a159 bc5ff4'],
  ['Supermicro', 'pc', '002590 ac1f6b 3cecef 0cc47a'],
];
const OUI = new Map();
for (const [vendor, cat, list] of OUI_GROUPS) for (const p of list.split(' ')) OUI.set(p, { vendor, cat });

export function macVendor(mac) {
  const hex = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length < 6) return { vendor: '', cat: '', random: false };
  const hit = OUI.get(hex.slice(0, 6));
  // second-lowest bit of the first byte = locally administered (phones/laptops use random "private" MACs)
  const random = (parseInt(hex.slice(0, 2), 16) & 2) === 2;
  return { vendor: hit?.vendor || (random ? 'Private / randomized MAC' : ''), cat: hit?.cat || '', random };
}

export const NET_TYPES = ['router', 'firewall', 'switch', 'access_point', 'server', 'workstation', 'printer', 'camera', 'nas', 'voip', 'phone', 'media', 'iot', 'unknown'];

/** Best guess of what a discovered device is. Returns { type, reason }. */
export function classify(d, { gateway, hops = [], agent = null }) {
  const ports = new Set(String(d.ports || '').split(',').filter(Boolean).map(Number));
  const i = d.info || {};
  const text = [i.snmp_descr, i.snmp_name, i.http_server, i.http_title, i.ssdp_server, i.ssdp_type, i.ssdp_name, i.ssdp_mfr, i.ssdp_model, d.hostname, i.netbios, d.vendor]
    .filter(Boolean).join(' ').toLowerCase();
  const cat = macVendor(d.mac).cat;
  const has = (...p) => p.some((x) => ports.has(x));
  const re = (r) => r.test(text);
  const R = (type, reason) => ({ type, reason });

  if (agent) return R(agent.platform === 'linux' || /server/i.test(agent.os_name || '') ? 'server' : 'workstation', 'HostPilot agent installed');
  if (cat === 'fw' || re(/fortigate|fortios|pan-os|palo alto|sonicwall|watchguard|pfsense|opnsense|sophos (xg|utm|firewall)|check ?point|untangle|firewall/)) return R('firewall', 'Firewall vendor or banner');
  if (d.ip === gateway) return R('router', 'Default gateway of this network');
  if (re(/internetgatewaydevice|routeros|mikrotik|edgerouter|openwrt|dd-wrt|tomato|\brouter\b|unifi (dream|gateway)|\budm\b|\busg\b/)) return R('router', 'Router banner / UPnP gateway');
  if (hops.includes(d.ip)) return R('router', 'Seen on the route to the internet');
  if (re(/\bswitch\b|catalyst|procurve|aruba ?os-?cx|edgeswitch|unifi switch|\busw\b|nexus|junos.*ex\d|\bgs\d{3}|\bsg\d{3}|smart managed/) ||
      (re(/cisco[- ]ios/) && !has(445))) return R('switch', 'Switch banner (SNMP / web interface)');
  if (re(/access point|unifi ap|\buap\b|aironet|meraki mr|ruckus|\beap\d{3}|wfadevice|wireless ap/) || cat === 'ap') return R('access_point', 'Wireless access point');
  // NAS before printers: many NAS boxes also run a print server (LPD 515)
  if (re(/synology|diskstation|qnap|truenas|freenas|openmediavault|unraid|readynas|alt-f|\bnas\b|wd ?my ?cloud|terramaster|asustor/) || cat === 'nas' || has(548)) return R('nas', 'NAS web interface or vendor');
  if (re(/printer|laserjet|officejet|deskjet|envy|ecotank|brother|canon|xerox|kyocera|ricoh|lexmark|\bmfp\b|epson/) || cat === 'prn' || (has(9100) || (has(515, 631) && !has(22))) && !has(445, 3389)) return R('printer', 'Printer ports or vendor');
  if (has(554, 37777) || re(/camera|ipcam|hikvision|dahua|axis|reolink|\bnvr\b|\bdvr\b|webcam|blue iris/) || cat === 'cam') return R('camera', 'Camera (RTSP) or vendor');
  if (has(5060) || cat === 'voip' || re(/yealink|polycom|grandstream|\bsip\b|voip/)) return R('voip', 'VoIP phone (SIP)');
  if (has(62078) || re(/iphone|ipad|android|galaxy|pixel/)) return R('phone', 'Phone or tablet');
  if (has(8008, 8009) || cat === 'media' || re(/chromecast|roku|sonos|apple ?tv|fire ?tv|smart ?tv|bravia|webos|tizen|mediarenderer|plex|kodi|shield/)) return R('media', 'Media device (Cast/DLNA/streaming)');
  if (has(1883, 8883, 6668) || cat === 'iot' || re(/\bhue\b|tuya|shelly|tasmota|esphome|smart ?plug|\bring\b|\bnest\b|ecobee|wemo|kasa|tapo|govee|lifx|\bwiz\b|home ?assistant|zigbee/)) return R('iot', 'Smart-home / IoT protocol or vendor');
  if (has(3389) && re(/server/) || cat === 'vm' || (cat === 'sbc' && has(22))) return R('server', cat === 'vm' ? 'Virtual machine' : 'Server');
  if (has(22) && !has(135, 139, 445, 3389)) return R('server', has(80, 443) ? 'SSH and web services' : 'SSH (Linux/Unix)');
  if (has(135, 139, 445, 3389, 5900) || i.netbios || cat === 'pc') return R('workstation', 'Windows / file sharing ports');
  if (has(22)) return R('server', 'SSH');
  if (macVendor(d.mac).random) return R('phone', 'Private MAC address (usually a phone, tablet or laptop)');
  if (has(80, 443, 8443)) return R('iot', 'Web interface only');
  return R('unknown', 'Not enough information');
}

// ---------- networks ----------
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
export function normalizeCidr(s) {
  const m = CIDR.exec(String(s || '').trim());
  if (!m) throw new HttpError(400, 'Enter the network as an address range like 192.168.1.0/24');
  const o = m.slice(1, 5).map(Number), bits = Number(m[5]);
  if (o.some((x) => x > 255)) throw new HttpError(400, 'Invalid IP address');
  if (bits < 20 || bits > 30) throw new HttpError(400, 'Use a range between /20 (4094 addresses) and /30');
  const private_ = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || (o[0] === 169 && o[1] === 254);
  if (!private_) throw new HttpError(400, 'Only private networks (10.x, 172.16-31.x, 192.168.x, 100.64-127.x) can be scanned');
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const n = (ip & mask) >>> 0;
  return `${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')}/${bits}`;
}

/** Store the result of a finished net.scan job. */
export function ingestScan(job) {
  const n = get('SELECT * FROM networks WHERE last_job_id=?', job.id);
  if (!n) return;
  const lines = String(job.stdout || '').split(/\r?\n/).map((l) => l.split('\t'));
  const head = lines.find((f) => f[0] === 'NET');
  if (job.status !== 'success' || !head) { run('UPDATE networks SET scan_error=? WHERE id=?', (job.stderr || 'Scan failed').slice(0, 500), n.id); return; }
  const hops = lines.filter((f) => f[0] === 'HOP').map((f) => ({ ttl: Number(f[1]), ip: f[2] }));
  const gateway = head[2] || '';
  const now = Date.now();
  const agents = all("SELECT id, hostname, platform, os_name, ip_addrs, net_ifaces FROM agents");
  const byIp = new Map(), byMac = new Map();
  for (const a of agents) {
    for (const ip of JSON.parse(a.ip_addrs || '[]')) byIp.set(ip, a);
    for (const f of JSON.parse(a.net_ifaces || '[]')) if (f.mac) byMac.set(f.mac.toLowerCase(), a);
  }
  const seen = new Set();
  tx(() => {
    for (const f of lines.filter((x) => x[0] === 'DEV')) {
      const [, ip, mac, , , dns, netbios, ports, snmpName, snmpDescr, snmpOid, httpServer, httpTitle, ssdpServer, ssdpType, ssdpName, ssdpMfr, ssdpModel, self] = f;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '')) continue;
      const key = mac ? `mac:${mac}` : `ip:${ip}`;
      seen.add(key);
      const info = { netbios, snmp_name: snmpName, snmp_descr: snmpDescr, snmp_oid: snmpOid, http_server: httpServer, http_title: httpTitle,
        ssdp_server: ssdpServer, ssdp_type: ssdpType, ssdp_name: ssdpName, ssdp_mfr: ssdpMfr, ssdp_model: ssdpModel, self: self === '1' };
      for (const k of Object.keys(info)) if (info[k] === '' || info[k] === false) delete info[k];
      const agent = byMac.get(mac) || byIp.get(ip) || (self === '1' ? agents.find((a) => a.id === n.probe_agent_id) : null) || null;
      const hostname = agent?.hostname || ssdpName || snmpName || netbios || (dns ? dns.split('.')[0] : '') || '';
      const v = macVendor(mac);
      const vendor = ssdpMfr || v.vendor || '';
      const d = { ip, mac, hostname, vendor, ports, info };
      const { type, reason } = classify(d, { gateway, hops: hops.map((h) => h.ip), agent });
      const old = get('SELECT * FROM net_devices WHERE network_id=? AND dkey=?', n.id, key);
      if (old) {
        run(`UPDATE net_devices SET ip=?, mac=?, hostname=?, vendor=?, ports=?, info=?, agent_id=?, online=1, last_seen=?,
             type=CASE WHEN type_manual=1 THEN type ELSE ? END, reason=CASE WHEN type_manual=1 THEN reason ELSE ? END WHERE id=?`,
        ip, mac, hostname, vendor, ports, JSON.stringify(info), agent?.id || null, now, type, reason, old.id);
      } else {
        run(`INSERT INTO net_devices(network_id, dkey, ip, mac, hostname, vendor, type, reason, ports, info, agent_id, online, first_seen, last_seen)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`, n.id, key, ip, mac, hostname, vendor, type, reason, ports, JSON.stringify(info), agent?.id || null, now, now);
      }
    }
    for (const r of all('SELECT id, dkey FROM net_devices WHERE network_id=? AND online=1', n.id)) {
      if (!seen.has(r.dkey)) run('UPDATE net_devices SET online=0 WHERE id=?', r.id);
    }
    run('UPDATE networks SET gateway=?, probe_ip=?, hops=?, last_scan_at=?, scan_error=NULL WHERE id=?', gateway, head[3] || '', JSON.stringify(hops), now, n.id);
  });
}

export function presentNetDevice(r) {
  let info = {};
  try { info = JSON.parse(r.info || '{}'); } catch { /* ignore */ }
  return { ...r, info, online: !!r.online, type_manual: !!r.type_manual };
}
