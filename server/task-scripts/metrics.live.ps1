# HostPilot task: live performance samples every 2 s until the server answers "stop"
#__ARGS__
#__INCLUDE:_server.ps1__
$ErrorActionPreference = 'Continue'
$url = "$HP$($A['url'])"
$wc = New-Object Net.WebClient
$fails = 0
$deadline = (Get-Date).AddMinutes(55)
# network traffic: physical adapters (VPN traffic would otherwise be counted twice); fall back to all
$vpnRx = 'VPN|TAP-|Wintun|WireGuard|OpenVPN|AnyConnect|Fortinet|GlobalProtect|PANGP|Zscaler|Tailscale|ZeroTier|NordLynx|WAN Miniport'
$hwIds = @{}
try { Get-NetAdapter -ErrorAction Stop | Where-Object { $_.HardwareInterface -and $_.InterfaceDescription -notmatch $vpnRx } | ForEach-Object { $hwIds[[string]$_.InterfaceGuid] = 1 } } catch {}
function Get-NetBytes {
    $r = [int64]0; $t = [int64]0
    foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($hwIds.Count) { if (-not $hwIds[[string]$n.Id]) { continue } }
        elseif ([string]$n.NetworkInterfaceType -in 'Loopback', 'Tunnel') { continue }
        try { $s = $n.GetIPStatistics(); $r += $s.BytesReceived; $t += $s.BytesSent } catch {}
    }
    @($r, $t, [Diagnostics.Stopwatch]::GetTimestamp())
}
$prevNet = Get-NetBytes
while ((Get-Date) -lt $deadline -and $fails -lt 5) {
    $t0 = Get-Date
    try {
        $nowNet = Get-NetBytes
        $secs = ($nowNet[2] - $prevNet[2]) / [Diagnostics.Stopwatch]::Frequency
        $rxr = '-'; $txr = '-'
        if ($secs -gt 0 -and $nowNet[0] -ge $prevNet[0] -and $nowNet[1] -ge $prevNet[1]) {
            $rxr = [math]::Round(($nowNet[0] - $prevNet[0]) / $secs); $txr = [math]::Round(($nowNet[1] - $prevNet[1]) / $secs)
        }
        $prevNet = $nowNet
        # one query gives the total and every logical CPU
        $procs = @(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor)
        $cpu = ($procs | Where-Object { $_.Name -eq '_Total' }).PercentProcessorTime
        $cores = ($procs | Where-Object { $_.Name -ne '_Total' } | Sort-Object { $n = 0; [void][int]::TryParse(($_.Name -replace '\D', ''), [ref]$n); $n } |
            ForEach-Object { [string]$_.PercentProcessorTime }) -join ','
        if (-not $cores) { $cores = '-' }
        $os = Get-CimInstance Win32_OperatingSystem
        $mem = [math]::Round((1 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize)) * 100, 1)
        $disk = (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.Size -gt 0 } |
            ForEach-Object { (1 - $_.FreeSpace / $_.Size) * 100 } | Measure-Object -Maximum).Maximum
        if ($null -eq $disk) { $disk = 0 }  # an empty field would shift the ones after it
        $line = [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0} {1} {2:0.0} {3} {4} {5}', $cpu, $mem, $disk, $rxr, $txr, $cores)
        $r = $wc.UploadString($url, 'POST', $line)
        $fails = 0
        if ($r.Trim() -eq 'stop') { break }
    } catch { $fails++ }
    $left = 2000 - ((Get-Date) - $t0).TotalMilliseconds
    if ($left -gt 0) { Start-Sleep -Milliseconds $left }
}
'Live monitoring ended'
