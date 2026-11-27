# HostPilot task: scan Windows Update for pending updates, plus third-party apps with a newer version in winget
# Output: U\t<updateId>\t<KBs>\t<severity>\t<category>\t<bytes>\t<title>   and   R\t<reboot required 0|1>
# Third-party apps come out as U lines with id "winget:<package id>" and category "Third-party application".
#__ARGS__
$session = New-Object -ComObject Microsoft.Update.Session
$result = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")
foreach ($u in $result.Updates) {
    $kb = (@($u.KBArticleIDs) | ForEach-Object { "KB$_" }) -join ','
    $cat = ''
    try { $cat = (@($u.Categories) | Select-Object -First 1).Name } catch {}
    $sev = [string]$u.MsrcSeverity
    "U`t$($u.Identity.UpdateID)`t$kb`t$sev`t$cat`t$([long]$u.MaxDownloadSize)`t$($u.Title -replace "[`t`r`n]", ' ')"
}
#__INCLUDE:_winget.ps1__
# third-party applications: parse the "winget upgrade" table (columns found from the header line)
try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $wg = Get-WingetPath
    # progress spinners are redrawn with carriage returns: keep what's after the last one
    $lines = @(& $wg upgrade --accept-source-agreements --disable-interactivity 2>$null | ForEach-Object { ("$_" -split "`r")[-1] })
    $hdr = -1
    for ($i = 0; $i -lt $lines.Count - 1; $i++) { if ($lines[$i + 1] -match '^-{10,}' -and $lines[$i] -match '\bId\b') { $hdr = $i; break } }
    if ($hdr -ge 0) {
        $h = $lines[$hdr].TrimStart()
        $pad = $lines[$hdr].Length - $h.Length
        $cId = $lines[$hdr].IndexOf(' Id ') + 1; $cVer = $lines[$hdr].IndexOf(' Version ') + 1
        $cAv = $lines[$hdr].IndexOf(' Available ') + 1; $cSrc = $lines[$hdr].IndexOf(' Source')
        if ($cSrc -lt 0) { $cSrc = 9999 }
        for ($i = $hdr + 2; $i -lt $lines.Count; $i++) {
            $l = $lines[$i]
            if (-not $l.Trim() -or $l.Length -lt $cAv) { break }   # blank line / "N upgrades available." ends the table
            $name = $l.Substring($pad, [math]::Max(0, $cId - $pad)).Trim()
            $id = $l.Substring($cId, $cVer - $cId).Trim()
            $cur = $l.Substring($cVer, $cAv - $cVer).Trim()
            $av = $l.Substring($cAv, [math]::Min($l.Length, $cSrc) - $cAv).Trim()
            if ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,200}$' -or -not $av) { continue }   # truncated (…) or odd rows
            "U`twinget:$id`t`t`tThird-party application`t0`t$($name -replace "[`t`r`n]", ' ') $cur -> $av"
        }
    }
} catch { }   # no winget on this device: Windows Update results only
# W: Windows Update is pointed at a WSUS server by Group Policy (HostPilot's patching then can't see all updates)
$wsus = 0
try { if ((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -ErrorAction Stop).UseWUServer -eq 1) { $wsus = 1 } } catch {}
"W`t$wsus"
$reboot = $false
try { $reboot = (New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired } catch {}
"R`t$([int][bool]$reboot)"
