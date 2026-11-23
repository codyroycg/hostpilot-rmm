# HostPilot task: USB devices, connected now or seen before (Windows remembers every device it has installed)
# Output: U\tconnected 0|1\tname\tmanufacturer\tclass\tvid\tpid\tserial\thub 0|1\tlast_arrival_unix\tlast_removal_unix\tinstance_id
#__ARGS__
$ErrorActionPreference = 'Continue'
function Clean($v) { ([string]$v -replace "[`t`r`n]", ' ').Trim() }
function UnixOf($v) { if ($v -is [datetime]) { ([DateTimeOffset]$v).ToUnixTimeSeconds() } else { '' } }

$devs = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
    $_.InstanceId -like 'USB\*' -and $_.InstanceId -notlike 'USB\ROOT_HUB*' -and $_.InstanceId -notmatch '&MI_[0-9A-F]{2}'
})
$props = @{}
if ($devs.Count) {
    foreach ($p in @(Get-PnpDeviceProperty -InstanceId $devs.InstanceId -ErrorAction SilentlyContinue `
            -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc', 'DEVPKEY_Device_LastArrivalDate', 'DEVPKEY_Device_LastRemovalDate')) {
        $k = "$($p.InstanceId)|$($p.KeyName)"
        if (-not $props.ContainsKey($k) -and $null -ne $p.Data) { $props[$k] = $p.Data }
    }
}
foreach ($d in $devs) {
    $id = [string]$d.InstanceId
    $bus = @($props["$id|DEVPKEY_Device_BusReportedDeviceDesc"])[0]
    $name = [string]$d.FriendlyName
    if ($bus -and ($name -match '^(USB (Composite|Input|Mass Storage) Device|Generic USB Hub|USB Serial Device.*)$' -or -not $name)) { $name = [string]$bus }
    elseif (-not $name) { $name = [string]$d.Description }
    $vid = ''; $pidv = ''; $serial = ''
    if ($id -match 'VID_([0-9A-F]{4})') { $vid = $Matches[1] }
    if ($id -match 'PID_([0-9A-F]{4})') { $pidv = $Matches[1] }
    $last = ($id -split '\\')[-1]
    if ($last -notmatch '&') { $serial = $last }   # Windows-generated ids contain '&'; real serials don't
    $hub = [int]([string]$d.Class -eq 'USB' -and ($name -match 'hub' -or [string]$bus -match 'hub'))
    $mfr = [string]$d.Manufacturer
    if ($mfr -match '^\(Standard|^Compatible USB|^Microsoft$' -and $name -notmatch 'Microsoft|Xbox') { $mfr = '' }
    $fields = @([int][bool]$d.Present, $name, $mfr, $d.Class, $vid, $pidv, $serial, $hub,
        (UnixOf (@($props["$id|DEVPKEY_Device_LastArrivalDate"])[0])), (UnixOf (@($props["$id|DEVPKEY_Device_LastRemovalDate"])[0])), $id) |
        ForEach-Object { Clean $_ }
    "U`t" + ($fields -join "`t")
}
