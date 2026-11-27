# name: Clear stuck print jobs
# category: Maintenance
# description: Stops the Print Spooler, deletes every queued print job and starts the spooler again
# timeout: 120
$dir = Join-Path $env:SystemRoot 'System32\spool\PRINTERS'
Stop-Service Spooler -Force -ErrorAction Stop
$files = @(Get-ChildItem $dir -File -ErrorAction SilentlyContinue)
$files | Remove-Item -Force -ErrorAction SilentlyContinue
Start-Service Spooler -ErrorAction Stop
"Removed $($files.Count) spooled file(s). Print Spooler is $((Get-Service Spooler).Status)."
''
'=== Printers ==='
Get-Printer -ErrorAction SilentlyContinue | Select-Object Name, PrinterStatus, PortName, Shared | Format-Table -AutoSize | Out-String
