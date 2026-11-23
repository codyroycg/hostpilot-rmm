# HostPilot task: discover devices on a subnet (ping + ARP, ports, DNS/NetBIOS names, SNMP, HTTP title, UPnP/SSDP)
# Output (tab separated):
#   NET\tcidr\tgateway\tprobe_ip
#   HOP\tttl\tip
#   DEV\tip\tmac\tping\tttl\tdns\tnetbios\tports\tsnmp_name\tsnmp_descr\tsnmp_oid\thttp_server\thttp_title\tssdp_server\tssdp_type\tssdp_name\tssdp_mfr\tssdp_model\tself
#__ARGS__
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace HostPilotNet {
  public class Dev {
    public string Ip, Mac = "", Dns = "", NetBios = "", Ports = "", SnmpName = "", SnmpDescr = "", SnmpOid = "";
    public string HttpServer = "", HttpTitle = "", SsdpServer = "", SsdpType = "", SsdpName = "", SsdpMfr = "", SsdpModel = "";
    public bool Ping, Self; public int Ttl;
  }

  public static class Scanner {
    static readonly int[] Ports = { 21, 22, 23, 53, 80, 135, 139, 443, 445, 515, 548, 554, 631, 1883, 3389, 5000, 5001, 5060, 5900, 6668, 7547, 8000, 8008, 8009, 8080, 8443, 8883, 9100, 37777, 62078 };

    public static List<IPAddress> Hosts(string cidr) {
      string[] p = cidr.Split('/');
      int bits = int.Parse(p[1]);
      byte[] b = IPAddress.Parse(p[0]).GetAddressBytes();
      uint ip = ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];
      uint mask = bits == 0 ? 0 : 0xFFFFFFFF << (32 - bits);
      uint net = ip & mask, bcast = net | ~mask;
      var list = new List<IPAddress>();
      uint first = bits >= 31 ? net : net + 1, last = bits >= 31 ? bcast : bcast - 1;
      for (uint a = first; a <= last && list.Count < 4096; a++)
        list.Add(new IPAddress(new byte[] { (byte)(a >> 24), (byte)(a >> 16), (byte)(a >> 8), (byte)a }));
      return list;
    }

    // ---- ping sweep ----
    public static Dictionary<string, int> PingSweep(List<IPAddress> hosts) {
      var alive = new Dictionary<string, int>();
      for (int i = 0; i < hosts.Count; i += 256) {
        var batch = hosts.Skip(i).Take(256).ToList();
        var tasks = batch.Select(h => new Ping().SendPingAsync(h, 900)).ToArray();
        try { Task.WaitAll(tasks); } catch { }
        for (int k = 0; k < tasks.Length; k++) {
          if (tasks[k].Status == TaskStatus.RanToCompletion && tasks[k].Result.Status == IPStatus.Success) {
            int ttl = tasks[k].Result.Options != null ? tasks[k].Result.Options.Ttl : 0;
            alive[batch[k].ToString()] = ttl;
          }
        }
      }
      return alive;
    }

    // ---- per-host probes ----
    static string OpenPorts(string ip) {
      var tasks = new List<Task<int>>();
      foreach (int port in Ports) {
        int p = port;
        tasks.Add(Task.Run(() => {
          using (var c = new TcpClient()) {
            try { var t = c.ConnectAsync(ip, p); if (t.Wait(700) && c.Connected) return p; } catch { }
            return 0;
          }
        }));
      }
      Task.WaitAll(tasks.ToArray());
      return string.Join(",", tasks.Select(t => t.Result).Where(p => p > 0));
    }

    static string ReverseDns(string ip) {
      try { var t = Dns.GetHostEntryAsync(ip); if (t.Wait(1500) && t.Result.HostName != ip) return t.Result.HostName; } catch { }
      return "";
    }

    static string NetBiosName(string ip) {
      byte[] q = new byte[50];
      q[0] = 0x48; q[1] = 0x50; q[5] = 1; q[12] = 0x20; q[13] = (byte)'C'; q[14] = (byte)'K';
      for (int i = 15; i < 45; i++) q[i] = (byte)'A';
      q[46] = 0x00; q[47] = 0x21; q[48] = 0x00; q[49] = 0x01;
      try {
        using (var u = new UdpClient()) {
          u.Client.ReceiveTimeout = 900;
          u.Send(q, q.Length, ip, 137);
          IPEndPoint ep = null;
          byte[] r = u.Receive(ref ep);
          if (r.Length < 57) return "";
          int n = r[56];
          for (int i = 0; i < n && 57 + i * 18 + 18 <= r.Length; i++) {
            int o = 57 + i * 18;
            string name = Encoding.ASCII.GetString(r, o, 15).Trim();
            int suffix = r[o + 15], flags = (r[o + 16] << 8) | r[o + 17];
            if (suffix == 0 && (flags & 0x8000) == 0 && name.Length > 0) return name;
          }
        }
      } catch { }
      return "";
    }

    // ---- SNMP v1 GET sysDescr, sysObjectID, sysName ----
    static byte[] Tlv(byte tag, byte[] v) {
      var o = new List<byte> { tag };
      if (v.Length < 128) o.Add((byte)v.Length);
      else if (v.Length < 256) { o.Add(0x81); o.Add((byte)v.Length); }
      else { o.Add(0x82); o.Add((byte)(v.Length >> 8)); o.Add((byte)v.Length); }
      o.AddRange(v); return o.ToArray();
    }
    static byte[] Cat(params byte[][] parts) { var o = new List<byte>(); foreach (var p in parts) o.AddRange(p); return o.ToArray(); }
    static readonly byte[][] Oids = {
      new byte[] { 0x2b, 6, 1, 2, 1, 1, 1, 0 }, new byte[] { 0x2b, 6, 1, 2, 1, 1, 2, 0 }, new byte[] { 0x2b, 6, 1, 2, 1, 1, 5, 0 } };

    static bool ReadTlv(byte[] b, ref int pos, out byte tag, out int start, out int len) {
      tag = 0; start = 0; len = 0;
      if (pos + 2 > b.Length) return false;
      tag = b[pos++]; int l = b[pos++];
      if ((l & 0x80) != 0) { int n = l & 0x7f; l = 0; for (int i = 0; i < n && pos < b.Length; i++) l = (l << 8) | b[pos++]; }
      start = pos; len = l; pos += l;
      return pos <= b.Length;
    }
    static string OidString(byte[] b, int s, int len) {
      if (len < 1) return "";
      var parts = new List<string> { (b[s] / 40).ToString(), (b[s] % 40).ToString() };
      long v = 0;
      for (int i = s + 1; i < s + len; i++) { v = (v << 7) | (uint)(b[i] & 0x7f); if ((b[i] & 0x80) == 0) { parts.Add(v.ToString()); v = 0; } }
      return string.Join(".", parts);
    }

    static string[] Snmp(string ip, string community) {
      var res = new string[3] { "", "", "" };
      var vbs = new List<byte>();
      foreach (var oid in Oids) vbs.AddRange(Tlv(0x30, Cat(Tlv(0x06, oid), new byte[] { 0x05, 0x00 })));
      byte[] pdu = Tlv(0xA0, Cat(Tlv(0x02, new byte[] { 0x11 }), Tlv(0x02, new byte[] { 0 }), Tlv(0x02, new byte[] { 0 }), Tlv(0x30, vbs.ToArray())));
      byte[] msg = Tlv(0x30, Cat(Tlv(0x02, new byte[] { 0 }), Tlv(0x04, Encoding.ASCII.GetBytes(community)), pdu));
      try {
        using (var u = new UdpClient()) {
          u.Client.ReceiveTimeout = 1200;
          u.Send(msg, msg.Length, ip, 161);
          IPEndPoint ep = null;
          byte[] r = u.Receive(ref ep);
          byte tag; int s, l; int pos = 0;
          if (!ReadTlv(r, ref pos, out tag, out s, out l)) return res;          // message
          pos = s;
          ReadTlv(r, ref pos, out tag, out s, out l);                          // version
          ReadTlv(r, ref pos, out tag, out s, out l);                          // community
          if (!ReadTlv(r, ref pos, out tag, out s, out l) || tag != 0xA2) return res; // response pdu
          pos = s;
          ReadTlv(r, ref pos, out tag, out s, out l); ReadTlv(r, ref pos, out tag, out s, out l); ReadTlv(r, ref pos, out tag, out s, out l);
          if (!ReadTlv(r, ref pos, out tag, out s, out l)) return res;          // varbind list
          int end = s + l; pos = s;
          while (pos < end) {
            int vs, vl; byte vt;
            if (!ReadTlv(r, ref pos, out vt, out vs, out vl)) break;
            int p2 = vs; byte nt, valt; int ns, nl, valS, valL;
            ReadTlv(r, ref p2, out nt, out ns, out nl);
            ReadTlv(r, ref p2, out valt, out valS, out valL);
            string name = OidString(r, ns, nl);
            string val = valt == 0x04 ? Encoding.UTF8.GetString(r, valS, valL) : valt == 0x06 ? OidString(r, valS, valL) : "";
            if (name == "1.3.6.1.2.1.1.1.0") res[1] = val;
            else if (name == "1.3.6.1.2.1.1.2.0") res[2] = val;
            else if (name == "1.3.6.1.2.1.1.5.0") res[0] = val;
          }
        }
      } catch { }
      return res;
    }

    static string[] Http(string ip, int port) {
      var res = new string[2] { "", "" };
      try {
        var req = (HttpWebRequest)WebRequest.Create("http://" + ip + ":" + port + "/");
        req.Timeout = 2500; req.ReadWriteTimeout = 2500; req.AllowAutoRedirect = false; req.UserAgent = "HostPilot-NetScan";
        HttpWebResponse resp;
        try { resp = (HttpWebResponse)req.GetResponse(); } catch (WebException we) { resp = we.Response as HttpWebResponse; }
        if (resp == null) return res;
        using (resp) {
          res[0] = resp.Headers["Server"] ?? "";
          var buf = new byte[16384]; int n = 0, r;
          using (var s = resp.GetResponseStream()) { while (n < buf.Length && (r = s.Read(buf, n, buf.Length - n)) > 0) n += r; }
          var m = Regex.Match(Encoding.UTF8.GetString(buf, 0, n), "<title[^>]*>([^<]{1,120})", RegexOptions.IgnoreCase);
          if (m.Success) res[1] = WebUtility.HtmlDecode(m.Groups[1].Value).Trim();
        }
      } catch { }
      return res;
    }

    // ---- UPnP / SSDP ----
    public static Dictionary<string, string[]> Ssdp() {
      var found = new Dictionary<string, string[]>();
      var locations = new Dictionary<string, string>();
      try {
        using (var u = new UdpClient(0)) {
          u.Client.ReceiveTimeout = 600;
          byte[] q = Encoding.ASCII.GetBytes("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n");
          var ep0 = new IPEndPoint(IPAddress.Parse("239.255.255.250"), 1900);
          u.Send(q, q.Length, ep0); Thread.Sleep(100); u.Send(q, q.Length, ep0);
          var until = DateTime.UtcNow.AddSeconds(3.5);
          while (DateTime.UtcNow < until) {
            try {
              IPEndPoint ep = null;
              string txt = Encoding.ASCII.GetString(u.Receive(ref ep));
              string ip = ep.Address.ToString();
              var server = Regex.Match(txt, @"(?im)^server:\s*(.+)$"); var loc = Regex.Match(txt, @"(?im)^location:\s*(.+)$");
              if (!found.ContainsKey(ip)) found[ip] = new string[] { "", "", "", "", "" };
              if (server.Success && found[ip][0] == "") found[ip][0] = server.Groups[1].Value.Trim();
              if (loc.Success && !locations.ContainsKey(ip)) locations[ip] = loc.Groups[1].Value.Trim();
            } catch (SocketException) { }
          }
        }
      } catch { }
      Parallel.ForEach(locations, new ParallelOptions { MaxDegreeOfParallelism = 16 }, kv => {
        try {
          var req = (HttpWebRequest)WebRequest.Create(kv.Value);
          req.Timeout = 2500; req.ReadWriteTimeout = 2500;
          string xml;
          using (var resp = req.GetResponse()) using (var sr = new System.IO.StreamReader(resp.GetResponseStream())) xml = sr.ReadToEnd();
          Func<string, string> tag = (t) => { var m = Regex.Match(xml, "<" + t + ">([^<]*)</" + t + ">", RegexOptions.IgnoreCase); return m.Success ? WebUtility.HtmlDecode(m.Groups[1].Value).Trim() : ""; };
          lock (found) {
            var f = found[kv.Key];
            f[1] = tag("deviceType"); f[2] = tag("friendlyName"); f[3] = tag("manufacturer"); f[4] = tag("modelName");
            if (f[4] == "") f[4] = tag("modelDescription");
          }
        } catch { }
      });
      return found;
    }

    public static List<string[]> Trace(int maxHops) {
      var hops = new List<string[]>();
      var target = IPAddress.Parse("8.8.8.8");
      for (int ttl = 1; ttl <= maxHops; ttl++) {
        try {
          var r = new Ping().Send(target, 1200, new byte[16], new PingOptions(ttl, true));
          if (r.Address != null && (r.Status == IPStatus.TtlExpired || r.Status == IPStatus.Success)) hops.Add(new string[] { ttl.ToString(), r.Address.ToString() });
          if (r.Status == IPStatus.Success) break;
        } catch { }
      }
      return hops;
    }

    public static Dev Probe(string ip, string community) {
      var d = new Dev { Ip = ip };
      var tasks = new Task[] {
        Task.Run(() => { d.Ports = OpenPorts(ip); }),
        Task.Run(() => { d.Dns = ReverseDns(ip); }),
        Task.Run(() => { d.NetBios = NetBiosName(ip); }),
        Task.Run(() => { if (community.Length > 0) { var s = Snmp(ip, community); d.SnmpName = s[0]; d.SnmpDescr = s[1]; d.SnmpOid = s[2]; } }),
      };
      Task.WaitAll(tasks);
      var ports = d.Ports.Split(',');
      int web = ports.Contains("80") ? 80 : ports.Contains("8080") ? 8080 : ports.Contains("8000") ? 8000 : 0;
      if (web > 0) { var h = Http(ip, web); d.HttpServer = h[0]; d.HttpTitle = h[1]; }
      return d;
    }

    public static List<Dev> ProbeAll(List<string> ips, string community) {
      var bag = new System.Collections.Concurrent.ConcurrentBag<Dev>();
      ThreadPool.SetMinThreads(200, 200);
      Parallel.ForEach(ips, new ParallelOptions { MaxDegreeOfParallelism = 48 }, ip => bag.Add(Probe(ip, community)));
      return bag.ToList();
    }
  }
}
'@
if (-not ('HostPilotNet.Scanner' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }

$cidr = $A['subnet']
$community = [string]$A['community']
function Clean($v) { ([string]$v -replace "[`t`r`n]", ' ').Trim() }

# local addresses and the default gateway on this subnet
$selfIps = @{}
$selfMacs = @{}
foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    foreach ($u in $n.GetIPProperties().UnicastAddresses) {
        if ($u.Address.AddressFamily -eq 'InterNetwork') { $selfIps[$u.Address.ToString()] = $true; $selfMacs[$u.Address.ToString()] = ($n.GetPhysicalAddress().ToString() -replace '(..)(?!$)', '$1:') }
    }
}
$hosts = [HostPilotNet.Scanner]::Hosts($cidr)
$inNet = @{}; foreach ($h in $hosts) { $inNet[$h.ToString()] = $true }
$gw = ''
foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    foreach ($g in $n.GetIPProperties().GatewayAddresses) { if ($inNet[$g.Address.ToString()]) { $gw = $g.Address.ToString() } }
}
$probeIp = ($selfIps.Keys | Where-Object { $inNet[$_] } | Select-Object -First 1)
"NET`t$cidr`t$gw`t$probeIp"

