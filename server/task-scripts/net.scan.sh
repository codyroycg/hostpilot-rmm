# HostPilot task: discover devices on a subnet (ping + ARP, ports, DNS/NetBIOS names, SNMP, HTTP title, UPnP/SSDP)
# Same output format as net.scan.ps1. Needs python3 (present on nearly every Linux distribution).
#__ARGS__
command -v python3 >/dev/null 2>&1 || { echo "Network discovery on Linux needs python3" >&2; exit 1; }
export A_subnet A_community
exec python3 - <<'PY'
import concurrent.futures as cf, ipaddress, os, re, socket, subprocess, time, urllib.request, urllib.error, html

cidr = os.environ["A_subnet"]; community = os.environ.get("A_community", "")
net = ipaddress.ip_network(cidr, strict=False)
hosts = [str(h) for h in (net.hosts() if net.prefixlen < 31 else net)][:4096]
in_net = set(hosts)
PORTS = [21, 22, 23, 53, 80, 135, 139, 443, 445, 515, 548, 554, 631, 1883, 3389, 5000, 5001, 5060, 5900, 6668, 7547, 8000, 8008, 8009, 8080, 8443, 8883, 9100, 37777, 62078]
clean = lambda v: re.sub(r"[\t\r\n]", " ", str(v or "")).strip()

def sh(*cmd):
    try: return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout
    except Exception: return ""

# local addresses, MACs and gateway
self_ips, self_mac = set(), {}
for line in sh("ip", "-o", "-4", "addr").splitlines():
    m = re.search(r"^\d+: (\S+)\s+inet (\d+\.\d+\.\d+\.\d+)", line)
    if m:
        self_ips.add(m.group(2))
        try: self_mac[m.group(2)] = open(f"/sys/class/net/{m.group(1)}/address").read().strip()
        except OSError: pass
gw = ""
for line in sh("ip", "-4", "route").splitlines():
    m = re.match(r"default via (\S+)", line)
    if m and m.group(1) in in_net: gw = m.group(1)
probe = next((ip for ip in self_ips if ip in in_net), "")
print(f"NET\t{cidr}\t{gw}\t{probe}", flush=True)

def ping(ip):
    out = sh("ping", "-c", "1", "-W", "1", ip)
    m = re.search(r"ttl=(\d+)", out)
    return (ip, int(m.group(1))) if m else None
alive = {}
with cf.ThreadPoolExecutor(128) as ex:
    for r in ex.map(ping, hosts):
        if r: alive[r[0]] = r[1]

macs = {}
try:
    for line in open("/proc/net/arp").read().splitlines()[1:]:
        f = line.split()
        if len(f) >= 4 and f[0] in in_net and f[2] != "0x0" and f[3] != "00:00:00:00:00:00": macs[f[0]] = f[3].lower()
except OSError: pass
for ip in self_ips:
    if ip in in_net: macs[ip] = self_mac.get(ip, "")

