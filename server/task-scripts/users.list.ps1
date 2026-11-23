# HostPilot task: list local user accounts
# Output: U\t<name>\t<enabled 0|1>\t<admin 0|1>\t<full name>\t<last logon unix>\t<description>
#__ARGS__
$admins = @{}
try {
    Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $admins[($_.Name -split '\\')[-1]] = $true }
} catch {
    # Get-LocalGroupMember fails on groups containing orphaned SIDs; fall back to ADSI
    $g = [ADSI]("WinNT://./" + (Get-LocalGroup -SID 'S-1-5-32-544').Name + ",group")
    foreach ($m in @($g.psbase.Invoke('Members'))) { $admins[$m.GetType().InvokeMember('Name', 'GetProperty', $null, $m, $null)] = $true }
}
foreach ($u in Get-LocalUser) {
    $ll = 0
    if ($u.LastLogon) { $ll = ([DateTimeOffset]$u.LastLogon).ToUnixTimeSeconds() }
    "U`t$($u.Name)`t$([int]$u.Enabled)`t$([int][bool]$admins[$u.Name])`t$($u.FullName -replace "`t", ' ')`t$ll`t$($u.Description -replace "[`t`r`n]", ' ')"
}
