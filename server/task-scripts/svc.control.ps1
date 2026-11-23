# HostPilot task: start / stop / restart a service or change its startup type
#__ARGS__
$n = $A['name']
$s = Get-Service -Name $n -ErrorAction Stop
switch ($A['action']) {
    'start' { Start-Service -Name $n }
    'stop' { Stop-Service -Name $n -Force }
    'restart' { Restart-Service -Name $n -Force }
    'auto' { Set-Service -Name $n -StartupType Automatic }
    'manual' { Set-Service -Name $n -StartupType Manual }
    'disabled' { Set-Service -Name $n -StartupType Disabled }
}
$s = Get-Service -Name $n
"$($s.DisplayName): $($s.Status), $($s.StartType)"
