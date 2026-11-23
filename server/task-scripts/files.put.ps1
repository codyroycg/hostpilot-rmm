# HostPilot task: download a file from the server onto this device
#__ARGS__
#__INCLUDE:_server.ps1__
$dest = $A['path']
$dir = Split-Path -Parent $dest
if ($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Folder does not exist: $dir" }
$tmp = "$dest.hpdownload"
(New-Object Net.WebClient).DownloadFile("$HP$($A['url'])", $tmp)
Move-Item -LiteralPath $tmp -Destination $dest -Force
"Saved $((Get-Item -LiteralPath $dest -Force).Length) bytes to $dest"
