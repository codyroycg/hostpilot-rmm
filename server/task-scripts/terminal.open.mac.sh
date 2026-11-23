# HostPilot task: interactive terminal session on macOS (bash in a pty via BSD `script`, relayed over HTTPS)
#   keystrokes: one long-lived GET  -> lines "D <base64>" (input), "R <rows> <cols>" (resize), "X" (end)
#   output:     small POST batches  -> raw terminal bytes (perl batches the pty output; bash 3.2 has no read -N)
#__ARGS__
#__INCLUDE:_server.sh__
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
  export TERM=xterm-256color HOME="${HOME:-/var/root}" LANG="${LANG:-en_US.UTF-8}"
  cd "$HOME" 2>/dev/null || cd /
  /bin/sh -c 'echo $$ > "$1"; exec /usr/bin/script -q /dev/null /bin/bash -l' _ "$pidfile" < "$fifo" 2>&1 |
  OUT="$HP$A_out" /usr/bin/perl -e '
    use IO::Select; $| = 1; binmode STDIN;
    my $sel = IO::Select->new(\*STDIN); my $buf = "";
    sub flush { return unless length $buf; open(my $c, "|-", "curl", "-sS", "-X", "POST", "-H", "Content-Type: application/octet-stream", "-H", "Expect:", "--data-binary", "\@-", $ENV{OUT}) or return;
      binmode $c; print $c $buf; close $c; $buf = ""; }
    while (1) {
      if ($sel->can_read(0.03)) { my $n = sysread(STDIN, my $chunk, 16384); last unless $n; $buf .= $chunk; flush() if length $buf > 65536; }
      else { flush(); }
    }
    flush();' >/dev/null 2>&1
  curl -sS -X POST -H 'Content-Length: 0' "$HP$A_close" >/dev/null 2>&1
) &
outpid=$!

exec 3>"$fifo"

resize() {
  local spid shpid tty i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    spid="$(cat "$pidfile" 2>/dev/null)"
    [ -n "$spid" ] && shpid="$(pgrep -P "$spid" | head -n 1)"
    [ -n "$shpid" ] && break
    sleep 0.2
  done
  [ -n "$shpid" ] || return 0
  tty="$(ps -o tty= -p "$shpid" 2>/dev/null | tr -d ' ')"
  case "$tty" in ttys*) stty -f "/dev/$tty" rows "$1" cols "$2" 2>/dev/null ;; esac
  return 0
}

# ---- server -> shell input ----
curl -sSN "$HP$A_in" 2>/dev/null | while read -r kind a b; do
  case "$kind" in
    D) printf '%s' "$a" | base64 -D >&3 2>/dev/null ;;
    R) resize "$a" "$b" ;;
    X) break ;;
  esac
  kill -0 "$outpid" 2>/dev/null || break
done
exit 0
