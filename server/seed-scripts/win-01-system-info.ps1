# name: System summary
# category: Inventory
# description: OS, uptime, hardware, disks and network overview
# timeout: 120
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
"Host:      $env:COMPUTERNAME ($($cs.Domain))"
"OS:        $($os.Caption) $($os.Version)"
"Uptime:    $((Get-Date) - $os.LastBootUpTime)"
"Model:     $($cs.Manufacturer) $($cs.Model)"
"RAM:       {0:N1} GB" -f ($cs.TotalPhysicalMemory / 1GB)
"User:      $($cs.UserName)"
""
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |
  Select-Object DeviceID, @{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}} |
  Format-Table -AutoSize | Out-String -Width 200
Get-NetIPConfiguration | Select-Object InterfaceAlias, IPv4Address, IPv4DefaultGateway, DNSServer | Format-List | Out-String -Width 200
