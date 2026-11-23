# HostPilot task: printers (print queues) and printer/scanner hardware, connected or not
# Output:
#   P\tname\tdriver\tport\tstatus\tconnected 0|1|-\tshared 0|1\tdefault 0|1\tlocation\tvirtual 0|1
#   H\tkind printer|scanner\tconnected 0|1\tname\tmanufacturer\tlast_arrival_unix\tinstance_id
#__ARGS__
$ErrorActionPreference = 'Continue'
function Clean($v) { ([string]$v -replace "[`t`r`n]", ' ').Trim() }
function UnixOf($v) { if ($v -is [datetime]) { ([DateTimeOffset]$v).ToUnixTimeSeconds() } else { '' } }

$default = ''
try { $default = [string](Get-CimInstance Win32_Printer -Filter 'Default=TRUE' -ErrorAction Stop | Select-Object -First 1).Name } catch {}
foreach ($p in @(Get-Printer -ErrorAction SilentlyContinue)) {
    $port = [string]$p.PortName
    $virtual = [int]($port -match '^(nul:|PORTPROMPT:|SHRFAX:|FILE:|XPSPort:|OneNote)' -or $p.DriverName -match 'PDF|XPS|OneNote|Fax')
    $status = [string]$p.PrinterStatus
    $conn = if ($virtual) { '-' } elseif ($status -match 'Offline|NotAvailable|Error' -or $p.WorkOffline) { '0' } else { '1' }
    $fields = @($p.Name, $p.DriverName, $port, $status, $conn, [int][bool]$p.Shared, [int]($p.Name -eq $default), $p.Location, $virtual) | ForEach-Object { Clean $_ }
    "P`t" + ($fields -join "`t")
}

# physical devices: printers (incl. network/WSD) and scanners; cameras are excluded
$hw = @(Get-PnpDevice -Class Printer, WSDPrintDevice, Image -ErrorAction SilentlyContinue | Where-Object {
    $_.FriendlyName -and $_.FriendlyName -notmatch 'camera|webcam' -and $_.InstanceId -notlike 'SWD\PRINTENUM\*' })
$arr = @{}
if ($hw.Count) {
    foreach ($x in @(Get-PnpDeviceProperty -InstanceId $hw.InstanceId -KeyName 'DEVPKEY_Device_LastArrivalDate' -ErrorAction SilentlyContinue)) {
        if (-not $arr.ContainsKey($x.InstanceId)) { $arr[$x.InstanceId] = $x.Data }
    }
}
foreach ($d in $hw) {
    $kind = if ([string]$d.Class -eq 'Image') { 'scanner' } else { 'printer' }
    $fields = @($kind, [int][bool]$d.Present, $d.FriendlyName, $d.Manufacturer, (UnixOf $arr[$d.InstanceId]), $d.InstanceId) | ForEach-Object { Clean $_ }
    "H`t" + ($fields -join "`t")
}
