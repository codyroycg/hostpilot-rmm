# HostPilot task: send Wake-on-LAN magic packets to sleeping machines on this device's network
#__ARGS__
$macs = @($A['macs'] -split ',' | Where-Object { $_ })
$targets = @($A['bcasts'] -split ',' | Where-Object { $_ })
$udp = New-Object Net.Sockets.UdpClient
$udp.EnableBroadcast = $true
$sent = 0
foreach ($mac in $macs) {
    $bytes = [byte[]]($mac -split '[:-]' | ForEach-Object { [Convert]::ToByte($_, 16) })
    $packet = [byte[]](@(0xFF) * 6 + (@($bytes) * 16))
    foreach ($t in $targets) {
        foreach ($port in 9, 7) {
            for ($i = 0; $i -lt 3; $i++) {
                try { [void]$udp.Send($packet, $packet.Length, $t, $port); $sent++ } catch { Write-Output "Could not send to ${t}:${port}: $($_.Exception.Message)" }
            }
        }
    }
    Write-Output "Magic packet sent for $mac via $($targets -join ', ')"
}
$udp.Close()
if (-not $sent) { throw 'No magic packets could be sent' }
