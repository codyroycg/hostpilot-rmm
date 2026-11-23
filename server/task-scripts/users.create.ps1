# HostPilot task: create a local user
#__ARGS__
$params = @{
    Name                = $A['name']
    Password            = (ConvertTo-SecureString $A['password'] -AsPlainText -Force)
    AccountNeverExpires = $true
}
if ($A['fullname']) { $params.FullName = $A['fullname'] }
New-LocalUser @params | Out-Null
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $A['name']   # Users
if ($A['admin'] -eq '1') { Add-LocalGroupMember -SID 'S-1-5-32-544' -Member $A['name']; 'Added to Administrators' }
if ($A['must_change'] -eq '1') { & net.exe user $A['name'] /logonpasswordchg:yes | Out-Null; 'Must change password at next logon' }
"Created local user $($A['name'])"
