# HostPilot task: list a registry key
# Output: K\tsubkey\tsubkey_count   V\tname\ttype\tdata_base64   (MultiString lines joined by \n; Binary as hex)
#__ARGS__
#__INCLUDE:_reg.ps1__
if (-not $A['path']) { foreach ($r in 'HKLM', 'HKU', 'HKCR', 'HKCC') { "K`t$r`t1" }; return }
$k = Open-RegKey $A['path']
foreach ($n in ($k.GetSubKeyNames() | Sort-Object)) {
    $c = ''; try { $s = $k.OpenSubKey($n); if ($s) { $c = $s.SubKeyCount; $s.Close() } } catch { $c = '?' }
    "K`t$($n -replace "[`t`r`n]", ' ')`t$c"
}
foreach ($n in ($k.GetValueNames() | Sort-Object)) {
    $kind = $k.GetValueKind($n)
    $v = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
    $data = switch ($kind) {
        'MultiString' { ($v -join "`n") }
        'Binary' { (($v | ForEach-Object { $_.ToString('x2') }) -join ' ') }
        'DWord' { [string]([uint32]([int64]$v -band 0xFFFFFFFF)) }
        'QWord' { [string]$v }
        default { [string]$v }
    }
    $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$data))
    "V`t$($n -replace "[`t`r`n]", ' ')`t$kind`t$b"
}
