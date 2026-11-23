# HostPilot task: live performance samples every 2 s until the server answers "stop"
#__ARGS__
#__INCLUDE:_server.sh__
url="$HP$A_url"

# network bytes: physical interfaces (VPN traffic would otherwise be counted twice); fall back to all but lo/veth
net_bytes() {
  local d n r=0 t=0 hr=0 ht=0 hw=0 x y
  for d in /sys/class/net/*; do
    n="${d##*/}"
    case "$n" in lo|veth*) continue ;; esac
    x="$(cat "$d/statistics/rx_bytes" 2>/dev/null || echo 0)"; y="$(cat "$d/statistics/tx_bytes" 2>/dev/null || echo 0)"
    r=$((r + x)); t=$((t + y))
    case "$n" in tun*|tap*|wg*|ppp*|tailscale*|zt*) continue ;; esac
    if [ -e "$d/device" ]; then hr=$((hr + x)); ht=$((ht + y)); hw=$((hw + 1)); fi
  done
  if [ "$hw" -gt 0 ]; then echo "$hr $ht"; else echo "$r $t"; fi
}

read -r _ u n s i w q sq st _ < /proc/stat
prev_total=$((u+n+s+i+w+q+sq+st)); prev_idle=$((i+w))
read -r prev_rx prev_tx < <(net_bytes)
prev_ns=$(date +%s%N)
fails=0
end=$(( $(date +%s) + 3300 ))
while [ "$(date +%s)" -lt "$end" ] && [ "$fails" -lt 5 ]; do
  sleep 2
  read -r _ u n s i w q sq st _ < /proc/stat
  total=$((u+n+s+i+w+q+sq+st)); idle=$((i+w))
  dt=$((total-prev_total)); di=$((idle-prev_idle))
  prev_total=$total; prev_idle=$idle
  cpu=$(awk -v t="$dt" -v i="$di" 'BEGIN{ if (t>0) printf "%.1f", (1-i/t)*100; else print 0 }')
  mem=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{ if (t>0) printf "%.1f", (1-a/t)*100; else print 0 }' /proc/meminfo)
  disk=$(df -P -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | awk 'NR>1 && $2>0 { p=$3/$2*100; if (p>m) m=p } END{ printf "%.1f", m+0 }')
  read -r rx tx < <(net_bytes)
  now_ns=$(date +%s%N)
  rates=$(awk -v r1="$prev_rx" -v r2="$rx" -v t1="$prev_tx" -v t2="$tx" -v a="$prev_ns" -v b="$now_ns" \
    'BEGIN{ s=(b-a)/1e9; if (s>0 && r2>=r1 && t2>=t1) printf "%.0f %.0f", (r2-r1)/s, (t2-t1)/s }')
  prev_rx=$rx; prev_tx=$tx; prev_ns=$now_ns
  if r=$(curl -fsS -m 10 -X POST -H 'Content-Type: text/plain' --data "$cpu $mem $disk $rates" "$url" 2>/dev/null); then
    fails=0
    [ "$r" = "stop" ] && break
  else
    fails=$((fails+1))
  fi
done
echo "Live monitoring ended"
