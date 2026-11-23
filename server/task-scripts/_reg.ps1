# shared: open a registry key from a path like "HKLM\SOFTWARE\Vendor" (64-bit view)
$RegRoots = @{ HKLM = 'LocalMachine'; HKU = 'Users'; HKCR = 'ClassesRoot'; HKCC = 'CurrentConfig' }
function Split-RegPath([string]$Path) {
    $parts = $Path.Trim('\') -split '\\', 2
    $root = $parts[0].ToUpper() -replace '^HKEY_LOCAL_MACHINE$', 'HKLM' -replace '^HKEY_USERS$', 'HKU' -replace '^HKEY_CLASSES_ROOT$', 'HKCR' -replace '^HKEY_CURRENT_CONFIG$', 'HKCC'
    if (-not $RegRoots.ContainsKey($root)) { throw "Unknown registry root '$($parts[0])'. Use HKLM, HKU, HKCR or HKCC (HKCU is the per-user hive under HKU)." }
    @($root, $(if ($parts.Count -gt 1) { $parts[1] } else { '' }))
}
function Open-RegKey([string]$Path, [bool]$Writable = $false) {
    $root, $sub = Split-RegPath $Path
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::($RegRoots[$root]), [Microsoft.Win32.RegistryView]::Registry64)
    if (-not $sub) { return $base }
    $k = $base.OpenSubKey($sub, $Writable)
    if (-not $k) { throw "Key not found: $Path" }
    $k
}
