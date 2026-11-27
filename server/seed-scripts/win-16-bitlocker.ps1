# name: BitLocker status
# category: Security
# description: Encryption status and protection of every drive, plus whether the recovery key is backed up to Active Directory or Entra ID
# timeout: 60
try { $vols = Get-BitLockerVolume -ErrorAction Stop }
catch {
  if ($_.Exception -is [UnauthorizedAccessException] -or "$($_.Exception.Message)" -match 'denied') { 'Reading BitLocker status needs administrator rights.'; exit 1 }
  'BitLocker is not available on this edition of Windows (Home editions only have Device Encryption).'; exit 0
}
$vols | ForEach-Object {
  [pscustomobject]@{
    Drive      = $_.MountPoint
    Type       = $_.VolumeType
    Status     = $_.VolumeStatus
    'Encrypted%' = $_.EncryptionPercentage
    Protection = $_.ProtectionStatus
    Method     = $_.EncryptionMethod
    Protectors = ($_.KeyProtector | ForEach-Object { $_.KeyProtectorType }) -join ', '
  }
} | Format-Table -AutoSize | Out-String -Width 200
$os = $vols | Where-Object { $_.VolumeType -eq 'OperatingSystem' }
if ($os -and $os.ProtectionStatus -ne 'On') { 'WARNING: the system drive is not protected by BitLocker.' }
$backed = Get-WinEvent -LogName 'Microsoft-Windows-BitLocker/BitLocker Management' -ErrorAction SilentlyContinue -MaxEvents 200 |
  Where-Object { $_.Id -in 845, 784 } | Select-Object -First 1
if ($backed) { "Last recovery key backup: $($backed.TimeCreated) ($(if ($backed.Id -eq 845) { 'Entra ID' } else { 'Active Directory' }))" }
else { 'No recovery key backup to Active Directory / Entra ID found in the event log.' }
