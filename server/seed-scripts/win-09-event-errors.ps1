# name: Recent system/application errors
# category: Troubleshooting
# description: Critical and error events from the last 24 hours
# timeout: 120
$events = Get-WinEvent -FilterHashtable @{ LogName = 'System','Application'; Level = 1,2; StartTime = (Get-Date).AddDays(-1) } -MaxEvents 50 -ErrorAction SilentlyContinue
if (-not $events) { 'No critical/error events in the last 24 hours.'; exit 0 }
$events | Select-Object TimeCreated, LogName, ProviderName, Id, @{n='Message';e={($_.Message -split "`n")[0]}} | Format-Table -AutoSize -Wrap | Out-String -Width 250
