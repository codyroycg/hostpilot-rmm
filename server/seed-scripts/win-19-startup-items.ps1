# name: Startup programs and scheduled tasks
# category: Security
# description: Programs that start automatically (Run keys, Startup folders) and non-Microsoft scheduled tasks. Useful when hunting for unwanted software.
# timeout: 120
'=== Startup programs ==='
Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User | Sort-Object Location, Name |
  Format-Table -AutoSize -Wrap | Out-String -Width 220
'=== Scheduled tasks (not from Microsoft) ==='
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -notlike '\Microsoft\*' -and $_.State -ne 'Disabled' } | ForEach-Object {
  $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Task    = $_.TaskPath + $_.TaskName
    State   = $_.State
    RunsAs  = $_.Principal.UserId
    Action  = ($_.Actions | ForEach-Object { (($_.Execute, $_.Arguments) -join ' ').Trim() }) -join '; '
    LastRun = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' }
  }
} | Sort-Object Task | Format-Table -AutoSize -Wrap | Out-String -Width 220
