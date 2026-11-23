# name: Top processes
# category: Troubleshooting
# description: Top 15 processes by CPU time and by memory
# timeout: 60
"=== By CPU time ==="
Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Id, ProcessName, @{n='CPU(s)';e={[math]::Round($_.CPU,1)}}, @{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String -Width 200
"=== By memory ==="
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Id, ProcessName, @{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String -Width 200
