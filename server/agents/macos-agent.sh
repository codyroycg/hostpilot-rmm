#!/bin/bash
# HostPilot RMM agent for macOS (10.15 Catalina and later). Plain bash 3.2 + curl + built-in tools.
# Runs as root under launchd (/Library/LaunchDaemons/com.hostpilot.agent.plist).
# Config: config.env next to this file (SERVER, AGENT_ID, SECRET).

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$BASE/agent.sh"
LABEL=com.hostpilot.agent

# Commands for use on the Mac:
#   sudo /Library/HostPilot/agent.sh --update   ask the running agent to download the latest version and restart
#   sudo /Library/HostPilot/agent.sh --status   show whether the agent is connected
case "$1" in
  --update)
    touch "$BASE/update-now" || exit 1
    echo "Update requested. The agent will download the latest version and restart within about 30 seconds."
    exit 0 ;;
  --status)
    if ! launchctl list "$LABEL" >/dev/null 2>&1; then echo "HostPilot agent: not running"; exit 3; fi
    if [ -r "$BASE/status" ]; then
      read -r st ts msg < "$BASE/status"
      echo "HostPilot agent: $st (last contact $(( $(date +%s) - ${ts:-0} ))s ago)${msg:+ - $msg}"
    else echo "HostPilot agent: running"; fi
    exit 0 ;;
esac

# shellcheck disable=SC1091
. "$BASE/config.env"
SERVER="${SERVER%/}"
export HOSTPILOT_SERVER="$SERVER"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
MY_VERSION="$(shasum -a 256 "$SELF" | cut -c1-12)"
JOBDIR="$BASE/jobs"
LOG="$BASE/agent.log"
MAX_OUT=1048576

