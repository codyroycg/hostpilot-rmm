# HostPilot task: delete a local user (optionally its profile folder)
#__ARGS__
$u = Get-LocalUser -Name $A['name']
$sid = $u.SID.Value
Remove-LocalUser -Name $A['name']
"Deleted local user $($A['name'])"
if ($A['remove_home'] -eq '1') {
    $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
    if ($prof) { $prof | Remove-CimInstance; "Removed profile $($prof.LocalPath)" } else { 'No profile folder found' }
}
