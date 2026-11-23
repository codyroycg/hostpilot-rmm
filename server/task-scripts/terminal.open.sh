# HostPilot task: interactive terminal session (bash in a pty via `script`, relayed over HTTPS with curl)
#   keystrokes: one long-lived GET  -> lines "D <base64>" (input), "R <rows> <cols>" (resize), "X" (end)
#   output:     small POST batches  -> raw terminal bytes
#__ARGS__
#__INCLUDE:_server.sh__
command -v script >/dev/null 2>&1 || { echo "The 'script' command (util-linux) is required for terminal sessions" >&2; exit 1; }

dir="$(mktemp -d /tmp/hostpilot-term.XXXXXX)" || exit 1
chmod 700 "$dir"
fifo="$dir/in"; pidfile="$dir/pid"
mkfifo -m 600 "$fifo" || exit 1

cleanup() {
  exec 3>&- 2>/dev/null
  [ -s "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null
  [ -n "$outpid" ] && kill "$outpid" 2>/dev/null
  curl -sS -X POST -H 'Content-Length: 0' "$HP$A_close" >/dev/null 2>&1
  rm -rf "$dir"
}
trap cleanup EXIT

# ---- shell output -> server ----
(
  export TERM=xterm-256color HOME="${HOME:-/root}" LANG="${LANG:-C.UTF-8}"
  cd "$HOME" 2>/dev/null || cd /
  sh -c 'echo $$ > "$1"; exec script -qfc "bash -l" /dev/null' _ "$pidfile" < "$fifo" 2>&1 |
  while :; do
    chunk=""
    LC_ALL=C IFS= read -r -d '' -t 0.03 -N 16384 chunk; rc=$?
    if [ -n "$chunk" ]; then
      printf '%s' "$chunk" | curl -sS -X POST -H 'Content-Type: application/octet-stream' -H 'Expect:' --data-binary @- "$HP$A_out" >/dev/null 2>&1
    fi
    # rc 0 = full chunk, >128 = timeout (partial chunk), anything else = EOF (shell exited)
    if [ "$rc" -ne 0 ] && [ "$rc" -le 128 ]; then break; fi
  done 2>/dev/null
  curl -sS -X POST -H 'Content-Length: 0' "$HP$A_close" >/dev/null 2>&1
) &
outpid=$!

exec 3>"$fifo"

resize() {
  local spid="" shpid="" tty="" i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    spid="$(cat "$pidfile" 2>/dev/null)"
    if [ -n "$spid" ]; then
      shpid="$(ps -o pid= --ppid "$spid" 2>/dev/null | head -n 1 | tr -d ' ')"
      if [ -z "$shpid" ]; then
        shpid="$(grep -l "^PPid:[[:space:]]*$spid\$" /proc/[0-9]*/status 2>/dev/null | head -n 1 | cut -d/ -f3)"
      fi
    fi
    [ -n "$shpid" ] && break
    sleep 0.2
  done
  [ -n "$shpid" ] || return 0
  tty="$(readlink "/proc/$shpid/fd/0" 2>/dev/null)"
  case "$tty" in /dev/pts/*) stty -F "$tty" rows "$1" cols "$2" 2>/dev/null ;; esac
  return 0
}

# ---- server -> shell input ----
curl -sSN "$HP$A_in" 2>/dev/null | while read -r kind a b; do
  case "$kind" in
    D) printf '%s' "$a" | base64 -d >&3 2>/dev/null ;;
    R) resize "$a" "$b" ;;
    X) break ;;
  esac
  kill -0 "$outpid" 2>/dev/null || break
done
exit 0
