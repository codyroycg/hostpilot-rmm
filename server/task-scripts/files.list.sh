# HostPilot task: list a folder
# Output: <type d|f>\t<size>\t<mtime unix>\t<name>
#__ARGS__
p="${A_path:-/}"
[ -d "$p" ] || { echo "Not a folder: $p" >&2; exit 1; }
if find "$p" -maxdepth 0 -printf '' >/dev/null 2>&1; then
  # GNU find: %Y follows symlinks so links to folders are browsable
  find "$p" -mindepth 1 -maxdepth 1 -printf '%Y\t%s\t%T@\t%f\n' 2>/dev/null |
    awk -F'\t' 'BEGIN{OFS="\t"} { t = ($1 == "d") ? "d" : "f"; split($3, a, "."); gsub(/[\r\n]/, " ", $4); print t, $2, a[1], $4 }'
else
  # busybox fallback
  for f in "$p"/* "$p"/.[!.]* "$p"/..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    t=f; [ -d "$f" ] && t=d
    printf '%s\t%s\t%s\t%s\n' "$t" "$(stat -L -c %s "$f" 2>/dev/null || echo 0)" "$(stat -L -c %Y "$f" 2>/dev/null || echo 0)" "$(basename "$f")"
  done
fi
exit 0
