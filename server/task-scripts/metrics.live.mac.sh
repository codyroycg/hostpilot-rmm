# HostPilot task: live performance samples every 2 s until the server answers "stop" (macOS)
#__ARGS__
#__INCLUDE:_server.sh__
url="$HP$A_url"
total=$(sysctl -n hw.memsize)
net_bytes() { netstat -ibn 2>/dev/null | awk '$1 ~ /^en[0-9]+$/ && $3 ~ /^<Link/ { r += $7; t += $10 } END { printf "%.0f %.0f", r, t }'; }
read -r prev_rx prev_tx <<< "$(net_bytes)"; prev_t=$(date +%s)
fails=0; end=$(( $(date +%s) + 3300 ))
while [ "$(date +%s)" -lt "$end" ] && [ "$fails" -lt 5 ]; do
  # top samples CPU over ~1 s; together with the sleep this gives a sample about every 2 s
  cpu=$(top -l 2 -n 0 -s 1 2>/dev/null | awk '/^CPU usage/ { u = $3; s = $5 } END { gsub(/%/, "", u); gsub(/%/, "", s); printf "%.1f", u + s }')
  mem=$(vm_stat | awk -v total="$total" '/page size of/ { ps = $8 } /Pages active/ { a = $3 } /Pages wired down/ { w = $4 } /Pages occupied by compressor/ { c = $5 }
    END { gsub(/\./, "", a); gsub(/\./, "", w); gsub(/\./, "", c); printf "%.1f", (a + w + c) * ps / total * 100 }')
  disk=$(df -kP 2>/dev/null | awk 'NR > 1 && $1 ~ /^\/dev\/disk/ && $6 !~ /^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware|Recovery)/ { p = $3 / $2 * 100; if (p > m) m = p } END { printf "%.1f", m + 0 }')
  read -r rx tx <<< "$(net_bytes)"; now=$(date +%s)
  rates=$(awk -v r1="$prev_rx" -v r2="$rx" -v t1="$prev_tx" -v t2="$tx" -v a="$prev_t" -v b="$now" 'BEGIN { s = b - a; if (s > 0 && r2 >= r1 && t2 >= t1) printf "%.0f %.0f", (r2 - r1) / s, (t2 - t1) / s }')
  prev_rx=$rx; prev_tx=$tx; prev_t=$now
  if r=$(curl -fsS -m 10 -X POST -H 'Content-Type: text/plain' --data "$cpu $mem $disk $rates" "$url" 2>/dev/null); then
    fails=0; [ "$r" = "stop" ] && break
  else fails=$((fails + 1)); fi
  sleep 1
done
echo "Live monitoring ended"
