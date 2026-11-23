# HostPilot task: list a folder (or drives when no path is given)
# Output: <type d|f>\t<size>\t<mtime unix>\t<name>
#__ARGS__
$p = $A['path']
if (-not $p) {
    foreach ($d in [IO.DriveInfo]::GetDrives()) {
        $size = 0
        try { if ($d.IsReady) { $size = $d.TotalSize } } catch {}
        "d`t$size`t0`t$($d.Name)"
    }
    exit 0
}
$item = Get-Item -LiteralPath $p -Force
if (-not $item.PSIsContainer) { throw "Not a folder: $p" }
foreach ($i in (Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)) {
    $t = if ($i.PSIsContainer) { 'd' } else { 'f' }
    $len = if ($i.PSIsContainer) { 0 } else { $i.Length }
    $mt = 0
    try { $mt = ([DateTimeOffset]$i.LastWriteTimeUtc).ToUnixTimeSeconds() } catch {}
    "$t`t$len`t$mt`t$($i.Name -replace "[`t`r`n]", ' ')"
}
