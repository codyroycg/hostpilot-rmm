# name: Local user accounts
# category: Security
# description: Every local account with enabled state, admin rights, last sign-in and password age
# timeout: 60
$admins = @()
try { $admins = Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.SID.Value } } catch { }
Get-LocalUser | Sort-Object Enabled -Descending | ForEach-Object {
  [pscustomobject]@{
    Name          = $_.Name
    Enabled       = $_.Enabled
    Admin         = $admins -contains $_.SID.Value
    LastLogon     = if ($_.LastLogon) { $_.LastLogon.ToString('yyyy-MM-dd HH:mm') } else { 'never' }
    PasswordSet   = if ($_.PasswordLastSet) { $_.PasswordLastSet.ToString('yyyy-MM-dd') } else { '' }
    PwdExpires    = if ($_.PasswordExpires) { $_.PasswordExpires.ToString('yyyy-MM-dd') } else { 'never' }
    PwdRequired   = $_.PasswordRequired
    Description   = $_.Description
  }
} | Format-Table -AutoSize | Out-String -Width 220
'=== Profiles on disk ==='
Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special } | ForEach-Object {
  $name = try { (New-Object Security.Principal.SecurityIdentifier $_.SID).Translate([Security.Principal.NTAccount]).Value } catch { $_.SID }
  [pscustomobject]@{ Account = $name; Path = $_.LocalPath; LastUsed = if ($_.LastUseTime) { $_.LastUseTime.ToString('yyyy-MM-dd') } else { '' }; Loaded = $_.Loaded }
} | Sort-Object LastUsed -Descending | Format-Table -AutoSize | Out-String -Width 220
