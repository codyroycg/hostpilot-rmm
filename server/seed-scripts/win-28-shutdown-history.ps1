# name: Restart and crash history
# category: Troubleshooting
# description: Last boot time, plus the last 15 restarts, shutdowns, unexpected power losses and blue screens with who or what caused them
# timeout: 120
$os = Get-CimInstance Win32_OperatingSystem
$up = (Get-Date) - $os.LastBootUpTime
"Last boot: $($os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm'))  (up $($up.Days)d $($up.Hours)h $($up.Minutes)m)"
''
$ids = 1074, 6008, 41, 1001, 6005, 6006
Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = $ids } -MaxEvents 300 -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -ne 1001 -or $_.ProviderName -eq 'Microsoft-Windows-WER-SystemErrorReporting' } |
  Where-Object { $_.Id -notin 6005, 6006 } | Select-Object -First 15 | ForEach-Object {
    $ev = $_; $p = $ev.Properties
    $what = switch ($ev.Id) {
      1074 { "$((Get-Culture).TextInfo.ToTitleCase([string]$p[4].Value)) by $($p[6].Value) via $([IO.Path]::GetFileName([string]$p[0].Value)) - $($p[2].Value)" + $(if ($p[5].Value) { " ($($p[5].Value))" }) }
      6008 { 'Unexpected shutdown (the previous shutdown was not clean)' }
      41   { 'Rebooted without shutting down cleanly (power loss, hang or crash)' }
      1001 { 'Blue screen (bugcheck): ' + ("$($ev.Message)" -split "`n" | Select-Object -First 1) }
    }
    [pscustomobject]@{ Time = $ev.TimeCreated.ToString('yyyy-MM-dd HH:mm'); Event = $what }
  } | Format-Table -AutoSize -Wrap | Out-String -Width 220
$dumps = Get-ChildItem "$env:SystemRoot\Minidump" -Filter *.dmp -ErrorAction SilentlyContinue
if ($dumps) { "$(@($dumps).Count) crash dump(s) in C:\Windows\Minidump, newest $((($dumps | Sort-Object LastWriteTime)[-1]).LastWriteTime.ToString('yyyy-MM-dd'))" }
