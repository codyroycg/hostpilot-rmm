# name: Disk health
# category: Hardware
# description: Physical disk health and wear (SMART counters where available) plus free space on every volume
# timeout: 120
'=== Physical disks ==='
Get-PhysicalDisk | Sort-Object DeviceId | ForEach-Object {
  $r = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Disk     = $_.DeviceId
    Model    = $_.FriendlyName
    Type     = $_.MediaType
    SizeGB   = [math]::Round($_.Size / 1GB)
    Health   = $_.HealthStatus
    Status   = ($_.OperationalStatus -join ', ')
    'Wear%'  = $r.Wear
    TempC    = $r.Temperature
    ReadErr  = $r.ReadErrorsUncorrected
    PowerOnH = $r.PowerOnHours
  }
} | Format-Table -AutoSize | Out-String -Width 200
'=== Volumes ==='
Get-Volume | Where-Object { $_.DriveLetter -and $_.Size -gt 0 } | Sort-Object DriveLetter | ForEach-Object {
  [pscustomobject]@{
    Drive  = "$($_.DriveLetter):"
    Label  = $_.FileSystemLabel
    FS     = $_.FileSystem
    SizeGB = [math]::Round($_.Size / 1GB, 1)
    FreeGB = [math]::Round($_.SizeRemaining / 1GB, 1)
    'Free%' = [math]::Round(100 * $_.SizeRemaining / $_.Size)
    Health = $_.HealthStatus
  }
} | Format-Table -AutoSize | Out-String
$bad = @(Get-PhysicalDisk | Where-Object { $_.HealthStatus -ne 'Healthy' })
if ($bad.Count) { "WARNING: $($bad.Count) disk(s) are not healthy. Back up this computer."; exit 1 }
'All disks report healthy.'
