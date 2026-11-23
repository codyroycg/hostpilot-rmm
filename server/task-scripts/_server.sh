# resolve the HostPilot server URL (exported by the agent; fall back to the agent config)
if [ -z "$HOSTPILOT_SERVER" ]; then
  HOSTPILOT_SERVER="$(. /opt/hostpilot/config.env 2>/dev/null; echo "$SERVER")"
fi
HP="${HOSTPILOT_SERVER%/}"
