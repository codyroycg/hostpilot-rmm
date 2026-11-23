# Builds server/agents/HostPilotSetup.exe and server/agents/HostPilotTray.exe with the C# compiler that
# ships with Windows (.NET Framework 4.x). Run from any folder:  powershell -ExecutionPolicy Bypass -File setup\build.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }

$out = Join-Path $here '..\server\agents\HostPilotSetup.exe'
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/win32manifest:$here\app.manifest" `
    /reference:System.Windows.Forms.dll "/out:$out" "$here\HostPilotSetup.cs"
if ($LASTEXITCODE) { throw "csc failed ($LASTEXITCODE)" }
Write-Host "Built $((Resolve-Path $out).Path)"

# Tray icon: runs as the logged-in user (asInvoker); /target:winexe so no console window appears.
$out = Join-Path $here '..\server\agents\HostPilotTray.exe'
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/win32manifest:$here\tray.manifest" `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$out" "$here\HostPilotTray.cs"
if ($LASTEXITCODE) { throw "csc failed ($LASTEXITCODE)" }
Write-Host "Built $((Resolve-Path $out).Path)"
