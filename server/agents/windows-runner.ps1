# HostPilot RMM runner: keeps agent.ps1 alive (restarts it after self-updates or crashes)
# and performs uninstall when the agent leaves an uninstall.flag behind.
$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
$Agent = Join-Path $Base 'agent.ps1'
$Flag = Join-Path $Base 'uninstall.flag'
$PS = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

while ($true) {
    & $PS -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Agent
    if (Test-Path -LiteralPath $Flag) {
        Unregister-ScheduledTask -TaskName 'HostPilotAgent' -Confirm:$false -ErrorAction SilentlyContinue
        Set-Location $env:SystemRoot
        Remove-Item -LiteralPath $Base -Recurse -Force -ErrorAction SilentlyContinue
        exit 0
    }
    Start-Sleep -Seconds 5
}
