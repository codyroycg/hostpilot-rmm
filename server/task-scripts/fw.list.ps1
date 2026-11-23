# HostPilot task: Windows Defender Firewall profiles and rules
# Output:
#   F\tprofile\tenabled 0|1\tdefault_inbound\tdefault_outbound
#   R\tid\tname\tenabled 0|1\tdirection in|out\taction allow|block\tprotocol\tlocal_ports\tremote_ports\tremote_addresses\tprogram\tprofiles\tgroup\tsource local|gpo|other\tdescription
#__ARGS__
$ErrorActionPreference = 'Continue'
function Clean($v) { ((@($v) | Where-Object { $null -ne $_ }) -join ',' -replace "[`t`r`n]", ' ').Trim() }

foreach ($p in @(Get-NetFirewallProfile)) {
    "F`t$($p.Name)`t$([int]($p.Enabled -eq $true -or [string]$p.Enabled -eq 'True'))`t$($p.DefaultInboundAction)`t$($p.DefaultOutboundAction)"
}
# fetch all filters in bulk (one query each) and join on the rule's InstanceID
$ports = @{}; foreach ($f in @(Get-NetFirewallPortFilter -All)) { $ports[$f.InstanceID] = $f }
$addrs = @{}; foreach ($f in @(Get-NetFirewallAddressFilter -All)) { $addrs[$f.InstanceID] = $f }
$apps = @{}; foreach ($f in @(Get-NetFirewallApplicationFilter -All)) { $apps[$f.InstanceID] = $f }
foreach ($r in @(Get-NetFirewallRule)) {
    $pf = $ports[$r.Name]; $af = $addrs[$r.Name]; $ap = $apps[$r.Name]
    $src = switch ([string]$r.PolicyStoreSourceType) { 'Local' { 'local' } 'GroupPolicy' { 'gpo' } default { 'other' } }
    $prof = [string]$r.Profile
    $fields = @(
        $r.Name, $r.DisplayName, [int]([string]$r.Enabled -eq 'True'),
        $(if ([string]$r.Direction -eq 'Outbound') { 'out' } else { 'in' }),
        $(if ([string]$r.Action -eq 'Block') { 'block' } else { 'allow' }),
        $(if ($pf) { $pf.Protocol } else { 'Any' }), $(if ($pf) { $pf.LocalPort } else { 'Any' }), $(if ($pf) { $pf.RemotePort } else { 'Any' }),
        $(if ($af) { $af.RemoteAddress } else { 'Any' }), $(if ($ap -and $ap.Program -ne 'Any') { $ap.Program } else { '' }),
        $prof, $r.DisplayGroup, $src, $r.Description
    ) | ForEach-Object { Clean $_ }
    "R`t" + ($fields -join "`t")
}