mkdir -p "$JOBDIR"
rm -f "$JOBDIR"/* 2>/dev/null

log() {
  if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi
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
b64d() { base64 -D 2>/dev/null; }

# ---------------- metrics ----------------
cpu_total() { top -l 2 -n 0 -s 1 2>/dev/null | awk '/^CPU usage/ { u = $3; s = $5 } END { gsub(/%/, "", u); gsub(/%/, "", s); printf "%.0f", u + s }'; }

mem_pct() {
  local total; total=$(sysctl -n hw.memsize)
  vm_stat | awk -v total="$total" '
    /page size of/ { ps = $8 }
    /Pages active/ { a = $3 } /Pages wired down/ { w = $4 } /Pages occupied by compressor/ { c = $5 }
    END { gsub(/\./, "", a); gsub(/\./, "", w); gsub(/\./, "", c); if (total > 0) printf "%.1f", (a + w + c) * ps / total * 100; else print 0 }'
}

services_json() {
  local out="" s st
  for s in $WATCH_SERVICES; do
    if ! launchctl list "$s" >/dev/null 2>&1; then st=missing
    elif launchctl list "$s" 2>/dev/null | grep -q '"PID" = '; then st=running
    else st=stopped; fi
    out="$out{\"name\":\"$(jesc "$s")\",\"display\":\"\",\"status\":\"$st\",\"start\":\"\"},"
  done
  printf '[%s]' "${out%,}"
}

# interfaces (Wi-Fi, Ethernet, Thunderbolt, VPN tunnels) + byte counters of the physical ones
net_info() {
  local out="" port dev mac kind conn ips speed rx=0 tx=0 r t
  while IFS= read -r line; do
    case "$line" in
      "Hardware Port: "*) port="${line#Hardware Port: }" ;;
      "Device: "*) dev="${line#Device: }" ;;
      "Ethernet Address: "*)
        mac="${line#Ethernet Address: }"; [ "$mac" = "N/A" ] && mac=""
        case "$port" in *Wi-Fi*|*AirPort*) kind=wifi ;; *Bluetooth*) kind=bluetooth ;; *Ethernet*|*Thunderbolt*|*USB*|*LAN*) kind=ethernet ;; *) kind=other ;; esac
        conn=false; ifconfig "$dev" 2>/dev/null | grep -q 'status: active' && conn=true
        ips=$(ifconfig "$dev" 2>/dev/null | awk '/inet / {printf "\"%s\",", $2}')
        out="$out{\"name\":\"$(jesc "$port")\",\"make\":\"Apple\",\"model\":\"$(jesc "$port ($dev)")\",\"kind\":\"$kind\",\"connected\":$conn,\"mac\":\"$mac\",\"speed\":0,\"ips\":[${ips%,}]},"
        ;;
    esac
  done < <(networksetup -listallhardwareports 2>/dev/null)
  for dev in $(ifconfig -l); do
    case "$dev" in utun*|ppp*|ipsec*|tun*|tap*) ;; *) continue ;; esac
    ips=$(ifconfig "$dev" 2>/dev/null | awk '/inet / {printf "\"%s\",", $2}')
    [ -z "$ips" ] && continue   # macOS keeps idle utun interfaces around; only report tunnels with an address
    out="$out{\"name\":\"$dev\",\"make\":\"\",\"model\":\"VPN tunnel\",\"kind\":\"vpn\",\"connected\":true,\"mac\":\"\",\"speed\":0,\"ips\":[${ips%,}]},"
  done
  read -r r t <<< "$(netstat -ibn 2>/dev/null | awk '$1 ~ /^en[0-9]+$/ && $3 ~ /^<Link/ { r += $7; t += $10 } END { printf "%.0f %.0f", r, t }')"
  printf '"net_ifaces":[%s],"net_rx":%s,"net_tx":%s' "${out%,}" "${r:-0}" "${t:-0}"
}

checkin_body() {
  local f="$1" name ver build model serial users btime ips disks virt cpu
  cpu=$(cpu_total)
  name="$(sw_vers -productName) $(sw_vers -productVersion)"
  ver="$(sw_vers -productVersion) (build $(sw_vers -buildVersion))"
  model="$(sysctl -n hw.model 2>/dev/null)"
  serial="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformSerialNumber/ {print $4}')"
  users="$(stat -f %Su /dev/console 2>/dev/null)"; [ "$users" = root ] && users=""
  btime="$(sysctl -n kern.boottime | sed -n 's/.*sec = \([0-9]*\).*/\1/p')"
  ips=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {printf "\"%s\",", $2}')
  disks=$(df -kP 2>/dev/null | awk 'NR > 1 && $1 ~ /^\/dev\/disk/ && $6 !~ /^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware|Recovery)/ && $6 !~ /^\/private\/var\/vm/ {
      m = $6; for (i = 7; i <= NF; i++) m = m " " $i; gsub(/"/, "", m); printf "{\"mount\":\"%s\",\"total\":%.0f,\"free\":%.0f},", m, $2 * 1024, $4 * 1024 }')
  virt=false
  { [ "$(sysctl -n kern.hv_vmm_present 2>/dev/null)" = 1 ] || printf '%s' "$model" | grep -qiE 'vmware|parallels|virtual'; } && virt=true
  cat > "$f" <<EOF
{"hostname":"$(jesc "$(scutil --get ComputerName 2>/dev/null || hostname)")","cpu":${cpu:-0},"core_load":[],"chassis":[],"is_virtual":$virt,"mac_model":"$(jesc "$model")",
"services":$(services_json),"mem":$(mem_pct),"disks":[${disks%,}],"ip_addrs":[${ips%,}],
"logged_user":"$(jesc "$users")","os_name":"$(jesc "$name")","os_version":"$(jesc "$ver")","arch":"$(uname -m)",
"cpu_model":"$(jesc "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)")","cpu_cores":$(sysctl -n hw.logicalcpu),"ram_total":$(sysctl -n hw.memsize),
"manufacturer":"Apple","model":"$(jesc "$model")","serial":"$(jesc "$serial")",
"boot_time":$(( ${btime:-0} * 1000 )),"agent_version":"$MY_VERSION",$(net_info)}
EOF
}

