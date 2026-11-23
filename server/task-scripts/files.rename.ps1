# HostPilot task: rename a file or folder
#__ARGS__
Rename-Item -LiteralPath $A['path'] -NewName $A['to']
"Renamed to $($A['to'])"
