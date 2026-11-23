#!/usr/bin/env bash
# HostPilot RMM agent for Linux (bash + curl). Runs as root under systemd (hostpilot-agent.service).
# Config: config.env next to this file (SERVER, AGENT_ID, SECRET).

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$BASE/agent.sh"
# shellcheck disable=SC1091
source "$BASE/config.env"
SERVER="${SERVER%/}"
MY_VERSION="$(sha256sum "$SELF" | cut -c1-12)"
JOBDIR="$BASE/jobs"
LOG="$BASE/agent.log"
MAX_OUT=1048576

mkdir -p "$JOBDIR"
rm -f "$JOBDIR"/* 2>/dev/null

log() {
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi
  echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >> "$LOG"
}

# api METHOD PATH [BODYFILE] [TIMEOUT]
api() {
  local args=(-sS --fail --max-time "${4:-30}" -X "$1" -H "X-Agent-Id: $AGENT_ID" -H "X-Agent-Secret: $SECRET")
  if [ -n "$3" ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$3"); fi
  curl "${args[@]}" "$SERVER$2"
}

jesc() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/ }"; s="${s//$'\r'/}"; s="${s//$'\t'/ }"
  printf '%s' "$s"
}

b64() { base64 | tr -d '\n'; }

cpu_pct() {
  local a b
  read -r _ u1 n1 s1 i1 w1 x1 y1 z1 _ < /proc/stat
  sleep 1
  read -r _ u2 n2 s2 i2 w2 x2 y2 z2 _ < /proc/stat
  local t1=$((u1+n1+s1+i1+w1+x1+y1+z1)) t2=$((u2+n2+s2+i2+w2+x2+y2+z2))
  local dt=$((t2-t1)) di=$(( (i2+w2) - (i1+w1) ))
  if [ "$dt" -gt 0 ]; then echo $(( (100*(dt-di)) / dt )); else echo 0; fi
}

checkin_body() {
  local f="$1"
  local mem_total mem_avail mem_pct os_name os_ver cpu_model cores ips disks users btime
  mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  mem_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  mem_pct=$(awk -v t="$mem_total" -v a="$mem_avail" 'BEGIN{ if (t>0) printf "%.1f", (1-a/t)*100; else print 0 }')
  os_name="Linux"; os_ver="$(uname -r)"
  if [ -r /etc/os-release ]; then
    os_name="$(. /etc/os-release; echo "${PRETTY_NAME:-${NAME:-Linux}}")"
    os_ver="$(. /etc/os-release; echo "${VERSION_ID:-}") (kernel $(uname -r))"
  fi
  cpu_model="$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo)"
  [ -z "$cpu_model" ] && cpu_model="$(awk -F': ' '/^(Hardware|Model|cpu model)/{print $2; exit}' /proc/cpuinfo)"
  cores="$(nproc 2>/dev/null || echo 1)"
  if command -v ip >/dev/null 2>&1; then
    ips=$(ip -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); printf "\"%s\",", a[1]}')
  else
    ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk 'NF{printf "\"%s\",", $1}')
  fi
  disks=$(df -Pk -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x fuse.snapfuse 2>/dev/null |
    awk 'NR>1 && $2>0 && $6 !~ /^\/(snap|run|sys|proc|dev)/ {gsub(/"/,"",$6); printf "{\"mount\":\"%s\",\"total\":%.0f,\"free\":%.0f},", $6, $2*1024, $4*1024}')
  users=$(who 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, -)
  btime=$(awk '/^btime/{printf "%.0f", $2*1000}' /proc/stat)
  local vendor model serial
  vendor="$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"
  model="$(cat /sys/class/dmi/id/product_name 2>/dev/null)"
  serial="$(cat /sys/class/dmi/id/product_serial 2>/dev/null)"
  cat > "$f" <<EOF
{"hostname":"$(jesc "$(hostname)")","cpu":$(cpu_pct),"mem":${mem_pct:-0},"disks":[${disks%,}],"ip_addrs":[${ips%,}],
"logged_user":"$(jesc "$users")","os_name":"$(jesc "$os_name")","os_version":"$(jesc "$os_ver")","arch":"$(uname -m)",
"cpu_model":"$(jesc "$cpu_model")","cpu_cores":${cores:-1},"ram_total":$(( ${mem_total:-0} * 1024 )),
"manufacturer":"$(jesc "$vendor")","model":"$(jesc "$model")","serial":"$(jesc "$serial")",
"boot_time":${btime:-0},"agent_version":"$MY_VERSION"}
EOF
}

send_inventory() {
  local f="$JOBDIR/.inventory.json" list
  if command -v dpkg-query >/dev/null 2>&1; then
    list=$(dpkg-query -W -f='${Package}\t${Version}\t${Maintainer}\n' 2>/dev/null)
  elif command -v rpm >/dev/null 2>&1; then
    list=$(rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n' 2>/dev/null)
  elif command -v apk >/dev/null 2>&1; then
    list=$(apk info -v 2>/dev/null | sed -E 's/^(.+)-([^-]+-r[0-9]+)$/\1\t\2\t/')
  elif command -v pacman >/dev/null 2>&1; then
    list=$(pacman -Q 2>/dev/null | awk '{print $1"\t"$2"\t"}')
  fi
  printf '{"software_b64":"%s"}' "$(printf '%s' "$list" | b64)" > "$f"
  api POST /api/agent/inventory "$f" 120 >/dev/null && log "inventory sent"
  rm -f "$f"
}

post_result() { # id exit_code stdout_file stderr_file timed_out(true/false)
  local f="$JOBDIR/.result-$1.json"
  printf '{"job_id":"%s","exit_code":%d,"timed_out":%s,"stdout_b64":"%s","stderr_b64":"%s"}' \
    "$1" "$2" "$5" "$( [ -f "$3" ] && tail -c "$MAX_OUT" "$3" | b64)" "$( [ -f "$4" ] && tail -c "$MAX_OUT" "$4" | b64)" > "$f"
  api POST /api/agent/result "$f" 60 >/dev/null
  local rc=$?
  rm -f "$f"
  return $rc
}

post_message() { # id exit_code message
  local o="$JOBDIR/.msg-$1"
  printf '%s\n' "$3" > "$o"
  post_result "$1" "$2" /dev/null "$o" false
  rm -f "$o"
}

uninstall() {
  post_message "$1" 0 "Agent uninstall scheduled"
  log "uninstall requested by server"
  # Runs inline: systemd kills the whole cgroup when the service stops, so no background helpers.
  systemctl disable hostpilot-agent >/dev/null 2>&1
  rm -f /etc/systemd/system/hostpilot-agent.service
  systemctl daemon-reload
  rm -rf "$BASE"
  systemctl stop --no-block hostpilot-agent
  exit 0
}

start_job() { # id shell timeout base64body
  local id="$1" shell="$2" to="$3" stem="$JOBDIR/$1" cmd
  [ "$to" -gt 0 ] 2>/dev/null || to=300
  printf '%s' "$4" | base64 -d > "$stem.script" 2>/dev/null
  case "$shell" in
    bash) cmd=(bash "$stem.script") ;;
    sh) cmd=(sh "$stem.script") ;;
    python)
      if command -v python3 >/dev/null 2>&1; then cmd=(python3 "$stem.script")
      else rm -f "$stem.script"; post_message "$id" 127 "python3 is not installed on this device"; return; fi ;;
    _uninstall) uninstall "$id" ;;
    *) rm -f "$stem.script"; post_message "$id" 127 "Shell '$shell' is not supported on Linux"; return ;;
  esac
  (
    cd /tmp || exit
    timeout -k 10 "$to" "${cmd[@]}" > "$stem.out" 2> "$stem.err" < /dev/null
    echo $? > "$stem.rc.tmp"
    mv -f "$stem.rc.tmp" "$stem.rc"
  ) &
  log "job $id started ($shell, timeout ${to}s)"
}

check_jobs() {
  local rcf id rc timed
  for rcf in "$JOBDIR"/*.rc; do
    [ -e "$rcf" ] || continue
    id="$(basename "$rcf" .rc)"
    rc="$(cat "$rcf")"
    timed=false
    if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then timed=true; fi
    if post_result "$id" "$rc" "$JOBDIR/$id.out" "$JOBDIR/$id.err" "$timed"; then
      rm -f "$JOBDIR/$id".*
      log "job $id finished (exit $rc)"
    fi
  done
}

running_jobs() { find "$JOBDIR" -maxdepth 1 -name '*.script' 2>/dev/null | wc -l; }

self_update() {
  [ "$(running_jobs)" -eq 0 ] || return
  local tmp="$SELF.new"
  if curl -sS --fail --max-time 60 -o "$tmp" "$SERVER/agent/linux.sh"; then
    if [ "$(sha256sum "$tmp" | cut -c1-12)" = "$1" ]; then
      chmod 700 "$tmp"; mv -f "$tmp" "$SELF"
      log "updated agent $MY_VERSION -> $1, restarting"
      exit 0
    fi
    log "update hash mismatch"; rm -f "$tmp"
  fi
}

log "agent $MY_VERSION starting (server $SERVER)"
interval=60
last_checkin=0
failures=0
body="$JOBDIR/.checkin.json"

while true; do
  now=$(date +%s)
  if [ $((now - last_checkin)) -ge "$interval" ]; then
    checkin_body "$body"
    if api POST /api/agent/checkin "$body" 30 >/dev/null; then last_checkin=$(date +%s); fi
    rm -f "$body"
  fi

  if [ "$(running_jobs)" -gt 0 ]; then wait_s=2
  else
    wait_s=$(( interval - ($(date +%s) - last_checkin) ))
    [ "$wait_s" -gt 25 ] && wait_s=25
    [ "$wait_s" -lt 1 ] && wait_s=1
  fi

  if resp=$(api GET "/api/agent/poll?wait=$wait_s&format=text" "" $((wait_s + 30))); then
    failures=0
    want_inv=0; srv_version=""
    while IFS=$'\t' read -r kind a b c d; do
      case "$kind" in
        VERSION) srv_version="$a" ;;
        INTERVAL) [ "$a" -ge 15 ] 2>/dev/null && interval="$a" ;;
        INV) want_inv=1 ;;
        JOB) start_job "$a" "$b" "$c" "$d" ;;
      esac
    done <<< "$resp"
    check_jobs
    [ "$want_inv" = 1 ] && send_inventory
    if [ -n "$srv_version" ] && [ "$srv_version" != "$MY_VERSION" ]; then self_update "$srv_version"; fi
  else
    failures=$((failures + 1))
    log "poll failed (attempt $failures)"
    check_jobs
    s=$((failures * 5)); [ "$s" -gt 60 ] && s=60
    sleep "$s"
  fi
done
