# HostPilot task: physical disks with SMART / reliability data
# Output: D\tid\tmake\tmodel\tserial\tsize\tmedia\tbus\thealth\ttemp_c\tpower_on_hours\twear_pct\treallocated\terrors\tvolumes\tfirmware\tnote
#__ARGS__
$ErrorActionPreference = 'Continue'
function Clean($v) { ([string]$v -replace "[`t`r`n]", ' ').Trim() }

$vols = @{}
foreach ($p in @(Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter })) {
    $k = [string]$p.DiskNumber
    if (-not $vols.ContainsKey($k)) { $vols[$k] = New-Object Collections.ArrayList }
    [void]$vols[$k].Add("$($p.DriveLetter):")
}
$predict = @{}
try {
    foreach ($s in @(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop)) {
        $predict[([string]$s.InstanceName).ToUpper()] = [bool]$s.PredictFailure
    }
} catch {}
$wmiDisks = @(Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue)

foreach ($d in @(Get-PhysicalDisk | Sort-Object { [int]$_.DeviceId })) {
    $rel = $null
    try { $rel = $d | Get-StorageReliabilityCounter -ErrorAction Stop } catch {}
    $note = if ($rel) { '' } else { 'SMART counters unavailable (needs admin, or not supported by this disk/controller)' }
    $health = switch ([string]$d.HealthStatus) { 'Healthy' { 'OK' } 'Warning' { 'Warning' } 'Unhealthy' { 'Failing' } default { 'Unknown' } }
    # the drive's own SMART failure prediction (via the storage driver)
    $wd = $wmiDisks | Where-Object { $_.Index -eq [int]$d.DeviceId } | Select-Object -First 1
    if ($wd -and $wd.PNPDeviceID) {
        $key = ($predict.Keys | Where-Object { $_ -like ("$($wd.PNPDeviceID)*").ToUpper() } | Select-Object -First 1)
        if ($key -and $predict[$key]) { $health = 'Failing'; $note = 'The drive predicts a failure (SMART). Back up and replace it.' }
    }
    $media = [string]$d.MediaType
    if ([string]$d.BusType -eq 'NVMe') { $media = 'NVMe SSD' } elseif ($media -eq 'Unspecified') { $media = '' }
    # every field must stay in place even when empty (a bare $(if ...) with no value would drop out of the array)
    $errs = ''; $temp = ''; $poh = ''; $wear = ''
    if ($rel) {
        $errs = [string]([int64]$rel.ReadErrorsUncorrected + [int64]$rel.WriteErrorsUncorrected)
        if ($rel.Temperature) { $temp = [string]$rel.Temperature }
        if ($null -ne $rel.PowerOnHours) { $poh = [string]$rel.PowerOnHours }
        if ($null -ne $rel.Wear) { $wear = [string]$rel.Wear }
    }
    $volList = ''
    if ($vols.ContainsKey([string]$d.DeviceId)) { $volList = @($vols[[string]$d.DeviceId]) -join ' ' }
    $fields = @(
        $d.DeviceId, $d.Manufacturer, $d.Model, $d.SerialNumber, [int64]$d.Size, $media, $d.BusType, $health,
        $temp, $poh, $wear, '', $errs, $volList, $d.FirmwareVersion, $note
    ) | ForEach-Object { Clean $_ }
    "D`t" + ($fields -join "`t")
}
