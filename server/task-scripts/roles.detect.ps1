# HostPilot task: detect server roles from installed automatic-start services
# Output: ROLE\t<role id>\t<service,service,...>
#__ARGS__
$ErrorActionPreference = 'Continue'
$svcs = @{}
Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' } | ForEach-Object { $svcs[$_.Name.ToLower()] = $_.Name }
$isServer = (Get-CimInstance Win32_OperatingSystem).ProductType -ne 1
function Emit($role, [string[]]$names) {
    $found = @($names | ForEach-Object { $svcs[$_.ToLower()] } | Where-Object { $_ })
    if ($found.Count) { "ROLE`t$role`t$($found -join ',')" }
}
function Like($pattern) { @($svcs.Values | Where-Object { $_ -like $pattern }) }

if ($svcs['ntds']) { Emit 'domain_controller' @('NTDS', 'Netlogon', 'Kdc', 'DFSR', 'W32Time', 'ADWS') }
if ($svcs['dns']) { Emit 'dns_server' @('DNS') }
if ($svcs['dhcpserver']) { Emit 'dhcp_server' @('DHCPServer') }
if ($isServer) {
    $shares = @()
    try { $shares = @(Get-SmbShare -ErrorAction Stop | Where-Object { -not $_.Special -and $_.Name -notin 'NETLOGON', 'SYSVOL', 'print$' }) } catch {}
    if ($shares.Count) { Emit 'file_server' @('LanmanServer') }
    $shared = @()
    try { $shared = @(Get-Printer -ErrorAction Stop | Where-Object { $_.Shared }) } catch {}
    if ($shared.Count) { Emit 'print_server' @('Spooler') }
}
if ($svcs['vmms']) { Emit 'hyperv' @('vmms', 'vmcompute') }
$sql = @(Like 'MSSQLSERVER') + @(Like 'MSSQL$*') + @(Like 'SQLSERVERAGENT') + @(Like 'SQLAgent$*')
if ($sql.Count) { Emit 'sql_server' $sql }
if ($svcs['msexchangeis'] -or $svcs['msexchangetransport']) { Emit 'exchange' @('MSExchangeIS', 'MSExchangeTransport', 'MSExchangeFrontEndTransport', 'MSExchangeServiceHost') }
if ($svcs['w3svc']) { Emit 'iis' @('W3SVC', 'WAS') }
$veeam = @(Like 'Veeam*')
if ($veeam.Count) { Emit 'backup' $veeam }
if ($svcs['docker']) { Emit 'docker' @('docker') }
if ($svcs['mysql'] -or (Like 'MySQL*').Count -or (Like 'MariaDB*').Count) { Emit 'mysql' (@(Like 'MySQL*') + @(Like 'MariaDB*')) }
if ((Like 'postgresql*').Count) { Emit 'postgresql' (Like 'postgresql*') }
'Role detection finished'
