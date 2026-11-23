# HostPilot task: silently uninstall a program by its display name
# Order: MSI product code -> QuietUninstallString -> winget -> msiexec-based UninstallString
#__ARGS__
#__INCLUDE:_winget.ps1__
$name = $A['name']
$keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
$e = Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $name } | Select-Object -First 1
if (-not $e) { throw "'$name' was not found in the installed programs list." }

function Invoke-Cmd([string]$cmdLine) {
    Write-Host "> $cmdLine"
    $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/d /c `"$cmdLine`"" -Wait -PassThru -WindowStyle Hidden
    return $p.ExitCode
}
function Test-Ok([int]$code) { return $code -in 0, 1605, 1614, 1641, 3010 }

if ($e.WindowsInstaller -eq 1 -and $e.PSChildName -match '^\{[0-9A-Fa-f-]{36}\}$') {
    $code = Invoke-Cmd "msiexec.exe /x $($e.PSChildName) /qn /norestart"
    Write-Output "msiexec exit code $code$(if ($code -eq 3010) { ' (reboot required)' })"
    if (Test-Ok $code) { exit 0 } else { exit $code }
}
if ($e.QuietUninstallString) {
    $code = Invoke-Cmd $e.QuietUninstallString
    Write-Output "exit code $code"
    if (Test-Ok $code) { exit 0 } else { exit $code }
}
try {
    $code = Invoke-Winget @('uninstall', '--name', $name, '--exact', '--silent', '--accept-source-agreements', '--disable-interactivity')
    if ($code -eq 0) { exit 0 }
    Write-Output "winget uninstall failed (exit $code)"
} catch { Write-Output $_.Exception.Message }
if ($e.UninstallString -match 'msiexec') {
    $cmd = ($e.UninstallString -replace '/I', '/X') + ' /qn /norestart'
    $code = Invoke-Cmd $cmd
    if (Test-Ok $code) { exit 0 } else { exit $code }
}
Write-Error "No silent uninstall method is known for '$name'. Its uninstaller is: $($e.UninstallString). Run it with the right silent switch via Run command, or uninstall it during a remote control session."
exit 1
