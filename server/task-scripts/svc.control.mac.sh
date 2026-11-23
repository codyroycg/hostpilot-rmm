# HostPilot task: control a launchd service (macOS)
#__ARGS__
l="$A_name"
case "$A_action" in
  start) launchctl kickstart "system/$l" || exit 1 ;;
  restart) launchctl kickstart -k "system/$l" || exit 1 ;;
  stop) launchctl kill TERM "system/$l" || exit 1; echo "Note: services with KeepAlive are restarted by launchd; use Disabled to keep it stopped." ;;
  auto|manual) launchctl enable "system/$l" || exit 1 ;;
  disabled) launchctl disable "system/$l" && launchctl bootout "system/$l" 2>/dev/null; true ;;
esac
if launchctl list "$l" >/dev/null 2>&1; then echo "$l: $(launchctl list "$l" | grep -q '"PID" = ' && echo running || echo stopped)"
else echo "$l: not loaded"; fi
