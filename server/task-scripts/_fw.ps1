# shared: build New-/Set-NetFirewallRule parameters from the task arguments (empty = leave unchanged)
function Get-FwParams([hashtable]$A, [bool]$IsNew) {
    $p = @{}
    $list = { param($s) @(([string]$s -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    if ($A['name']) { if ($IsNew) { $p.DisplayName = $A['name'] } else { $p.NewDisplayName = $A['name'] } }
    if ($A['direction']) { $p.Direction = if ($A['direction'] -eq 'out') { 'Outbound' } else { 'Inbound' } }
    if ($A['action']) { $p.Action = if ($A['action'] -eq 'block') { 'Block' } else { 'Allow' } }
    $proto = $A['protocol']
    if ($proto) { $p.Protocol = switch ($proto) { 'tcp' { 'TCP' } 'udp' { 'UDP' } 'icmpv4' { 'ICMPv4' } 'icmpv6' { 'ICMPv6' } default { 'Any' } } }
    $portsOk = $proto -in 'tcp', 'udp'
    if ($A['local_port']) { $p.LocalPort = if ($portsOk -and $A['local_port'] -ne 'any') { & $list $A['local_port'] } else { 'Any' } }
    elseif ($proto -and -not $portsOk) { $p.LocalPort = 'Any' }
    if ($A['remote_port']) { $p.RemotePort = if ($portsOk -and $A['remote_port'] -ne 'any') { & $list $A['remote_port'] } else { 'Any' } }
    elseif ($proto -and -not $portsOk) { $p.RemotePort = 'Any' }
    if ($A['remote_address']) { $p.RemoteAddress = if ($A['remote_address'] -eq 'any') { 'Any' } else { & $list $A['remote_address'] } }
    if ($A['program_set'] -eq '1' -and ($A['program'] -or -not $IsNew)) { $p.Program = if ($A['program']) { $A['program'] } else { 'Any' } }
    if ($A['profile']) { $p.Profile = if ($A['profile'] -eq 'any') { 'Any' } else { (& $list $A['profile']) -join ',' } }
    if ($A['enabled']) { $p.Enabled = if ($A['enabled'] -eq '1') { 'True' } else { 'False' } }
    if ($A['description_set'] -eq '1' -and ($A['description'] -or -not $IsNew)) { $p.Description = [string]$A['description'] }
    $p
}
