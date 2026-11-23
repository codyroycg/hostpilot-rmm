# HostPilot task: live performance samples every 2 s until the server answers "stop"
#__ARGS__
#__INCLUDE:_server.ps1__
$ErrorActionPreference = 'Continue'
$url = "$HP$($A['url'])"
$wc = New-Object Net.WebClient
$fails = 0
$deadline = (Get-Date).AddMinutes(55)
while ((Get-Date) -lt $deadline -and $fails -lt 5) {
    $t0 = Get-Date
    try {
        $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
        $os = Get-CimInstance Win32_OperatingSystem
        $mem = [math]::Round((1 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize)) * 100, 1)
        $disk = (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.Size -gt 0 } |
            ForEach-Object { (1 - $_.FreeSpace / $_.Size) * 100 } | Measure-Object -Maximum).Maximum
        $line = [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0} {1} {2:0.0}', $cpu, $mem, $disk)
        $r = $wc.UploadString($url, 'POST', $line)
        $fails = 0
        if ($r.Trim() -eq 'stop') { break }
    } catch { $fails++ }
    $left = 2000 - ((Get-Date) - $t0).TotalMilliseconds
    if ($left -gt 0) { Start-Sleep -Milliseconds $left }
}
'Live monitoring ended'
