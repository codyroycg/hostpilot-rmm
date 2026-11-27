# name: Firewall status
# category: Security
# description: Windows Firewall state for each profile, the active network profile and inbound allow rules that are open to any address
# timeout: 120
'=== Profiles ==='
Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction, LogBlocked |
  Format-Table -AutoSize | Out-String
'=== Active networks ==='
Get-NetConnectionProfile | Select-Object InterfaceAlias, Name, NetworkCategory | Format-Table -AutoSize | Out-String
$off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled })
if ($off.Count) { "WARNING: the firewall is OFF for: $(($off.Name) -join ', ')"; '' }
'=== Enabled inbound allow rules open to any remote address (not built-in) ==='
Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue |
  Where-Object { -not $_.Group -or $_.Group -notlike '@*' } | ForEach-Object {
    $addr = $_ | Get-NetFirewallAddressFilter
    if ($addr.RemoteAddress -contains 'Any') {
      $port = $_ | Get-NetFirewallPortFilter
      $app = $_ | Get-NetFirewallApplicationFilter
      [pscustomobject]@{ Rule = $_.DisplayName; Profile = $_.Profile; Protocol = $port.Protocol; Port = ($port.LocalPort -join ','); Program = $app.Program }
    }
  } | Sort-Object Rule | Format-Table -AutoSize -Wrap | Out-String -Width 220