$alive = [HostPilotNet.Scanner]::PingSweep($hosts)
# ARP: devices that ignore ping still answer ARP
$macs = @{}
foreach ($nb in @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
    $ip = [string]$nb.IPAddress
    if (-not $inNet[$ip] -or [string]$nb.State -in 'Unreachable', 'Incomplete') { continue }
    $mac = ([string]$nb.LinkLayerAddress).Replace('-', ':').ToLower()
    if ($mac -and $mac -ne '00:00:00:00:00:00' -and $mac -ne 'ff:ff:ff:ff:ff:ff') { $macs[$ip] = $mac }
}
foreach ($ip in $selfIps.Keys) { if ($inNet[$ip]) { $macs[$ip] = ([string]$selfMacs[$ip]).ToLower() } }
$targets = New-Object Collections.Generic.List[string]
foreach ($ip in (@($alive.Keys) + @($macs.Keys) | Sort-Object -Unique)) { $targets.Add($ip) }

$ssdp = [HostPilotNet.Scanner]::Ssdp()
foreach ($ip in $ssdp.Keys) { if ($inNet[$ip] -and -not $targets.Contains($ip)) { $targets.Add($ip) } }
$devs = [HostPilotNet.Scanner]::ProbeAll($targets, $community)
foreach ($h in [HostPilotNet.Scanner]::Trace(6)) { "HOP`t$($h[0])`t$($h[1])" }

foreach ($d in $devs) {
    $s = $ssdp[$d.Ip]
    $ttl = 0; if ($alive.ContainsKey($d.Ip)) { $ttl = $alive[$d.Ip] }
    $f = @($d.Ip, $macs[$d.Ip], [int]$alive.ContainsKey($d.Ip), $ttl, $d.Dns, $d.NetBios, $d.Ports, $d.SnmpName, $d.SnmpDescr, $d.SnmpOid, $d.HttpServer, $d.HttpTitle,
        $(if ($s) { $s[0] } else { '' }), $(if ($s) { $s[1] } else { '' }), $(if ($s) { $s[2] } else { '' }), $(if ($s) { $s[3] } else { '' }), $(if ($s) { $s[4] } else { '' }),
        [int][bool]$selfIps[$d.Ip]) | ForEach-Object { Clean $_ }
    "DEV`t" + ($f -join "`t")
}
