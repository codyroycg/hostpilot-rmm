# HostPilot task: delete a Windows Defender Firewall rule
#__ARGS__
$rule = Get-NetFirewallRule -Name $A['id']
if ([string]$rule.PolicyStoreSourceType -eq 'GroupPolicy') { throw "This rule comes from Group Policy and can only be removed there." }
$name = $rule.DisplayName
Remove-NetFirewallRule -Name $A['id']
"Deleted firewall rule '$name'"
