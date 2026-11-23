# name: Clean temp files
# category: Maintenance
# description: Removes files older than 7 days from Windows and user temp folders and empties the recycle bin
# timeout: 900
$before = (Get-PSDrive C).Free
$paths = @("$env:SystemRoot\Temp") + (Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'AppData\Local\Temp' })
foreach ($p in $paths) {
  if (Test-Path $p) {
    Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { -not $_.PSIsContainer -and $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
}
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
$freed = ((Get-PSDrive C).Free - $before) / 1MB
"Freed approximately {0:N0} MB on C:" -f $freed
