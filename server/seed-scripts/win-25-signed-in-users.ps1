# name: Signed-in users and sessions
# category: Inventory
# description: Who is signed in (console and Remote Desktop), session state and idle time, plus the last 10 sign-ins
# timeout: 60
'=== Current sessions ==='
$q = quser 2>&1
if ($LASTEXITCODE -ne 0 -or -not ($q -match 'USERNAME')) { 'Nobody is signed in.' } else { $q }
''
'=== Last 10 sign-ins (interactive and Remote Desktop) ==='
Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4624 } -MaxEvents 400 -ErrorAction SilentlyContinue |
  ForEach-Object {
    $x = [xml]$_.ToXml(); $d = @{}; foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
    if ($d.LogonType -in '2', '10', '11' -and $d.TargetUserName -notmatch '^(DWM-|UMFD-)') {
      [pscustomobject]@{ Time = $_.TimeCreated.ToString('yyyy-MM-dd HH:mm'); User = "$($d.TargetDomainName)\$($d.TargetUserName)";
        Type = @{ '2' = 'Console'; '10' = 'Remote Desktop'; '11' = 'Cached' }[$d.LogonType]; From = $d.IpAddress }
    }
  } | Select-Object -First 10 | Format-Table -AutoSize | Out-String
