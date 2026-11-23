# resolve the HostPilot server URL (exported by the agent; fall back to the agent config)
if [ -z "$HOSTPILOT_SERVER" ]; then
  for c in /opt/hostpilot/config.env /Library/HostPilot/config.env; do [ -r "$c" ] && HOSTPILOT_SERVER="$(. "$c"; echo "$SERVER")" && break; done
fi
HP="${HOSTPILOT_SERVER%/}"