def ssdp():
    found, locs = {}, {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(0.6)
    q = b'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n'
    try:
        s.sendto(q, ("239.255.255.250", 1900)); time.sleep(0.1); s.sendto(q, ("239.255.255.250", 1900))
    except OSError: return found
    end = time.time() + 3.5
    while time.time() < end:
        try: data, (ip, _) = s.recvfrom(4096)
        except OSError: continue
        t = data.decode("latin-1")
        f = found.setdefault(ip, ["", "", "", "", ""])
        m = re.search(r"(?im)^server:\s*(.+)$", t)
        if m and not f[0]: f[0] = m.group(1).strip()
        m = re.search(r"(?im)^location:\s*(.+)$", t)
        if m and ip not in locs: locs[ip] = m.group(1).strip()
    def fetch(item):
        ip, url = item
        try:
            xml = urllib.request.urlopen(url, timeout=2.5).read(65536).decode("utf-8", "replace")
            tag = lambda n: html.unescape((re.search(rf"<{n}>([^<]*)</{n}>", xml, re.I) or [None, ""])[1]).strip()
            found[ip][1:5] = [tag("deviceType"), tag("friendlyName"), tag("manufacturer"), tag("modelName") or tag("modelDescription")]
        except Exception: pass
    with cf.ThreadPoolExecutor(16) as ex: list(ex.map(fetch, locs.items()))
    return found
ssdp_info = ssdp()

def open_ports(ip):
    def one(p):
        try:
            with socket.create_connection((ip, p), timeout=0.7): return p
        except OSError: return 0
    with cf.ThreadPoolExecutor(len(PORTS)) as ex: return ",".join(str(p) for p in ex.map(one, PORTS) if p)

def rdns(ip):
    try: return socket.gethostbyaddr(ip)[0]
    except OSError: return ""

def netbios(ip):
    q = b"\x48\x50\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x20CK" + b"A" * 30 + b"\x00\x00\x21\x00\x01"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(0.9)
    try:
        s.sendto(q, (ip, 137)); r = s.recv(2048)
        for i in range(r[56] if len(r) > 56 else 0):
            o = 57 + i * 18
            if o + 18 > len(r): break
            name, suffix, flags = r[o:o + 15].decode("latin-1").strip(), r[o + 15], (r[o + 16] << 8) | r[o + 17]
            if suffix == 0 and not flags & 0x8000 and name: return name
    except OSError: pass
    finally: s.close()
    return ""

def tlv(tag, v):
    n = len(v)
    ln = bytes([n]) if n < 128 else (bytes([0x81, n]) if n < 256 else bytes([0x82, n >> 8, n & 255]))
    return bytes([tag]) + ln + v
OIDS = {"1.3.6.1.2.1.1.5.0": 0, "1.3.6.1.2.1.1.1.0": 1, "1.3.6.1.2.1.1.2.0": 2}
def oid_enc(o):
    p = [int(x) for x in o.split(".")]; out = bytes([p[0] * 40 + p[1]])
    for x in p[2:]:
        b = [x & 0x7f]; x >>= 7
        while x: b.insert(0, 0x80 | (x & 0x7f)); x >>= 7
        out += bytes(b)
    return out
def oid_dec(b):
    if not b: return ""
    parts, v = [str(b[0] // 40), str(b[0] % 40)], 0
    for c in b[1:]:
        v = (v << 7) | (c & 0x7f)
        if not c & 0x80: parts.append(str(v)); v = 0
    return ".".join(parts)
def read(b, pos):
    tag, l = b[pos], b[pos + 1]; pos += 2
    if l & 0x80:
        n = l & 0x7f; l = int.from_bytes(b[pos:pos + n], "big"); pos += n
    return tag, pos, l
def snmp(ip):
    res = ["", "", ""]
    if not community: return res
    vbs = b"".join(tlv(0x30, tlv(0x06, oid_enc(o)) + b"\x05\x00") for o in OIDS)
    pdu = tlv(0xA0, tlv(0x02, b"\x11") + tlv(0x02, b"\x00") + tlv(0x02, b"\x00") + tlv(0x30, vbs))
    msg = tlv(0x30, tlv(0x02, b"\x00") + tlv(0x04, community.encode()) + pdu)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(1.2)
    try:
        s.sendto(msg, (ip, 161)); r = s.recv(65535)
        _, p, _ = read(r, 0)
        for _ in range(2): t, p2, l = read(r, p); p = p2 + l
        t, p, l = read(r, p)
        if t != 0xA2: return res
        for _ in range(3): t, p2, l = read(r, p); p = p2 + l
        t, p, l = read(r, p); end = p + l
        while p < end:
            t, vs, vl = read(r, p); p = vs + vl
            nt, ns, nl = read(r, vs); vt, xs, xl = read(r, ns + nl)
            name = oid_dec(r[ns:ns + nl])
            val = r[xs:xs + xl].decode("utf-8", "replace") if vt == 0x04 else oid_dec(r[xs:xs + xl]) if vt == 0x06 else ""
            if name in OIDS: res[OIDS[name]] = val
    except Exception: pass
    finally: s.close()
    return res

def http(ip, port):
    try:
        req = urllib.request.Request(f"http://{ip}:{port}/", headers={"User-Agent": "HostPilot-NetScan"})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k): return None
        try: r = urllib.request.build_opener(NoRedirect).open(req, timeout=2.5)
        except urllib.error.HTTPError as e: r = e
        body = r.read(16384).decode("utf-8", "replace")
        m = re.search(r"<title[^>]*>([^<]{1,120})", body, re.I)
        return [r.headers.get("Server", "") or "", html.unescape(m.group(1)).strip() if m else ""]
    except Exception: return ["", ""]

def probe(ip):
    with cf.ThreadPoolExecutor(4) as ex:
        fp, fd, fn, fs = ex.submit(open_ports, ip), ex.submit(rdns, ip), ex.submit(netbios, ip), ex.submit(snmp, ip)
        ports, dns, nb, sn = fp.result(), fd.result(), fn.result(), fs.result()
    pl = ports.split(",")
    web = next((p for p in ("80", "8080", "8000") if p in pl), None)
    hs = http(ip, web) if web else ["", ""]
    return ip, ports, dns, nb, sn, hs

targets = sorted(set(alive) | set(macs) | {ip for ip in ssdp_info if ip in in_net}, key=lambda x: tuple(int(p) for p in x.split(".")))
with cf.ThreadPoolExecutor(48) as ex: results = list(ex.map(probe, targets))

for ttl in range(1, 7):
    out = sh("ping", "-c", "1", "-W", "1", "-t", str(ttl), "8.8.8.8")
    m = re.search(r"From (\d+\.\d+\.\d+\.\d+)", out) or re.search(r"bytes from (\d+\.\d+\.\d+\.\d+)", out)
    if m: print(f"HOP\t{ttl}\t{m.group(1)}")
    if "bytes from" in out: break

for ip, ports, dns, nb, sn, hs in results:
    s = ssdp_info.get(ip, ["", "", "", "", ""])
    f = [ip, macs.get(ip, ""), int(ip in alive), alive.get(ip, 0), dns, nb, ports, sn[0], sn[1], sn[2], hs[0], hs[1], *s, int(ip in self_ips)]
    print("DEV\t" + "\t".join(clean(x) for x in f))
PY
