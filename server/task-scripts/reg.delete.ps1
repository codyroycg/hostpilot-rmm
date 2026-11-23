# HostPilot task: delete a registry value, or a whole key (with its subkeys)
#__ARGS__
#__INCLUDE:_reg.ps1__
if ($A['what'] -eq 'key') {
    $root, $sub = Split-RegPath $A['path']
    if (($sub -split '\\').Count -lt 2) { throw 'Refusing to delete a top-level key (e.g. HKLM\SOFTWARE).' }
    $parentPath = $A['path'].Trim('\') -replace '\\[^\\]+$', ''
    $leaf = ($A['path'].Trim('\') -split '\\')[-1]
    $parent = Open-RegKey $parentPath $true
    $parent.DeleteSubKeyTree($leaf)
    "Deleted key $($A['path'])"
} else {
    $k = Open-RegKey $A['path'] $true
    $k.DeleteValue($A['name'])
    "Deleted value $($A['name'])"
}
