# name: Repair Windows system files (DISM + SFC)
# category: Maintenance
# description: Repairs the Windows component store with DISM, then checks and repairs system files with SFC. Can take 15-45 minutes.
# timeout: 5400
'=== DISM /RestoreHealth ==='
$dism = & DISM.exe /Online /Cleanup-Image /RestoreHealth /English 2>&1 | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*\[[=\s\d.%]*\]\s*$' }
$dism | Select-Object -Last 6
$dismCode = $LASTEXITCODE
''
'=== SFC /scannow ==='
# sfc writes UTF-16 text; read it back through a temp file so it isn't garbled
$tmp = [IO.Path]::GetTempFileName()
cmd.exe /c "sfc /scannow > `"$tmp`" 2>&1"
$sfcCode = $LASTEXITCODE
[IO.File]::ReadAllText($tmp, [Text.Encoding]::Unicode) -split "`r?`n" | Where-Object { $_ -match '\S' -and $_ -notmatch 'Verification \d+% complete' } | Select-Object -Last 4
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
''
"DISM exit code $dismCode, SFC exit code $sfcCode. Details: C:\Windows\Logs\CBS\CBS.log"
if ($dismCode -ne 0) { exit 1 }
