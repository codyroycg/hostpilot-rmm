# HostPilot task: running processes (macOS)
# Output: T\tpid\tname\tcpu_pct\tmem_bytes\tuser\tpath\tstart_unix\tdescription(command line)
#__ARGS__
now=$(date +%s); cores=$(sysctl -n hw.logicalcpu)
# etime is [[dd-]hh:]mm:ss; %cpu is per core on macOS, so divide by the core count
ps -axww -o pid=,user=,%cpu=,rss=,etime=,comm= | awk -v now="$now" -v cores="$cores" '
  { pid = $1; user = $2; cpu = $3 / cores; rss = $4 * 1024; et = $5
    d = 0; if (index(et, "-")) { split(et, x, "-"); d = x[1]; et = x[2] }
    n = split(et, p, ":"); s = (n == 3) ? p[1] * 3600 + p[2] * 60 + p[3] : p[1] * 60 + p[2]; s += d * 86400
    path = $6; for (i = 7; i <= NF; i++) path = path " " $i
    name = path; sub(/.*\//, "", name)
    printf "T\t%s\t%s\t%.1f\t%.0f\t%s\t%s\t%d\t\n", pid, name, cpu, rss, user, path, now - s }'
