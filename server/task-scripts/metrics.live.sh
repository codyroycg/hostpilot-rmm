# HostPilot task: live performance samples every 2 s until the server answers "stop"
#__ARGS__
#__INCLUDE:_server.sh__
url="$HP$A_url"
read -r _ u n s i w q sq st _ < /proc/stat
prev_total=$((u+n+s+i+w+q+sq+st)); prev_idle=$((i+w))
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
  if r=$(curl -fsS -m 10 -X POST -H 'Content-Type: text/plain' --data "$cpu $mem $disk" "$url" 2>/dev/null); then
    fails=0
    [ "$r" = "stop" ] && break
  else
    fails=$((fails+1))
  fi
done
echo "Live monitoring ended"
