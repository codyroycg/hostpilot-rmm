# name: Pending reboot check
# category: Patching
# description: Checks every place Windows records that a restart is needed (updates, servicing, file renames, rename of the computer, SCCM) and says why
# timeout: 60
$why = @()
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { $why += 'Windows component servicing (CBS)' }
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $why += 'Windows Update' }
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\PackagesPending') { $why += 'Pending servicing packages' }
$pfro = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations
if ($pfro) { $why += "Pending file renames ($(@($pfro | Where-Object { $_ }).Count / 2) operations, usually an installer)" }
$active = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName' -ErrorAction SilentlyContinue).ComputerName
$pending = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName' -ErrorAction SilentlyContinue).ComputerName
if ($active -and $pending -and $active -ne $pending) { $why += "Computer rename ($active -> $pending)" }
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Updates\UpdateExeVolatile') { $why += 'Update installer (UpdateExeVolatile)' }
try { $c = Invoke-CimMethod -Namespace root\ccm\ClientSDK -ClassName CCM_ClientUtilities -MethodName DetermineIfRebootPending -ErrorAction Stop
  if ($c.RebootPending -or $c.IsHardRebootPending) { $why += 'Configuration Manager (SCCM) client' } } catch { }
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
"Last boot: $($boot.ToString('yyyy-MM-dd HH:mm')) ($([math]::Floor(((Get-Date) - $boot).TotalDays)) days ago)"
if ($why) { 'A restart IS pending:'; $why | ForEach-Object { "  - $_" } } else { 'No restart is pending.' }
