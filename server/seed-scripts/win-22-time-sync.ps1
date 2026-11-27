# name: Sync the clock
# category: Maintenance
# description: Makes sure the Windows Time service is running, forces a time sync and shows the time source and offset
# timeout: 120
$svc = Get-Service W32Time
if ($svc.StartType -eq 'Disabled') { Set-Service W32Time -StartupType Manual }
if ($svc.Status -ne 'Running') { Start-Service W32Time; Start-Sleep 2 }
$r = w32tm /resync /force 2>&1
"Resync: $($r -join ' ')"
''
w32tm /query /status 2>&1 | Where-Object { $_ -match '^(Source|Last Successful Sync Time|Stratum|Poll Interval)' }
''
"Local time now: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) ($((Get-TimeZone).Id))"
$src = (w32tm /query /source 2>&1 | Select-Object -First 1).Trim()
if ($src -and $src -notmatch 'Local CMOS|Free-running') {
  $peer = ($src -split ',')[0]
  w32tm /stripchart /computer:$peer /samples:1 /dataonly 2>&1 | Select-Object -Last 1
}
