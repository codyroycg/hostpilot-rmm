# HostPilot RMM agent for Windows (PowerShell 5.1+)
# Runs as SYSTEM under runner.ps1 (scheduled task "HostPilotAgent").
# Config lives next to this file in config.json: { server, agent_id, secret }

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
$SelfPath = $MyInvocation.MyCommand.Path
$Cfg = Get-Content (Join-Path $Base 'config.json') -Raw | ConvertFrom-Json
$Server = ([string]$Cfg.server).TrimEnd('/')
$Headers = @{ 'X-Agent-Id' = [string]$Cfg.agent_id; 'X-Agent-Secret' = [string]$Cfg.secret }
# inherited by job processes (file transfers need to know where to send data)
$env:HOSTPILOT_SERVER = $Server
$env:PYTHONIOENCODING = 'utf-8'
$Utf8 = New-Object Text.UTF8Encoding $false
$Oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
$MyVersion = (Get-FileHash -Algorithm SHA256 -LiteralPath $SelfPath).Hash.Substring(0, 12).ToLower()
$JobDir = Join-Path $Base 'jobs'
$LogFile = Join-Path $Base 'agent.log'
$MaxOutput = 1MB

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $JobDir | Out-Null
Get-ChildItem -LiteralPath $JobDir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

function Write-Log([string]$Msg) {
    try {
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) { Move-Item $LogFile "$LogFile.1" -Force }
        Add-Content -LiteralPath $LogFile -Value ("{0}  {1}" -f (Get-Date -Format s), $Msg)
    } catch {}
}

function Invoke-Api([string]$Method, [string]$Path, $Body = $null, [int]$TimeoutSec = 30) {
    $p = @{ Uri = "$Server$Path"; Method = $Method; Headers = $Headers; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
    if ($null -ne $Body) {
        $json = ConvertTo-Json -InputObject $Body -Depth 6 -Compress
        $p.Body = [Text.Encoding]::UTF8.GetBytes($json)
        $p.ContentType = 'application/json; charset=utf-8'
    }
    Invoke-RestMethod @p
}

function ConvertTo-UnixMs([datetime]$d) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() }

function Get-Metrics {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $procs = @(Get-CimInstance Win32_Processor)
    $bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue

    $cpu = ($procs | Measure-Object -Property LoadPercentage -Average).Average
    if ($null -eq $cpu) { $cpu = 0 }
    $memPct = [math]::Round((1 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize)) * 100, 1)

    $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
        @{ mount = [string]$_.DeviceID; total = [int64]$_.Size; free = [int64]$_.FreeSpace }
    })
    $ips = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' |
        ForEach-Object { $_.IPAddress } | Where-Object { $_ -and $_ -notlike 'fe80*' -and $_ -ne '::1' } | ForEach-Object { [string]$_ })

    $ver = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
    $osVersion = [string]$os.Version
    if ($ver.DisplayVersion) { $osVersion = "$($ver.DisplayVersion) (build $($os.BuildNumber).$($ver.UBR))" }
    elseif ($ver.UBR) { $osVersion = "$($os.Version).$($ver.UBR)" }

    @{
        hostname      = [string]$env:COMPUTERNAME
        cpu           = [double]$cpu
        mem           = [double]$memPct
        disks         = $disks
        ip_addrs      = $ips
        logged_user   = [string]$cs.UserName
        os_name       = [string]$os.Caption
        os_version    = $osVersion
        arch          = [string]$os.OSArchitecture
        cpu_model     = [string]($procs[0].Name).Trim()
        cpu_cores     = [int](($procs | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
        ram_total     = [int64]$cs.TotalPhysicalMemory
        manufacturer  = [string]$cs.Manufacturer
        model         = [string]$cs.Model
        serial        = [string]$bios.SerialNumber
        boot_time     = ConvertTo-UnixMs $os.LastBootUpTime
        agent_version = $MyVersion
    }
}

function Send-Inventory {
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $seen = @{}
    $sw = New-Object System.Collections.ArrayList
    foreach ($item in (Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue)) {
        if (-not $item.DisplayName -or $item.SystemComponent -eq 1 -or $item.ParentKeyName) { continue }
        $key = "$($item.DisplayName)|$($item.DisplayVersion)"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$sw.Add(@{ name = [string]$item.DisplayName; version = [string]$item.DisplayVersion; publisher = [string]$item.Publisher })
    }
    Invoke-Api POST '/api/agent/inventory' @{ software = @($sw) } 120 | Out-Null
    Write-Log "inventory sent ($($sw.Count) packages)"
}

# ---------------- jobs ----------------

$Running = @{}

function Read-Output([string]$Path, [Text.Encoding]$Encoding) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $text = [IO.File]::ReadAllText($Path, $Encoding)
    if ($text.Length -gt $MaxOutput) { $text = $text.Substring($text.Length - $MaxOutput) }
    return $text
}

