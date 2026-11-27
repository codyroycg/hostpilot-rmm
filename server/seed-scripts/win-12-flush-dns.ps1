# name: Flush DNS and renew network settings
# category: Network
# description: Clears the DNS and ARP caches, re-registers DNS and renews DHCP leases. The connection may drop for a few seconds.
# timeout: 180
ipconfig /flushdns | Out-Null; 'DNS cache cleared.'
try { Remove-NetNeighbor -Confirm:$false -ErrorAction Stop; 'ARP cache cleared.' } catch { arp -d * 2>$null | Out-Null; 'ARP cache cleared.' }
ipconfig /registerdns | Out-Null; 'DNS registration requested.'
$dhcp = Get-NetIPInterface -AddressFamily IPv4 -Dhcp Enabled -ConnectionState Connected -ErrorAction SilentlyContinue
if ($dhcp) { ipconfig /renew | Out-Null; 'DHCP leases renewed.' } else { 'No DHCP adapters to renew (static addresses).' }
''
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' } |
  Select-Object InterfaceAlias, IPAddress, PrefixOrigin | Format-Table -AutoSize | Out-String
