# name: Install Windows updates (no reboot)
# category: Patching
# description: Downloads and installs all pending software updates. Reports whether a reboot is required but does not reboot.
# timeout: 7200
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
if ($result.Updates.Count -eq 0) { 'No pending updates.'; exit 0 }
$toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $result.Updates) {
  if (-not $u.EulaAccepted) { $u.AcceptEula() }
  [void]$toInstall.Add($u)
  "Queued: $($u.Title)"
}
$dl = $session.CreateUpdateDownloader(); $dl.Updates = $toInstall
"Downloading..."; $null = $dl.Download()
$inst = $session.CreateUpdateInstaller(); $inst.Updates = $toInstall
"Installing..."; $r = $inst.Install()
"Result code: $($r.ResultCode)  (2 = succeeded, 3 = succeeded with errors, 4 = failed)"
"Reboot required: $($r.RebootRequired)"
if ($r.ResultCode -ge 4) { exit 1 }
