# resolve the HostPilot server URL (set by the agent; fall back to the agent config)
if (-not $env:HOSTPILOT_SERVER) {
    $env:HOSTPILOT_SERVER = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\config.json') -Raw | ConvertFrom-Json).server
}
$HP = ([string]$env:HOSTPILOT_SERVER).TrimEnd('/')
