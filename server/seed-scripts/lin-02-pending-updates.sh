# name: List pending package updates
# category: Patching
# description: Refreshes package metadata and lists upgradable packages (apt, dnf, yum, zypper)
# timeout: 900
if command -v apt-get >/dev/null; then
  apt-get update -qq >/dev/null && apt list --upgradable 2>/dev/null | tail -n +2
elif command -v dnf >/dev/null; then
  dnf -q check-update; [ $? -eq 100 ] && exit 0
elif command -v yum >/dev/null; then
  yum -q check-update; [ $? -eq 100 ] && exit 0
elif command -v zypper >/dev/null; then
  zypper -q list-updates
else
  echo "No supported package manager found"; exit 1
fi
[ -f /var/run/reboot-required ] && echo "*** Reboot required ***"
exit 0
