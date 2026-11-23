# HostPilot task: end a process (macOS): SIGTERM, then SIGKILL after 3 s; optionally its children
#__ARGS__
pid="$A_pid"
name=$(ps -p "$pid" -o comm= 2>/dev/null) || { echo "No process with PID $pid" >&2; exit 1; }
[ -n "$name" ] || { echo "No process with PID $pid" >&2; exit 1; }
pids="$pid"
if [ "$A_tree" = 1 ]; then
  kids() { for c in $(pgrep -P "$1"); do echo "$c"; kids "$c"; done; }
  pids="$pids $(kids "$pid")"
fi
kill -TERM $pids 2>/dev/null
for i in 1 2 3; do sleep 1; kill -0 "$pid" 2>/dev/null || break; done
kill -0 "$pid" 2>/dev/null && kill -KILL $pids 2>/dev/null
echo "Ended ${name##*/} (PID $pid)"
