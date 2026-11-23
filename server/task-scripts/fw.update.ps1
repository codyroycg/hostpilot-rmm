# HostPilot task: modify (or enable/disable) a Windows Defender Firewall rule
#__ARGS__
#__INCLUDE:_fw.ps1__
$rule = Get-NetFirewallRule -Name $A['id']
if ([string]$rule.PolicyStoreSourceType -eq 'GroupPolicy') { throw "This rule comes from Group Policy and can only be changed there." }
$p = Get-FwParams $A $false
if ($p.Count) { Set-NetFirewallRule -Name $A['id'] @p }
$r = Get-NetFirewallRule -Name $A['id']
"Updated firewall rule '$($r.DisplayName)' (enabled: $($r.Enabled))"