# installed applications (name, version, bundle id)
send_inventory() {
  local f="$JOBDIR/.inventory.json" list="" app n v id
  for app in /Applications/*.app /Applications/*/*.app /Applications/Utilities/*.app; do
    [ -d "$app" ] || continue
    n=$(defaults read "$app/Contents/Info" CFBundleName 2>/dev/null || basename "$app" .app)
    v=$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)
    id=$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)
    list="$list$(printf '%s\t%s\t%s' "$n" "$v" "$id" | tr '\n' ' ')
"
  done
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
  rm -f /Library/LaunchDaemons/com.hostpilot.agent.plist
  rm -rf "$BASE"
  launchctl bootout "system/$LABEL" >/dev/null 2>&1 || launchctl remove "$LABEL" >/dev/null 2>&1
  exit 0
}

# macOS has no `timeout`; perl runs the job in its own process group and kills the group on expiry (exit 124)
with_timeout() { # seconds command...
  perl -e 'my $t = shift; my $pid = fork; if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
    $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 5; kill "KILL", -$pid; waitpid($pid, 0); exit 124 };
    alarm $t; waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$@"
}

start_job() { # id shell timeout base64body
  local id="$1" shell="$2" to="$3" stem="$JOBDIR/$1" cmd
  [ "$to" -gt 0 ] 2>/dev/null || to=300
  printf '%s' "$4" | b64d > "$stem.script"
  case "$shell" in
    bash) cmd=(/bin/bash "$stem.script") ;;
    sh) cmd=(/bin/sh "$stem.script") ;;
    zsh) cmd=(/bin/zsh "$stem.script") ;;
    python)
      if command -v python3 >/dev/null 2>&1 && python3 -c 'pass' >/dev/null 2>&1; then cmd=(python3 "$stem.script")
      else rm -f "$stem.script"; post_message "$id" 127 "python3 is not installed on this Mac"; return; fi ;;
    _uninstall) uninstall "$id" ;;
    _update) rm -f "$stem.script"; force_update "$id"; return ;;
    *) rm -f "$stem.script"; post_message "$id" 127 "Shell '$shell' is not supported on macOS"; return ;;
  esac
  (
    cd /tmp || exit
    with_timeout "$to" "${cmd[@]}" > "$stem.out" 2> "$stem.err" < /dev/null
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

running_jobs() { ls "$JOBDIR"/*.script 2>/dev/null | wc -l | tr -d ' '; }

self_update() {
  [ "$(running_jobs)" -eq 0 ] || return
  local tmp="$SELF.new"
  if curl -sS --fail --max-time 60 -o "$tmp" "$SERVER/agent/macos.sh"; then
    if [ "$(shasum -a 256 "$tmp" | cut -c1-12)" = "$1" ]; then
      chmod 700 "$tmp"; mv -f "$tmp" "$SELF"
      log "updated agent $MY_VERSION -> $1, restarting"
      exit 0 # launchd (KeepAlive) restarts us
    fi
    log "update hash mismatch"; rm -f "$tmp"
  fi
}

force_update() { # [job_id]
  local tmp="$SELF.new" new
  rm -f "$BASE/update-now"
  log "forced update requested${1:+ (job $1)}"
  if curl -sS --fail --max-time 60 -o "$tmp" "$SERVER/agent/macos.sh" && [ -s "$tmp" ]; then
    new="$(shasum -a 256 "$tmp" | cut -c1-12)"
    [ -n "$1" ] && post_message "$1" 0 "Updating agent $MY_VERSION -> $new and restarting. The device reconnects within a minute."
    chmod 700 "$tmp"; mv -f "$tmp" "$SELF"
    log "forced update $MY_VERSION -> $new, restarting"
    exit 0
  fi
  rm -f "$tmp"
  log "forced update failed (download)"
  [ -n "$1" ] && post_message "$1" 1 "Update failed: could not download the agent from $SERVER"
  return 0
}

last_contact=0
set_status() {
  [ "$1" = connected ] && last_contact=$(date +%s)
  printf '%s %s %s\n' "$1" "$last_contact" "$2" > "$BASE/status" 2>/dev/null
}

log "agent $MY_VERSION starting (server $SERVER)"
interval=60
last_checkin=0
failures=0
body="$JOBDIR/.checkin.json"
WATCH_SERVICES=""

while true; do
  [ -e "$BASE/update-now" ] && force_update
  now=$(date +%s)
  if [ $((now - last_checkin)) -ge "$interval" ]; then
    checkin_body "$body"
    if cresp=$(api POST /api/agent/checkin "$body" 30); then
      last_checkin=$(date +%s)
      WATCH_SERVICES="$(printf '%s' "$cresp" | sed -n 's/.*"watch_services":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ')"
    fi
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
    set_status connected
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
    set_status disconnected "can't reach $SERVER"
    check_jobs
    s=$((failures * 5)); [ "$s" -gt 60 ] && s=60
    sleep "$s"
  fi
done
