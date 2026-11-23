# HostPilot task: create a folder
#__ARGS__
[void][IO.Directory]::CreateDirectory($A['path'])
"Created $($A['path'])"
