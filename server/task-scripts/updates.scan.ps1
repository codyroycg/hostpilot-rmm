# HostPilot task: scan Windows Update for pending updates
# Output: U\t<updateId>\t<KBs>\t<severity>\t<category>\t<bytes>\t<title>   and   R\t<reboot required 0|1>
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
# W: Windows Update is pointed at a WSUS server by Group Policy (HostPilot's patching then can't see all updates)
$wsus = 0
try { if ((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -ErrorAction Stop).UseWUServer -eq 1) { $wsus = 1 } } catch {}
"W`t$wsus"
$reboot = $false
try { $reboot = (New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired } catch {}
"R`t$([int][bool]$reboot)"
