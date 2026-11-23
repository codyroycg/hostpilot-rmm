# HostPilot task: install package updates (all, or a comma-separated list), optional reboot
#__ARGS__
export DEBIAN_FRONTEND=noninteractive
pkgs=""
[ "$A_ids" != "all" ] && pkgs="$(printf '%s' "$A_ids" | tr ',' ' ')"
rc=0
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -q
  opts="-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
  if [ -z "$pkgs" ]; then apt-get $opts dist-upgrade || rc=$?
  else apt-get $opts install --only-upgrade $pkgs || rc=$?; fi
elif command -v dnf >/dev/null 2>&1; then dnf -y upgrade $pkgs || rc=$?
elif command -v yum >/dev/null 2>&1; then yum -y update $pkgs || rc=$?
elif command -v zypper >/dev/null 2>&1; then zypper -n update $pkgs || rc=$?
else echo "No supported package manager found" >&2; exit 1
fi
need_reboot=0
if [ -f /var/run/reboot-required ]; then need_reboot=1
elif command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1; [ $? -eq 1 ] && need_reboot=1
fi
echo "Reboot required: $need_reboot"
if [ "$need_reboot" = 1 ] && [ "$A_reboot" = 1 ]; then
  shutdown -r +2 "Rebooting in 2 minutes to finish installing updates (HostPilot)" && echo "Reboot scheduled in 2 minutes."
fi
echo "--- remaining updates ---"
#__INCLUDE:updates.scan.sh__
exit $rc
