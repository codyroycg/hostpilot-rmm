# HostPilot task: send a file (or a zipped folder) from this device to the server
#__ARGS__
#__INCLUDE:_server.ps1__
$p = $A['path']
$item = Get-Item -LiteralPath $p -Force
$src = $p
if ($item.PSIsContainer) {
    $src = Join-Path $env:TEMP ("hostpilot-" + [guid]::NewGuid().ToString('N') + '.zip')
    Compress-Archive -LiteralPath $p -DestinationPath $src -CompressionLevel Fastest
}
try {
    $fs = [IO.File]::Open($src, 'Open', 'Read', 'ReadWrite')
    try {
        $req = [Net.HttpWebRequest]::Create("$HP$($A['url'])")
        $req.Method = 'PUT'
        $req.ContentType = 'application/octet-stream'
        $req.AllowWriteStreamBuffering = $false
        $req.ContentLength = $fs.Length
        $req.Timeout = 7200000
        $req.ReadWriteTimeout = 7200000
        $rs = $req.GetRequestStream()
        $fs.CopyTo($rs, 1048576)
        $rs.Close()
        $req.GetResponse().Close()
        "Sent $($fs.Length) bytes"
    } finally { $fs.Close() }
} finally {
    if ($src -ne $p) { Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue }
}