function Send-Result($JobId, [int]$ExitCode, [string]$Stdout, [string]$Stderr, [bool]$TimedOut) {
    $body = @{ job_id = $JobId; exit_code = $ExitCode; stdout = $Stdout; stderr = $Stderr; timed_out = $TimedOut }
    Invoke-Api POST '/api/agent/result' $body 60 | Out-Null
}

# ---------------- remote control ----------------

$LauncherSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace HostPilot {
  public static class SessionLauncher {
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attrs, int level, int type, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref uint info, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    // Start cmd as SYSTEM inside the active console session (requires running as SYSTEM).
    public static int Launch(string cmd) {
      uint session = WTSGetActiveConsoleSessionId();
      if (session == 0xFFFFFFFF) throw new Exception("No active console session");
      IntPtr token, dup;
      if (!OpenProcessToken(GetCurrentProcess(), 0x02000000, out token)) throw new Win32Exception();
      try {
        if (!DuplicateTokenEx(token, 0x02000000, IntPtr.Zero, 2, 1, out dup)) throw new Win32Exception();
      } finally { CloseHandle(token); }
      try {
        if (!SetTokenInformation(dup, 12, ref session, 4)) throw new Win32Exception();
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = "winsta0\\default";
        PROCESS_INFORMATION pi;
        if (!CreateProcessAsUser(dup, null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, null, ref si, out pi)) throw new Win32Exception();
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        return pi.dwProcessId;
      } finally { CloseHandle(dup); }
    }
  }
}
'@

function Start-RemoteSession($Job) {
    $id = [string]$Job.id
    try {
        $req = [string]$Job.body | ConvertFrom-Json
        $helper = Join-Path $Base 'remote.ps1'
        Invoke-WebRequest -Uri "$Server/agent/remote.ps1" -OutFile $helper -UseBasicParsing -TimeoutSec 30
        $wsBase = $Server -replace '^http', 'ws'
        $cfgFile = Join-Path $Base ("remote-{0}.json" -f ([string]$req.session -replace '[^a-f0-9]', ''))
        $cfgJson = ConvertTo-Json -InputObject @{
            url = "$wsBase/ws/remote?role=host&session=$($req.session)&token=$($req.token)"
            log = (Join-Path $Base 'remote.log')
        }
        [IO.File]::WriteAllText($cfgFile, $cfgJson, (New-Object Text.UTF8Encoding $false))
        $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$helper`" -ConfigPath `"$cfgFile`""

        if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
            if (-not ('HostPilot.SessionLauncher' -as [type])) { Add-Type -TypeDefinition $LauncherSource -Language CSharp }
            $procId = [HostPilot.SessionLauncher]::Launch("`"$ps`" $argLine")
            $how = "as SYSTEM in console session (pid $procId)"
        } else {
            # agent running interactively (testing): just start in this session
            $p = Start-Process -FilePath $ps -ArgumentList $argLine -WindowStyle Hidden -PassThru
            $how = "in current session (pid $($p.Id))"
        }
        Write-Log "remote session $($req.session) started $how"
        Send-Result $id 0 "Remote control helper started $how" '' $false
    } catch {
        Write-Log "remote session failed: $($_.Exception.Message)"
        Send-Result $id 1 '' "Failed to start remote session: $($_.Exception.Message)" $false
    }
}

function Start-AgentJob($Job) {
    $id = [string]$Job.id
    $timeout = [int]$Job.timeout
    if ($timeout -le 0) { $timeout = 300 }

    if ($Job.shell -eq '_remote') { Start-RemoteSession $Job; return }

    if ($Job.shell -eq '_uninstall') {
        Send-Result $id 0 'Agent uninstall scheduled' '' $false
        Write-Log 'uninstall requested by server'
        Set-Content -LiteralPath (Join-Path $Base 'uninstall.flag') -Value '1'
        exit 0
    }

    $stem = Join-Path $JobDir $id
    switch ($Job.shell) {
        'powershell' {
            $file = "$stem.ps1"
            # make the job's stdout/stderr UTF-8 so non-ASCII text (file names, etc.) survives
            $prefix = "try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding `$false } catch {}`r`n"
            [IO.File]::WriteAllText($file, $prefix + [string]$Job.body, (New-Object Text.UTF8Encoding $true))
            $enc = $Utf8
            $exe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
            $argList = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$file`""
        }
        'cmd' {
            $file = "$stem.cmd"
            [IO.File]::WriteAllText($file, "@echo off`r`n" + ([string]$Job.body -replace "`r?`n", "`r`n"), [Text.Encoding]::Default)
            $exe = "$env:SystemRoot\System32\cmd.exe"
            $enc = $Oem
            $argList = "/d /c `"$file`""
        }
        'python' {
            $file = "$stem.py"
            [IO.File]::WriteAllText($file, [string]$Job.body, (New-Object Text.UTF8Encoding $false))
            $py = Get-Command python.exe, py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $py) { Send-Result $id 127 '' 'python is not installed on this device' $false; return }
            $exe = $py.Source
            $argList = "`"$file`""
            $enc = $Utf8
        }
        default {
            Send-Result $id 127 '' "Shell '$($Job.shell)' is not supported on Windows" $false
            return
        }
    }

    try {
        $proc = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $JobDir -NoNewWindow -PassThru `
            -RedirectStandardOutput "$stem.out" -RedirectStandardError "$stem.err"
        $null = $proc.Handle  # keep handle so ExitCode is available later
        $Running[$id] = @{ proc = $proc; stem = $stem; file = $file; enc = $enc; deadline = (Get-Date).AddSeconds($timeout) }
        Write-Log "job $id started ($($Job.shell), timeout ${timeout}s)"
    } catch {
        Send-Result $id 1 '' "Failed to start: $($_.Exception.Message)" $false
    }
}

