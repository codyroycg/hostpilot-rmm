# name: Network diagnostics
# category: Network
# description: Adapters, IP addresses, gateway and DNS servers, then tests the gateway, DNS lookups and internet reachability
# timeout: 180
"=== Connected adapters ==="
Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ForEach-Object {
  "{0} ({1}, {2})" -f $_.InterfaceAlias, $_.NetAdapter.InterfaceDescription, $_.NetAdapter.LinkSpeed
  "  IPv4:    " + (($_.IPv4Address | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" }) -join ', ')
  "  Gateway: " + (($_.IPv4DefaultGateway | ForEach-Object { $_.NextHop }) -join ', ')
  "  DNS:     " + (($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses }) -join ', ')
  "  DHCP:    " + $(if ($_.NetIPv4Interface.Dhcp -eq 'Enabled') { 'yes' } else { 'no (static)' })
}
""
"=== Tests ==="
$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
function Test-Ping($label, $target) {
  if (-not $target) { "{0,-22} skipped (none found)" -f $label; return }
  $ok = Test-Connection -ComputerName $target -Count 2 -Quiet -ErrorAction SilentlyContinue
  "{0,-22} {1}  ({2})" -f $label, $(if ($ok) { 'OK' } else { 'FAILED' }), $target
}
Test-Ping 'Ping gateway' $gw
Test-Ping 'Ping internet (IP)' '1.1.1.1'
foreach ($n in 'www.microsoft.com', 'www.google.com') {
  try { $ip = (Resolve-DnsName $n -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress; "{0,-22} OK  ({1} -> {2})" -f 'DNS lookup', $n, $ip }
  catch { "{0,-22} FAILED  ({1}: {2})" -f 'DNS lookup', $n, $_.Exception.Message }
}
$t = Test-NetConnection -ComputerName 'www.microsoft.com' -Port 443 -WarningAction SilentlyContinue
"{0,-22} {1}" -f 'HTTPS (port 443)', $(if ($t.TcpTestSucceeded) { 'OK' } else { 'FAILED' })
try { $pub = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 10 -UseBasicParsing); "{0,-22} {1}" -f 'Public IP', $pub } catch { }
