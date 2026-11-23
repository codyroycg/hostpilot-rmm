# HostPilot task: list a folder (macOS)
# Output: <type d|f>\t<size>\t<mtime unix>\t<name>
#__ARGS__
p="${A_path:-/}"
[ -d "$p" ] || { echo "Not a folder: $p" >&2; exit 1; }
cd "$p" 2>/dev/null || { echo "Cannot open $p (macOS privacy protection may block it: give /bin/bash Full Disk Access)" >&2; exit 1; }
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  t=f; [ -d "$f" ] && t=d
  printf '%s\t%s\t%s\t%s\n' "$t" "$(stat -L -f %z "$f" 2>/dev/null || echo 0)" "$(stat -L -f %m "$f" 2>/dev/null || echo 0)" "$(printf '%s' "$f" | tr '\t\r\n' '   ')"
done
exit 0
