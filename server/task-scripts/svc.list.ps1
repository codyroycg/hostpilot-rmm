# HostPilot task: services
# Output: S\tname\tdisplay\tstate(running|stopped|...)\tstart(auto|manual|disabled|...)\taccount\tpid\tdescription
#__ARGS__
foreach ($s in Get-CimInstance Win32_Service) {
    $start = switch ($s.StartMode) { 'Auto' { if ($s.DelayedAutoStart) { 'auto (delayed)' } else { 'auto' } } default { ([string]$s.StartMode).ToLower() } }
    $f = @($s.Name, $s.DisplayName, ([string]$s.State).ToLower(), $start, $s.StartName, $s.ProcessId, $s.Description) | ForEach-Object { ([string]$_ -replace "[`t`r`n]", ' ') }
    "S`t" + ($f -join "`t")
}
