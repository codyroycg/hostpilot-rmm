# locate winget.exe (works when running as SYSTEM, where winget is not on PATH)
function Get-WingetPath {
    $c = Get-ChildItem -Path "$env:ProgramFiles\WindowsApps\Microsoft.DesktopAppInstaller_*__8wekyb3d8bbwe\winget.exe" -ErrorAction SilentlyContinue |
        Sort-Object { $_.Directory.Name } | Select-Object -Last 1
    if ($c) { return $c.FullName }
    $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'winget is not available on this device. It ships with Windows 10 (1809+) / 11 / Server 2025 via "App Installer".'
}
function Invoke-Winget([string[]]$WingetArgs) {
    $wg = Get-WingetPath
    $out = & $wg @WingetArgs 2>&1 | ForEach-Object { "$_" }
    # drop spinner / progress-bar noise
    $code = $LASTEXITCODE
    # print (not return) the output so callers only get the exit code back
    $out | Where-Object { $_ -and $_ -notmatch '^\s*[-\\|/]\s*$' -and $_ -notmatch '[▀-▟]' } | ForEach-Object { Write-Host $_ }
    return $code
}
