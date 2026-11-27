# HostPilot task: download + install Windows updates and third-party app upgrades (all, or a list of ids), optional reboot
# ids: "all", or comma-separated Windows Update ids and "winget:<package id>" entries
#__ARGS__
$session = New-Object -ComObject Microsoft.Update.Session
$found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")
$all = $A['ids'] -eq 'all'
$want = if ($all) { $null } else { $A['ids'] -split ',' }
$apps = @(if (-not $all) { $want | Where-Object { $_ -like 'winget:*' } | ForEach-Object { $_.Substring(7) } })
$coll = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $found.Updates) {
    if ($want -and ($want -notcontains $u.Identity.UpdateID)) { continue }
    if ($u.InstallationBehavior.CanRequestUserInput) { Write-Output "Skipping (needs user input): $($u.Title)"; continue }
    if (-not $u.EulaAccepted) { $u.AcceptEula() }
    [void]$coll.Add($u)
}
$failed = $false
$rebootNeeded = $false
if ($A['restore'] -eq '1' -and ($coll.Count -gt 0 -or $apps.Count -gt 0 -or $all)) {
    # System Restore exists on Windows client editions only; servers just skip this
    try {
        Enable-ComputerRestore -Drive "$env:SystemDrive\" -ErrorAction Stop
        Checkpoint-Computer -Description 'HostPilot: before installing updates' -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
        Write-Output 'Restore point created.'
    } catch { Write-Output "Restore point not created: $($_.Exception.Message)" }
}
if ($coll.Count -eq 0) {
    Write-Output 'No Windows updates to install.'
} else {
    Write-Output "Downloading $($coll.Count) Windows update(s)..."
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
    $rebootNeeded = [bool]$res.RebootRequired
}

#__INCLUDE:_winget.ps1__
# third-party applications through winget
if ($all -or $apps.Count) {
    try {
        $common = @('--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--include-unknown')
        if ($all) {
            Write-Output 'Upgrading all third-party applications (winget)...'
            $code = Invoke-Winget (@('upgrade', '--all') + $common)
            if ($code -ne 0) { Write-Output "winget finished with code $code" }
        } else {
            foreach ($id in $apps) {
                if ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,200}$') { continue }
                Write-Output "Upgrading $id (winget)..."
                $code = Invoke-Winget (@('upgrade', '--id', $id, '--exact') + $common)
                # -1978335189: already up to date
                if ($code -eq 0 -or $code -eq -1978335189) { Write-Output " [Succeeded] $id" } else { $failed = $true; Write-Output " [Failed, code $code] $id" }
            }
        }
    } catch { Write-Output "Third-party updates skipped: $($_.Exception.Message)" }
}

Write-Output "Reboot required: $rebootNeeded"
if ($rebootNeeded -and $A['reboot'] -eq '1') {
    $mins = 2; if ($A['reboot_delay']) { $mins = [math]::Max(0, [int]$A['reboot_delay']) }
    shutdown.exe /r /t ($mins * 60) /c "Your computer will restart in $mins minute(s) to finish installing updates. Please save your work. (HostPilot)"
    Write-Output "Reboot scheduled in $mins minute(s)."
}
Write-Output '--- remaining updates ---'
#__INCLUDE:updates.scan.ps1__
if ($failed) { exit 1 }
