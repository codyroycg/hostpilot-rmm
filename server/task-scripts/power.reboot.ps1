# HostPilot task: restart or shut down Windows now or after a delay, with a message to the signed-in user
# mode: restart | shutdown
#__ARGS__
$mins = [int]$A['delay']
$off = $A['mode'] -eq 'shutdown'
$verb = if ($off) { 'shut down' } else { 'restart' }
$msg = $A['message']
if (-not $msg) { $msg = if ($mins -gt 0) { "Your computer will $verb in $mins minute(s). Please save your work. (HostPilot)" } else { "Your computer will $verb now. (HostPilot)" } }
# at least 10 seconds, so the agent can report back before Windows goes down
$secs = [math]::Max(10, $mins * 60)
& shutdown.exe $(if ($off) { '/s' } else { '/r' }) /t $secs /d p:0:0 /c $msg
if ($LASTEXITCODE -eq 1190) { 'A restart or shutdown is already scheduled on this device. Cancel it first to change it.'; exit 1 }
if ($LASTEXITCODE -ne 0) { "shutdown.exe failed with code $LASTEXITCODE"; exit 1 }
$Verb = if ($off) { 'Shutdown' } else { 'Restart' }
if ($mins -gt 0) { "$Verb scheduled in $mins minute(s); the signed-in user was warned." } elseif ($off) { 'Shutting down now.' } else { 'Restarting now.' }
