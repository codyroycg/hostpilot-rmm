# name: Local administrators
# category: Security
# description: Lists members of the local Administrators group
# timeout: 60
try {
  Get-LocalGroupMember -SID 'S-1-5-32-544' | Select-Object Name, ObjectClass, PrincipalSource | Format-Table -AutoSize | Out-String
} catch {
  net localgroup administrators
}
