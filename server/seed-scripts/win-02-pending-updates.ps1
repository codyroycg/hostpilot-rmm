# name: List pending Windows updates
# category: Patching
# description: Uses the Windows Update Agent API to list available (not yet installed) updates
# timeout: 900
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
if ($result.Updates.Count -eq 0) { 'No pending updates.'; exit 0 }
"$($result.Updates.Count) pending update(s):"
foreach ($u in $result.Updates) {
  $kb = ($u.KBArticleIDs | ForEach-Object { "KB$_" }) -join ','
  " - [{0}] {1} {2}" -f $u.MsrcSeverity, $u.Title, $kb
}
