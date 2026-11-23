# name: Defender status + quick scan
# category: Security
# description: Shows Microsoft Defender health and signature age, then runs a quick scan
# timeout: 3600
Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, QuickScanAge, FullScanAge | Format-List | Out-String
Update-MpSignature -ErrorAction SilentlyContinue
Start-MpScan -ScanType QuickScan
"Quick scan complete. Recent threats:"
Get-MpThreatDetection | Select-Object -First 10 InitialDetectionTime, ThreatID, ActionSuccess, Resources | Format-List | Out-String
