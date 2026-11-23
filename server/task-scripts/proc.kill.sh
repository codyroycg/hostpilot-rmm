# HostPilot task: end a process (SIGTERM, then SIGKILL after 3 s); optionally its children too
#__ARGS__
pid="$A_pid"
[ -d "/proc/$pid" ] || { echo "No process with PID $pid" >&2; exit 1; }
name=$(awk '/^Name:/{print $2; exit}' "/proc/$pid/status")
pids="$pid"
if [ "$A_tree" = 1 ] && command -v pgrep >/dev/null 2>&1; then
  kids() { for c in $(pgrep -P "$1"); do echo "$c"; kids "$c"; done; }
  pids="$pids $(kids "$pid")"
fi
kill -TERM $pids 2>/dev/null
for i in 1 2 3; do sleep 1; kill -0 "$pid" 2>/dev/null || break; done
kill -0 "$pid" 2>/dev/null && kill -KILL $pids 2>/dev/null
echo "Ended $name (PID $pid)"
