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
    if ($A['restore'] -eq '1') {
        # System Restore exists on Windows client editions only; servers just skip this
        try {
            Enable-ComputerRestore -Drive "$env:SystemDrive\" -ErrorAction Stop
            Checkpoint-Computer -Description 'HostPilot: before installing updates' -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
            Write-Output 'Restore point created.'
        } catch { Write-Output "Restore point not created: $($_.Exception.Message)" }
    }
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
        $mins = 2; if ($A['reboot_delay']) { $mins = [math]::Max(0, [int]$A['reboot_delay']) }
        shutdown.exe /r /t ($mins * 60) /c "Your computer will restart in $mins minute(s) to finish installing updates. Please save your work. (HostPilot)"
        Write-Output "Reboot scheduled in $mins minute(s)."
    }
}
Write-Output '--- remaining updates ---'
#__INCLUDE:updates.scan.ps1__
if ($failed) { exit 1 }
