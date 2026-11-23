# HostPilot task: reinstall an installed program by name via winget (--force)
#__ARGS__
#__INCLUDE:_winget.ps1__
$code = Invoke-Winget @('install', '--name', $A['name'], '--exact', '--force', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
if ($code -ne 0) { Write-Output "winget could not match '$($A['name'])' exactly. Use 'Install software' with the winget ID instead." }
exit $code