function Update-Jobs {
    foreach ($id in @($Running.Keys)) {
        $r = $Running[$id]
        if (-not $r.ContainsKey('result')) {
            $p = $r.proc
            $timedOut = $false
            if (-not $p.HasExited) {
                if ((Get-Date) -lt $r.deadline) { continue }
                $timedOut = $true
                & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
                Start-Sleep -Milliseconds 500
            }
            $code = if ($timedOut) { -1 } else { $p.ExitCode }
            if ($null -eq $code) { $code = -1 }
            $r.result = @{ code = [int]$code; out = (Read-Output "$($r.stem).out" $r.enc); err = (Read-Output "$($r.stem).err" $r.enc); timedOut = $timedOut }
        }
        try {
            Send-Result $id $r.result.code $r.result.out $r.result.err $r.result.timedOut
            Remove-Item -LiteralPath $r.file, "$($r.stem).out", "$($r.stem).err" -Force -ErrorAction SilentlyContinue
            $Running.Remove($id)
            Write-Log "job $id finished (exit $($r.result.code))"
        } catch {
            Write-Log "job $id result upload failed, will retry: $($_.Exception.Message)"
        }
    }
}

function Update-Self([string]$Version) {
    if ($Running.Count -gt 0) { return }
    $tmp = "$SelfPath.new"
    Invoke-WebRequest -Uri "$Server/agent/windows.ps1" -OutFile $tmp -UseBasicParsing -TimeoutSec 60
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.Substring(0, 12).ToLower()
    if ($hash -ne $Version) { Remove-Item $tmp -Force; Write-Log "update hash mismatch ($hash != $Version)"; return }
    Move-Item -LiteralPath $tmp -Destination $SelfPath -Force
    Write-Log "updated agent $MyVersion -> $Version, restarting"
    exit 0
}

# ---------------- main loop ----------------

Write-Log "agent $MyVersion starting (server $Server)"
$interval = 60
$lastCheckin = [datetime]::MinValue
$failures = 0

while ($true) {
    try {
        if (((Get-Date) - $lastCheckin).TotalSeconds -ge $interval) {
            $resp = Invoke-Api POST '/api/agent/checkin' (Get-Metrics) 30
            $lastCheckin = Get-Date
            if ($resp.checkin_seconds) { $interval = [Math]::Max(15, [int]$resp.checkin_seconds) }
        }

        if ($Running.Count -gt 0) { $wait = 2 }
        else {
            $left = $interval - ((Get-Date) - $lastCheckin).TotalSeconds
            $wait = [int][Math]::Min(25, [Math]::Max(1, $left))
        }

        $poll = Invoke-Api GET "/api/agent/poll?wait=$wait" $null ($wait + 30)
        if ($poll.jobs) { foreach ($j in @($poll.jobs)) { Start-AgentJob $j } }
        Update-Jobs
        if ($poll.want_inventory) { Send-Inventory }
        if ($poll.version -and $poll.version -ne $MyVersion) { Update-Self ([string]$poll.version) }
        $failures = 0
    } catch {
        $failures++
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        Write-Log "error ($status): $($_.Exception.Message)"
        try { Update-Jobs } catch {}
        if ($status -eq 401) { Start-Sleep -Seconds 300 }
        else { Start-Sleep -Seconds ([Math]::Min(60, 5 * $failures)) }
    }
}
