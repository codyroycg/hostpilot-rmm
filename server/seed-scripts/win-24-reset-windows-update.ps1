# name: Reset Windows Update
# category: Patching
# description: Fixes stuck or failing Windows Update by stopping its services, clearing the download cache (SoftwareDistribution, catroot2) and starting them again
# timeout: 600
$svcs = 'wuauserv', 'bits', 'cryptsvc', 'msiserver', 'usosvc'
foreach ($s in $svcs) { Stop-Service $s -Force -ErrorAction SilentlyContinue }
Start-Sleep 3
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
foreach ($p in "$env:SystemRoot\SoftwareDistribution", "$env:SystemRoot\System32\catroot2") {
  if (Test-Path $p) {
    try { Rename-Item $p "$(Split-Path $p -Leaf).old-$stamp" -ErrorAction Stop; "Moved aside: $p" }
    catch { "Could not move $p ($($_.Exception.Message)); clearing its contents instead"; Get-ChildItem $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
foreach ($s in $svcs) { Start-Service $s -ErrorAction SilentlyContinue }
''
Get-Service $svcs -ErrorAction SilentlyContinue | Select-Object Name, Status | Format-Table -AutoSize | Out-String
# remove copies left by earlier runs (keep the newest one, just made)
foreach ($n in 'SoftwareDistribution', 'catroot2') {
  $root = if ($n -eq 'catroot2') { "$env:SystemRoot\System32" } else { $env:SystemRoot }
  Get-ChildItem $root -Directory -Filter "$n.old-*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip 1 |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
'Windows Update was reset. Run "List pending Windows updates" to check for updates again.'
