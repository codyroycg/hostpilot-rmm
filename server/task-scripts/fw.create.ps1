# HostPilot task: create a Windows Defender Firewall rule
#__ARGS__
#__INCLUDE:_fw.ps1__
$p = Get-FwParams $A $true
$r = New-NetFirewallRule @p
"Created firewall rule '$($r.DisplayName)' ($($r.Name))"
