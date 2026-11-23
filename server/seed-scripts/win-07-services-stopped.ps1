# name: Stopped automatic services
# category: Troubleshooting
# description: Lists services set to Automatic that are not running
# timeout: 60
$svc = Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'"
if (-not $svc) { 'All automatic services are running.'; exit 0 }
$svc | Select-Object Name, DisplayName, State, ExitCode | Format-Table -AutoSize | Out-String -Width 200
