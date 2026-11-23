# HostPilot task: modify a local user (password, enabled, admin, full name)
#__ARGS__
$n = $A['name']
$null = Get-LocalUser -Name $n
if ($A['password']) { Set-LocalUser -Name $n -Password (ConvertTo-SecureString $A['password'] -AsPlainText -Force); 'Password changed' }
if ($A['must_change'] -eq '1') { & net.exe user $n /logonpasswordchg:yes | Out-Null; 'Must change password at next logon' }
if ($A['fullname_set'] -eq '1') { Set-LocalUser -Name $n -FullName $A['fullname']; 'Full name updated' }
if ($A['enabled'] -eq '1') { Enable-LocalUser -Name $n; 'Account enabled' }
elseif ($A['enabled'] -eq '0') { Disable-LocalUser -Name $n; 'Account disabled' }
if ($A['admin'] -eq '1') {
    try { Add-LocalGroupMember -SID 'S-1-5-32-544' -Member $n; 'Added to Administrators' }
    catch { if ($_.FullyQualifiedErrorId -like '*MemberExists*') { 'Already an administrator' } else { throw } }
} elseif ($A['admin'] -eq '0') {
    try { Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member $n; 'Removed from Administrators' }
    catch { if ($_.FullyQualifiedErrorId -like '*MemberNotFound*') { 'Was not an administrator' } else { throw } }
}
