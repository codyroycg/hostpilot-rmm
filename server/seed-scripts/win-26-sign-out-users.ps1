# name: Sign out all users
# category: Maintenance
# description: Signs out every user session (console and Remote Desktop). Unsaved work in open programs is lost.
# timeout: 120
$lines = quser 2>$null
if (-not $lines) { 'Nobody is signed in.'; exit 0 }
$n = 0
foreach ($l in ($lines | Select-Object -Skip 1)) {
  # columns: USERNAME SESSIONNAME ID STATE IDLE LOGON; SESSIONNAME is blank for disconnected sessions
  $parts = ($l.Trim().TrimStart('>') -split '\s+')
  $id = $parts | Select-Object -Skip 1 | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
  if ($id) { logoff $id 2>$null; "Signed out $($parts[0]) (session $id)"; $n++ }
}
"$n session(s) signed out."
