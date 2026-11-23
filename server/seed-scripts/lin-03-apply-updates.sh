# name: Apply package updates (no reboot)
# category: Patching
# description: Non-interactively upgrades all packages. Reports whether a reboot is required.
# timeout: 7200
set -e
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade
  apt-get -y -q autoremove
elif command -v dnf >/dev/null; then
  dnf -y upgrade
elif command -v yum >/dev/null; then
  yum -y update
elif command -v zypper >/dev/null; then
  zypper -n update
else
  echo "No supported package manager found"; exit 1
fi
if [ -f /var/run/reboot-required ]; then echo "*** Reboot required ***"
elif command -v needs-restarting >/dev/null; then needs-restarting -r || true
fi
