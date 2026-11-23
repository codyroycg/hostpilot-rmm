# HostPilot RMM agent for Windows (PowerShell 5.1+)
# Runs as SYSTEM under runner.ps1 (scheduled task "HostPilotAgent").
# Config lives next to this file in config.json: { server, agent_id, secret }
#
# Ask the running agent to update itself now (from an elevated prompt on the device):
#   powershell -ExecutionPolicy Bypass -File "C:\ProgramData\HostPilot\agent.ps1" -Update
# Any user can do the same with:  "C:\Program Files\HostPilot\HostPilotTray.exe" /update
param([switch]$Update)

if ($Update) {
    try {
        $ev = [Threading.EventWaitHandle]::OpenExisting('Global\HostPilotUpdateNow')
        [void]$ev.Set()
        Write-Output 'Update requested. The agent will download the latest version and restart within about 30 seconds.'
        exit 0
    } catch {
        Write-Output "The HostPilot agent isn't running (or isn't reachable): $($_.Exception.Message)"
        exit 1
    }
}

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

function Get-IfaceIps($n) {
    # leading comma: keep a one-address result as an array (JSON list)
    return , @($n.GetIPProperties().UnicastAddresses | ForEach-Object { ($_.Address.IPAddressToString -split '%')[0] } |
        Where-Object { $_ -notlike 'fe80*' -and $_ -notlike '169.254.*' })
}

