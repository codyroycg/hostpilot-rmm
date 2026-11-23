# HostPilot task: download + install Windows updates (all, or a list of update IDs), optional reboot
#__ARGS__
$session = New-Object -ComObject Microsoft.Update.Session
$found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")
$want = if ($A['ids'] -eq 'all') { $null } else { $A['ids'] -split ',' }
$coll = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $found.Updates) {
    if ($want -and ($want -notcontains $u.Identity.UpdateID)) { continue }
    if ($u.InstallationBehavior.CanRequestUserInput) { Write-Output "Skipping (needs user input): $($u.Title)"; continue }
    if (-not $u.EulaAccepted) { $u.AcceptEula() }
    [void]$coll.Add($u)
}
$failed = $false
if ($coll.Count -eq 0) {
    Write-Output 'Nothing to install.'
} else {
    Write-Output "Downloading $($coll.Count) update(s)..."
    $dl = $session.CreateUpdateDownloader()
    $dl.Updates = $coll
    [void]$dl.Download()
    Write-Output 'Installing...'
    $inst = $session.CreateUpdateInstaller()
    $inst.Updates = $coll
    $res = $inst.Install()
    $codes = @{ 0 = 'Not started'; 1 = 'In progress'; 2 = 'Succeeded'; 3 = 'Succeeded with errors'; 4 = 'Failed'; 5 = 'Aborted' }
    for ($i = 0; $i -lt $coll.Count; $i++) {
        $rc = $res.GetUpdateResult($i).ResultCode
        if ($rc -ge 4) { $failed = $true }
        Write-Output (" [{0}] {1}" -f $codes[[int]$rc], $coll.Item($i).Title)
    }
    Write-Output "Reboot required: $($res.RebootRequired)"
    if ($res.RebootRequired -and $A['reboot'] -eq '1') {
        shutdown.exe /r /t 120 /c "Restarting in 2 minutes to finish installing updates (HostPilot)."
        Write-Output 'Reboot scheduled in 2 minutes.'
    }
}
Write-Output '--- remaining updates ---'
#__INCLUDE:updates.scan.ps1__
if ($failed) { exit 1 }
