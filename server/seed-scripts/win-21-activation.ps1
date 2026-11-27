# name: Windows activation and license
# category: Inventory
# description: Windows edition, activation state, license channel (Retail, OEM, Volume) and the last 5 characters of the product key
# timeout: 60
$os = Get-CimInstance Win32_OperatingSystem
$lic = Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" |
  Select-Object -First 1
$states = @{ 0 = 'Unlicensed'; 1 = 'Licensed (activated)'; 2 = 'Out-of-box grace period'; 3 = 'Out-of-tolerance grace'; 4 = 'Non-genuine grace'; 5 = 'Notification (not activated)'; 6 = 'Extended grace' }
"Edition:        $($os.Caption) ($($os.OSArchitecture))"
"Version:        $($os.Version)"
if ($lic) {
  "Status:         $($states[[int]$lic.LicenseStatus])"
  "Channel:        $($lic.ProductKeyChannel)"
  "Description:    $($lic.Description)"
  "Partial key:    XXXXX-XXXXX-XXXXX-XXXXX-$($lic.PartialProductKey)"
  if ($lic.GracePeriodRemaining -gt 0 -and $lic.LicenseStatus -ne 1) { "Grace left:     $([math]::Round($lic.GracePeriodRemaining / 1440)) days" }
  if ($lic.LicenseStatus -ne 1) { exit 1 }
} else { 'No Windows license found.'; exit 1 }
$bios = (Get-CimInstance SoftwareLicensingService).OA3xOriginalProductKey
if ($bios) { "Firmware key:   present (ends $($bios.Substring($bios.Length - 5)))" }
