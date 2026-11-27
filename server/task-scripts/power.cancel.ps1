# HostPilot task: cancel a scheduled restart or shutdown
#__ARGS__
# through cmd so shutdown.exe's own text doesn't come before ours (and PowerShell doesn't treat it as an error)
cmd.exe /c 'shutdown.exe /a >nul 2>&1'
if ($LASTEXITCODE -eq 1116) { 'Nothing was scheduled.'; exit 0 }
if ($LASTEXITCODE -ne 0) { "shutdown.exe failed with code $LASTEXITCODE"; exit 1 }
'Scheduled restart / shutdown cancelled.'
