# HostPilot task: start / stop / restart a systemd service or change whether it starts at boot
#__ARGS__
u="$A_name"
case "$A_action" in
  start|stop|restart) systemctl "$A_action" "$u" || exit 1 ;;
  auto) systemctl unmask "$u" 2>/dev/null; systemctl enable "$u" || exit 1 ;;
  manual) systemctl unmask "$u" 2>/dev/null; systemctl disable "$u" || exit 1 ;;
  disabled) systemctl disable --now "$u" && systemctl mask "$u" || exit 1 ;;
esac
echo "$u: $(systemctl is-active "$u"), $(systemctl is-enabled "$u" 2>/dev/null)"
