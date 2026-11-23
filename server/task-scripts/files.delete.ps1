# HostPilot task: delete a file or folder (recursively)
#__ARGS__
$p = $A['path']
if ($p -match '^[A-Za-z]:\\?$' -or $p -eq '\') { throw 'Refusing to delete a drive root' }
Remove-Item -LiteralPath $p -Recurse -Force
"Deleted $p"
