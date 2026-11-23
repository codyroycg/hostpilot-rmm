# HostPilot task: create or change a registry value
#__ARGS__
#__INCLUDE:_reg.ps1__
$k = Open-RegKey $A['path'] $true
$type = $A['type']
$d = $A['data']
$value = switch ($type) {
    'DWord' { if ($d -match '^0x[0-9a-f]+$') { [Convert]::ToUInt32($d.Substring(2), 16) } else { [uint32][int64]$d } }
    'QWord' { if ($d -match '^0x[0-9a-f]+$') { [Convert]::ToUInt64($d.Substring(2), 16) } else { [uint64]$d } }
    'MultiString' { [string[]]@($d -split "`r?`n") }
    'Binary' { [byte[]]@(($d -replace '[^0-9a-fA-F]', '') -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) }) }
    default { [string]$d }
}
# switch output is collected into object[]; SetValue needs the exact array type
if ($type -eq 'MultiString') { $value = [string[]]@($value) }
if ($type -eq 'Binary') { $value = [byte[]]@($value) }
if ($type -eq 'DWord') { $value = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$value), 0) }
if ($type -eq 'QWord') { $value = [BitConverter]::ToInt64([BitConverter]::GetBytes([uint64]$value), 0) }
$k.SetValue($A['name'], $value, [Microsoft.Win32.RegistryValueKind]::$type)
$k.Close()
"Set $($A['path'])\$(if ($A['name']) { $A['name'] } else { '(Default)' })"
