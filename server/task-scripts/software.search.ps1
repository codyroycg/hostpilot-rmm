# HostPilot task: search the winget catalog
# Output: P\t<id>\t<name>\t<version>  (falls back to raw winget output if the table can't be parsed)
#__ARGS__
#__INCLUDE:_winget.ps1__
$wg = Get-WingetPath
$lines = & $wg search --query $A['query'] --accept-source-agreements --disable-interactivity 2>&1 | ForEach-Object { "$_" }
$hi = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match 'Name\s+Id\s+Version') { $hi = $i; break } }
if ($hi -lt 0) { $lines | Where-Object { $_.Trim() } | ForEach-Object { Write-Output $_ }; exit 0 }
$h = $lines[$hi].Substring($lines[$hi].IndexOf('Name'))
$offset = $lines[$hi].IndexOf('Name')
$idPos = $h.IndexOf('Id'); $verPos = $h.IndexOf('Version')
$next = @($h.IndexOf('Match'), $h.IndexOf('Source')) | Where-Object { $_ -gt $verPos } | Sort-Object | Select-Object -First 1
for ($i = $hi + 2; $i -lt $lines.Count; $i++) {
    $l = $lines[$i]
    if ($l.Length -le $offset + $verPos) { continue }
    $l = $l.Substring($offset)
    $nm = $l.Substring(0, $idPos).Trim()
    $id = $l.Substring($idPos, $verPos - $idPos).Trim()
    $ver = if ($next -and $l.Length -gt $next) { $l.Substring($verPos, $next - $verPos).Trim() } else { $l.Substring($verPos).Trim() }
    if ($id -and $id -notmatch '\s') { "P`t$id`t$nm`t$ver" }
}
