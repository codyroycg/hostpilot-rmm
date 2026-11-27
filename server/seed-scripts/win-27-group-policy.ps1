# name: Refresh Group Policy
# category: Maintenance
# description: Runs gpupdate /force and shows which computer policies are applied and when they last refreshed
# timeout: 600
'=== gpupdate /force ==='
(gpupdate /force /wait:300 2>&1) | Where-Object { $_ -match '\S' }
''
$cs = Get-CimInstance Win32_ComputerSystem
if (-not $cs.PartOfDomain) { 'This computer is not joined to a domain, so only local policy applies.'; exit 0 }
"Domain: $($cs.Domain)"
'=== Applied computer policies ==='
$out = gpresult /r /scope:computer 2>&1
$show = $false
foreach ($l in $out) {
  if ($l -match 'Last time Group Policy was applied|Group Policy was applied from|Site Name') { $l.Trim() }
  if ($l -match 'Applied Group Policy Objects') { $show = $true; continue }
  if ($show) { if ($l -match '^\s*$' -and $seen) { break }; if ($l -match '\S' -and $l -notmatch '^\s*-+\s*$') { $seen = $true; '  ' + $l.Trim() } }
}
