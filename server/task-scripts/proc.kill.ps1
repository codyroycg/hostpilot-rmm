# HostPilot task: end a process (optionally with its child processes)
#__ARGS__
$p = Get-Process -Id ([int]$A['pid']) -ErrorAction Stop
$name = $p.ProcessName
if ($A['tree'] -eq '1') { & taskkill.exe /PID ([int]$A['pid']) /T /F | Out-Null; if ($LASTEXITCODE) { throw "taskkill failed ($LASTEXITCODE)" } }
else { Stop-Process -Id ([int]$A['pid']) -Force }
"Ended $name (PID $($A['pid']))"
