# HostPilot RMM - Windows agent installer
# Usage (elevated PowerShell):
#   irm '__SERVER_URL__/install/windows?token=__TOKEN__' | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
& {
    $Server = '__SERVER_URL__'
    $Token = '__TOKEN__'
    $TaskName = 'HostPilotAgent'
    $Dir = Join-Path $env:ProgramData 'HostPilot'

    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer from an elevated (Administrator) PowerShell.'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    Write-Host "Installing HostPilot agent to $Dir"

    # Stop an existing install (re-install / repair keeps the same device identity)
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like "*$Dir*" } |
        ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }

    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    # Only SYSTEM and Administrators may read the agent secret
    & icacls.exe $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

    Invoke-WebRequest -Uri "$Server/agent/windows.ps1" -OutFile (Join-Path $Dir 'agent.ps1') -UseBasicParsing
    Invoke-WebRequest -Uri "$Server/agent/runner.ps1" -OutFile (Join-Path $Dir 'runner.ps1') -UseBasicParsing

    $cfgPath = Join-Path $Dir 'config.json'
    $existing = $null
    if (Test-Path $cfgPath) { try { $existing = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch {} }
    if ($existing -and $existing.agent_id -and $existing.server -eq $Server) {
        Write-Host "Keeping existing device identity $($existing.agent_id)"
    } else {
        $body = @{ token = $Token; hostname = $env:COMPUTERNAME; platform = 'windows' } | ConvertTo-Json
        $r = Invoke-RestMethod -Uri "$Server/api/agent/enroll" -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing
        $cfg = @{ server = $Server; agent_id = $r.agent_id; secret = $r.secret } | ConvertTo-Json
        [IO.File]::WriteAllText($cfgPath, $cfg, (New-Object Text.UTF8Encoding $false))
        Write-Host "Enrolled as device $($r.agent_id)"
    }

    $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Dir\runner.ps1`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal `
        -Description 'HostPilot RMM monitoring agent' | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    Write-Host 'HostPilot agent installed and running. It should appear in the console within a minute.' -ForegroundColor Green
}
