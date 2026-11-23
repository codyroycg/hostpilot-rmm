# HostPilot task: running processes with current CPU (1 s sample from /proc)
# Output: T\tpid\tname\tcpu_pct\tmem_bytes\tuser\tpath\tstart_unix\tdescription(command line)
#__ARGS__
hz=$(getconf CLK_TCK 2>/dev/null || echo 100); cores=$(nproc 2>/dev/null || echo 1)
btime=$(awk '/^btime/{print $2}' /proc/stat); page=$(getconf PAGESIZE 2>/dev/null || echo 4096)
snap() { for f in /proc/[0-9]*/stat; do s=$(cat "$f" 2>/dev/null) || continue; r="${s##*) }"; set -- $r; p="${f#/proc/}"; echo "${p%/stat} $(( ${12} + ${13} )) ${20} ${22}"; done; }
snap > /tmp/.hp-ps1.$$; sleep 1; snap > /tmp/.hp-ps2.$$
awk -v hz="$hz" -v cores="$cores" -v bt="$btime" -v page="$page" '
  NR == FNR { t1[$1] = $2; next }
  { pid = $1; cpu = (pid in t1) ? ($2 - t1[pid]) / hz / cores * 100 : 0
    printf "%s\t%.1f\t%.0f\t%.0f\n", pid, (cpu < 0 ? 0 : cpu), $4 * page, bt + $3 / hz }' /tmp/.hp-ps1.$$ /tmp/.hp-ps2.$$ |
while IFS=$'\t' read -r pid cpu rss start; do
  [ -r "/proc/$pid/status" ] || continue
  name=$(awk '/^Name:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null)
  uid=$(awk '/^Uid:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null)
  user=$(getent passwd "$uid" | cut -d: -f1); [ -z "$user" ] && user="$uid"
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
  args=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-300 | tr '\t\r\n' '   ')
  printf 'T\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$name" "$cpu" "$rss" "$user" "$exe" "$start" "$args"
done
rm -f /tmp/.hp-ps1.$$ /tmp/.hp-ps2.$$
