# HostPilot task: install (or upgrade) a package with winget, machine-wide
#__ARGS__
#__INCLUDE:_winget.ps1__
$common = @('--id', $A['id'], '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
$code = Invoke-Winget (@('install') + $common + @('--scope', 'machine'))
if ($code -ne 0) {
    Write-Output '--- retrying without machine scope ---'
    $code = Invoke-Winget (@('install') + $common)
}
exit $code
