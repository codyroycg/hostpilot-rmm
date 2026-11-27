# name: Installed software
# category: Inventory
# description: Every installed program (64-bit, 32-bit and per-user) with version, publisher and install date
# timeout: 120
$keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
$apps = foreach ($k in $keys) { Get-ItemProperty $k -ErrorAction SilentlyContinue }
# per-user installs for every loaded and unloaded profile hive under HKEY_USERS
$apps += Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'S-1-5-21-[\d-]+$' } | ForEach-Object {
  Get-ItemProperty "Registry::$($_.Name)\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue
}
$list = $apps | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
  Sort-Object DisplayName, DisplayVersion -Unique |
  Select-Object @{n='Name';e={$_.DisplayName}}, @{n='Version';e={$_.DisplayVersion}}, Publisher,
    @{n='Installed';e={ if ($_.InstallDate -match '^\d{8}$') { $_.InstallDate.Insert(6,'-').Insert(4,'-') } else { '' } }}
"$(@($list).Count) programs installed"
$list | Format-Table -AutoSize | Out-String -Width 220