# Network interfaces (incl. VPN adapters and Windows VPN connections) + total byte counters
function Get-NetInfo {
    $vpnRx = 'VPN|TAP-|Wintun|WireGuard|OpenVPN|AnyConnect|Fortinet|FortiClient|GlobalProtect|PANGP|Juniper|Pulse Secure|Ivanti|Zscaler|Tailscale|ZeroTier|NordLynx|SonicWall|Check Point|WatchGuard|Cisco Secure|Mullvad|ProtonVPN|Cloudflare WARP|WAN Miniport'
    $nics = @{}
    foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) { $nics[[string]$n.Id] = $n }
    $make = @{}
    foreach ($w in @(Get-CimInstance Win32_NetworkAdapter -ErrorAction SilentlyContinue)) { if ($w.GUID) { $make[[string]$w.GUID] = [string]$w.Manufacturer } }
    $list = New-Object Collections.ArrayList
    $seen = @{}
    $rx = [int64]0; $tx = [int64]0; $hwRx = [int64]0; $hwTx = [int64]0; $hw = 0
    foreach ($a in @(Get-NetAdapter -ErrorAction SilentlyContinue)) {
        $guid = [string]$a.InterfaceGuid
        $n = $nics[$guid]
        $seen[$guid] = 1
        $seen["name:$($a.Name)"] = 1
        $desc = [string]$a.InterfaceDescription
        $isVpn = ($desc -match $vpnRx) -or ($a.Name -match $vpnRx)
        $kind = if ($isVpn) { 'vpn' }
            elseif ($a.NdisPhysicalMedium -eq 9 -or $a.PhysicalMediaType -match '802\.11|Wireless LAN|Native 802') { 'wifi' }
            elseif ($a.NdisPhysicalMedium -eq 10 -or $a.PhysicalMediaType -match 'Bluetooth') { 'bluetooth' }
            elseif ($a.NdisPhysicalMedium -in 8, 12 -or $a.PhysicalMediaType -match 'Wireless WAN|Mobile') { 'cellular' }
            elseif (-not $a.HardwareInterface) { 'virtual' }
            elseif ($a.MediaType -eq '802.3') { 'ethernet' } else { 'other' }
        $ips = @()
        if ($n) {
            try {
                $ips = Get-IfaceIps $n
                $st = $n.GetIPStatistics()
                $rx += $st.BytesReceived; $tx += $st.BytesSent
                if ($a.HardwareInterface -and -not $isVpn) { $hwRx += $st.BytesReceived; $hwTx += $st.BytesSent; $hw++ }
            } catch {}
        }
        $mk = $make[$guid]; if (-not $mk) { $mk = [string]$a.DriverProvider }
        $up = [string]$a.Status -eq 'Up'
        [void]$list.Add(@{
            name = [string]$a.Name; make = $mk; model = $desc; kind = $kind; connected = $up
            mac = ([string]$a.MacAddress).Replace('-', ':'); speed = $(if ($up) { [int64]$a.ReceiveLinkSpeed } else { 0 }); ips = $ips
        })
    }
    # built-in Windows VPN connections only exist as interfaces while connected
    foreach ($n in $nics.Values) {
        if ([string]$n.NetworkInterfaceType -ne 'Ppp' -or $seen[[string]$n.Id]) { continue }
        $seen["name:$($n.Name)"] = 1
        [void]$list.Add(@{ name = [string]$n.Name; make = 'Microsoft'; model = 'Windows VPN connection'; kind = 'vpn'
            connected = ([string]$n.OperationalStatus -eq 'Up'); mac = ''; speed = 0; ips = (Get-IfaceIps $n) })
    }
    # configured (disconnected) Windows VPN connections from the all-users and per-user phonebooks
    $pbks = @(Join-Path $env:ProgramData 'Microsoft\Network\Connections\Pbk\rasphone.pbk')
    $pbks += @(Get-ChildItem 'C:\Users\*\AppData\Roaming\Microsoft\Network\Connections\Pbk\rasphone.pbk' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($p in $pbks) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $cur = $null
        foreach ($line in [IO.File]::ReadAllLines($p)) {
            if ($line -match '^\[(.+)\]$') { $cur = $Matches[1]; continue }
            if ($cur -and $line -match '^Type=2$' -and -not $seen["name:$cur"]) {
                $seen["name:$cur"] = 1
                [void]$list.Add(@{ name = $cur; make = 'Microsoft'; model = 'Windows VPN connection'; kind = 'vpn'; connected = $false; mac = ''; speed = 0; ips = @() })
            }
        }
    }
    # traffic = physical adapters only (VPN traffic would otherwise be counted twice)
    if ($hw) { $rx = $hwRx; $tx = $hwTx }
    @{ ifaces = @($list); rx = $rx; tx = $tx }
}

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

    $net = $null
    try { $net = Get-NetInfo } catch { Write-Log "network info failed: $($_.Exception.Message)" }

    # per-logical-processor load ("0,0", "0,1", ... = group,core; _Total rows skipped)
    $coreLoad = @()
    try {
        # the formatted counters read 0 on a fresh query; prime them, then read again
        $null = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction Stop
        Start-Sleep -Milliseconds 400
        $coreLoad = @(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction Stop |
            Where-Object { $_.Name -notmatch '_Total' } |
            Sort-Object { $p = $_.Name -split ','; [int]$p[0] * 1000 + [int]$p[-1] } |
            ForEach-Object { [int]$_.PercentProcessorTime })
    } catch {}
    # what kind of machine this is
    $chassis = @()
    try { $chassis = @((Get-CimInstance Win32_SystemEnclosure -ErrorAction Stop).ChassisTypes | ForEach-Object { [int]$_ }) } catch {}
    $virtual = [bool]("$($cs.Manufacturer) $($cs.Model)" -match 'Virtual|VMware|KVM|QEMU|Xen|VirtualBox|Bochs|Parallels|HVM domU|Proxmox')
    # services the server asked us to watch
    $svc = @()
    foreach ($name in @($script:WatchServices)) {
        if (-not $name) { continue }
        $s = Get-Service -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($s) { $svc += @{ name = [string]$s.Name; display = [string]$s.DisplayName; status = ([string]$s.Status).ToLower(); start = ([string]$s.StartType).ToLower() } }
        else { $svc += @{ name = [string]$name; display = ''; status = 'missing'; start = '' } }
    }

    $m = @{
        core_load     = $coreLoad
        chassis       = $chassis
        is_virtual    = $virtual
        pc_type       = [int]$cs.PCSystemType
        services      = $svc
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
    if ($net) { $m.net_ifaces = $net.ifaces; $m.net_rx = $net.rx; $m.net_tx = $net.tx }
    $m
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

    if ($Job.shell -eq '_update') { Update-Forced 'web console' $id; return }

    if ($Job.shell -eq '_uninstall') {
        Send-Result $id 0 'Agent uninstall scheduled' '' $false
        Write-Log 'uninstall requested by server'
        if ($IsSystem) {
            try { Remove-Tray } catch {}
            Remove-Item -Path $StatusKey -Recurse -Force -ErrorAction SilentlyContinue
        }
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

function Get-ShortHash([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.Substring(0, 12).ToLower() }

function Update-Self([string]$Version) {
    if ($Running.Count -gt 0) { return }
    $tmp = "$SelfPath.new"
    Invoke-WebRequest -Uri "$Server/agent/windows.ps1" -OutFile $tmp -UseBasicParsing -TimeoutSec 60
    $hash = Get-ShortHash $tmp
    if ($hash -ne $Version) { Remove-Item $tmp -Force; Write-Log "update hash mismatch ($hash != $Version)"; return }
    Move-Item -LiteralPath $tmp -Destination $SelfPath -Force
    Write-Log "updated agent $MyVersion -> $Version, restarting"
    exit 0
}

# Forced update (web console, tray icon or "agent.ps1 -Update"): re-download the agent, runner and tray
# icon even if the version looks current, then restart. Running jobs are abandoned.
function Update-Forced([string]$Reason, $JobId = $null) {
    Write-Log "forced update requested ($Reason)"
    Set-AgentStatus 'connected' 'Updating'
    $tmp = "$SelfPath.new"
    $runner = Join-Path $Base 'runner.ps1'
    try {
        Invoke-WebRequest -Uri "$Server/agent/windows.ps1" -OutFile $tmp -UseBasicParsing -TimeoutSec 60
        Invoke-WebRequest -Uri "$Server/agent/runner.ps1" -OutFile "$runner.new" -UseBasicParsing -TimeoutSec 60
        $new = Get-ShortHash $tmp
        if ($JobId) { Send-Result $JobId 0 "Updating agent $MyVersion -> $new and restarting. The device reconnects within a minute." '' $false }
        Move-Item -LiteralPath "$runner.new" -Destination $runner -Force
        Move-Item -LiteralPath $tmp -Destination $SelfPath -Force
        $script:TrayVersionSeen = $null
        try { if ($script:TrayVersion) { Install-Tray $script:TrayVersion -Force } } catch { Write-Log "tray reinstall failed: $($_.Exception.Message)" }
        Write-Log "forced update $MyVersion -> $new, restarting"
        exit 0
    } catch {
        Remove-Item -LiteralPath $tmp, "$runner.new" -Force -ErrorAction SilentlyContinue
        Write-Log "forced update failed: $($_.Exception.Message)"
        if ($JobId) { try { Send-Result $JobId 1 '' "Update failed: $($_.Exception.Message)" $false } catch {} }
    }
}

# ---------------- status for the tray icon ----------------
# HKLM\SOFTWARE\HostPilot is readable by every user; the tray icon (HostPilotTray.exe) shows it.

$IsSystem = [Security.Principal.WindowsIdentity]::GetCurrent().IsSystem
$script:WatchServices = @()
$StatusKey = 'HKLM:\SOFTWARE\HostPilot'
$script:LastContact = 0

function Set-AgentStatus([string]$State, [string]$Message = '') {
    if (-not $IsSystem) { return }
    try {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($State -eq 'connected') { $script:LastContact = $now }
        if (-not (Test-Path $StatusKey)) { New-Item -Path $StatusKey -Force | Out-Null }
        $vals = @{ State = $State; Message = $Message; Heartbeat = [string]$now; LastContact = [string]$script:LastContact; Server = $Server; Version = $MyVersion }
        # lets the tray icon (running as the signed-in user) open this device's chat with technicians
        if ($script:ChatToken) { $vals.ChatToken = $script:ChatToken }
        foreach ($k in $vals.Keys) { Set-ItemProperty -Path $StatusKey -Name $k -Value $vals[$k] -Type String }
    } catch {}
}

# Named event the tray icon / "agent.ps1 -Update" signal to request an update. Authenticated users may
# signal it (Synchronize|Modify) but nothing else.
$UpdateEvent = $null
try {
    $sec = New-Object Security.AccessControl.EventWaitHandleSecurity
    $sid = { param($s) New-Object Security.Principal.SecurityIdentifier $s }
    $sec.AddAccessRule((New-Object Security.AccessControl.EventWaitHandleAccessRule((& $sid 'S-1-5-18'), 'FullControl', 'Allow')))
    $sec.AddAccessRule((New-Object Security.AccessControl.EventWaitHandleAccessRule((& $sid 'S-1-5-32-544'), 'FullControl', 'Allow')))
    $sec.AddAccessRule((New-Object Security.AccessControl.EventWaitHandleAccessRule((& $sid 'S-1-5-11'), 'Synchronize, Modify', 'Allow')))
    $created = $false
    $UpdateEvent = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, 'Global\HostPilotUpdateNow', [ref]$created, $sec)
} catch { Write-Log "update request event unavailable: $($_.Exception.Message)" }

# ---------------- tray icon ----------------

$TrayDir = Join-Path $env:ProgramFiles 'HostPilot'
$TrayExe = Join-Path $TrayDir 'HostPilotTray.exe'
$script:TrayVersion = $null
$script:TrayVersionSeen = $null

function Remove-Tray {
    Unregister-ScheduledTask -TaskName 'HostPilotTray' -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process -Name HostPilotTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $TrayDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Installs/updates HostPilotTray.exe and a logon task (group "Users", so it runs in every user's session).
function Install-Tray([string]$Version, [switch]$Force) {
    if (-not $IsSystem) { return }
    if (-not $Version) { if (Test-Path -LiteralPath $TrayExe) { Remove-Tray; Write-Log 'tray icon removed (disabled on server)' }; return }
    $changed = $false
    $cur = if (Test-Path -LiteralPath $TrayExe) { Get-ShortHash $TrayExe } else { '' }
    if ($Force -or $cur -ne $Version) {
        New-Item -ItemType Directory -Force -Path $TrayDir | Out-Null
        $tmp = "$TrayExe.new"
        Invoke-WebRequest -Uri "$Server/agent/tray.exe" -OutFile $tmp -UseBasicParsing -TimeoutSec 60
        $h = Get-ShortHash $tmp
        if ($h -ne $Version) { Remove-Item -LiteralPath $tmp -Force; Write-Log "tray hash mismatch ($h != $Version)"; return }
        if ($h -ne $cur) {
            Get-Process -Name HostPilotTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
            Remove-Item -LiteralPath "$TrayExe.old" -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $TrayExe) {
                try { Remove-Item -LiteralPath $TrayExe -Force } catch { Move-Item -LiteralPath $TrayExe -Destination "$TrayExe.old" -Force }
            }
            Move-Item -LiteralPath $tmp -Destination $TrayExe -Force
            $changed = $true
            Write-Log "tray icon installed ($h)"
        } else { Remove-Item -LiteralPath $tmp -Force }
    }
    if (-not (Get-ScheduledTask -TaskName 'HostPilotTray' -ErrorAction SilentlyContinue)) {
        $action = New-ScheduledTaskAction -Execute $TrayExe
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel
        Register-ScheduledTask -TaskName 'HostPilotTray' -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
            -Description 'HostPilot agent status icon' -Force | Out-Null
        $changed = $true
    }
    # start it in the sessions of users who are already logged on (the exe exits if already running)
    if ($changed -or -not $script:TrayStarted) {
        Start-ScheduledTask -TaskName 'HostPilotTray' -ErrorAction SilentlyContinue
        $script:TrayStarted = $true
    }
}

# ---------------- main loop ----------------

Write-Log "agent $MyVersion starting (server $Server)"
$interval = 60
$lastCheckin = [datetime]::MinValue
$failures = 0

while ($true) {
    try {
        if ($UpdateEvent -and $UpdateEvent.WaitOne(0)) { Update-Forced 'requested on this computer' }
        if (((Get-Date) - $lastCheckin).TotalSeconds -ge $interval) {
            $resp = Invoke-Api POST '/api/agent/checkin' (Get-Metrics) 30
            $lastCheckin = Get-Date
            if ($resp.checkin_seconds) { $interval = [Math]::Max(15, [int]$resp.checkin_seconds) }
            if ($null -ne $resp.watch_services) { $script:WatchServices = @($resp.watch_services) }
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
        $failures = 0
        if ($poll.chat_token) { $script:ChatToken = [string]$poll.chat_token }
        Set-AgentStatus 'connected'
        if ($null -ne $poll.tray_version) {
            $script:TrayVersion = [string]$poll.tray_version
            if ($script:TrayVersion -ne $script:TrayVersionSeen) {
                $script:TrayVersionSeen = $script:TrayVersion
                try { Install-Tray $script:TrayVersion } catch { Write-Log "tray install failed: $($_.Exception.Message)" }
            }
        }
        if ($poll.version -and $poll.version -ne $MyVersion) { Update-Self ([string]$poll.version) }
    } catch {
        $failures++
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        Write-Log "error ($status): $($_.Exception.Message)"
        Set-AgentStatus 'disconnected' $(if ($status) { "Server answered HTTP $status" } else { $_.Exception.Message })
        try { Update-Jobs } catch {}
        if ($status -eq 401) { Start-Sleep -Seconds 300 }
        else { Start-Sleep -Seconds ([Math]::Min(60, 5 * $failures)) }
    }
}
