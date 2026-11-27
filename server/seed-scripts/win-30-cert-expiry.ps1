# name: Certificates expiring soon
# category: Security
# description: Computer certificates (Personal and Remote Desktop stores) that have expired or expire within 60 days
# timeout: 60
$days = 60
$now = Get-Date
$certs = foreach ($store in 'Cert:\LocalMachine\My', 'Cert:\LocalMachine\Remote Desktop', 'Cert:\LocalMachine\WebHosting') {
  Get-ChildItem $store -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      Store    = Split-Path $store -Leaf
      Subject  = $_.Subject
      Issuer   = ($_.Issuer -split ',')[0]
      Expires  = $_.NotAfter.ToString('yyyy-MM-dd')
      DaysLeft = [math]::Floor(($_.NotAfter - $now).TotalDays)
      Thumb    = $_.Thumbprint.Substring(0, 8)
    }
  }
}
"$(@($certs).Count) computer certificate(s) found."
$soon = @($certs | Where-Object { $_.DaysLeft -le $days } | Sort-Object DaysLeft)
if (-not $soon.Count) { "None expire within $days days."; exit 0 }
"$($soon.Count) expired or expiring within $days days:"
$soon | Format-Table -AutoSize -Wrap | Out-String -Width 220
