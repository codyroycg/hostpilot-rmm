# HostPilot task: list pending package updates
# Output: U\t<package>\t<kb>\t<severity>\t<category/repo>\t<bytes>\t<title>   and   R\t<reboot required 0|1>
#__ARGS__
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1 || echo "apt-get update failed" >&2
  apt list --upgradable 2>/dev/null | awk '
    /\[upgradable from/ {
      split($1, a, "/"); sev = (a[2] ~ /security/) ? "Security" : "";
      from = $NF; sub(/\]$/, "", from);
      printf "U\t%s\t\t%s\t%s\t0\t%s %s -> %s\n", a[1], sev, a[2], a[1], from, $2 }'
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  pm=dnf; command -v dnf >/dev/null 2>&1 || pm=yum
  sec="$($pm -q updateinfo list --security 2>/dev/null | awk '{print $3}')"
  $pm -q check-update 2>/dev/null | awk -v sec="$sec" '
    BEGIN { n = split(sec, s, "\n"); for (i = 1; i <= n; i++) secset[s[i]] = 1 }
    /^Obsoleting/ { exit }
    NF == 3 && $1 ~ /\./ {
      name = $1; sub(/\.[^.]+$/, "", name); nevra = name "-" $2 "." substr($1, length(name) + 2);
      sevr = (nevra in secset) ? "Security" : "";
      printf "U\t%s\t\t%s\t%s\t0\t%s -> %s\n", name, sevr, $3, name, $2 }'
elif command -v zypper >/dev/null 2>&1; then
  zypper -q --non-interactive list-updates 2>/dev/null | awk -F'|' '
    $1 ~ /v/ { for (i = 1; i <= NF; i++) gsub(/^ +| +$/, "", $i);
      printf "U\t%s\t\t\t%s\t0\t%s %s -> %s\n", $3, $2, $3, $4, $5 }'
else
  echo "No supported package manager (apt, dnf, yum, zypper) found" >&2
fi
reboot=0
if [ -f /var/run/reboot-required ]; then reboot=1
elif command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1; [ $? -eq 1 ] && reboot=1
fi
printf 'R\t%s\n' "$reboot"
