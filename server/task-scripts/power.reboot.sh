# HostPilot task: restart or shut down now or after a delay, with a message to logged-in users (Linux and macOS)
# mode: restart | shutdown
#__ARGS__
mins="$A_delay"; case "$mins" in ''|*[!0-9]*) mins=0 ;; esac
if [ "$A_mode" = shutdown ]; then flag=-h; verb="shut down"; Verb=Shutdown; sysd=poweroff; now="Shutting down now."
else flag=-r; verb=restart; Verb=Restart; sysd=reboot; now="Restarting now."; fi
msg="$A_message"
[ -n "$msg" ] || { if [ "$mins" -gt 0 ]; then msg="This computer will $verb in $mins minute(s). Please save your work. (HostPilot)"; else msg="This computer will $verb now. (HostPilot)"; fi; }
if [ "$mins" -gt 0 ]; then
  shutdown "$flag" +"$mins" "$msg" >/dev/null 2>&1 || { echo "shutdown failed" >&2; exit 1; }
  echo "$Verb scheduled in $mins minute(s); logged-in users were warned."
  exit 0
fi
# now: act a few seconds after this script ends, so the agent can report back first
command -v wall >/dev/null 2>&1 && printf '%s\n' "$msg" | wall 2>/dev/null
if command -v systemd-run >/dev/null 2>&1 && systemd-run --quiet --on-active=5 --unit="hostpilot-power-$(date +%s)" systemctl "$sysd" >/dev/null 2>&1; then
  :
else
  nohup sh -c "sleep 5; shutdown $flag now" >/dev/null 2>&1 &
fi
echo "$now"
