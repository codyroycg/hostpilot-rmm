# HostPilot task: create a registry key
#__ARGS__
#__INCLUDE:_reg.ps1__
$k = Open-RegKey $A['path'] $true
$n = $k.CreateSubKey($A['name'])
if (-not $n) { throw 'Could not create the key' }
"Created $($A['path'])\$($A['name'])"
