# name: Free up disk space
# category: Maintenance
# description: Cleans the package cache, removes unused packages, shrinks the systemd journal to 200 MB and deletes temp files older than 7 days
# timeout: 900
before=$(df -k --output=avail / 2>/dev/null | tail -n 1)
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get -y -q autoremove --purge; apt-get -q clean
elif command -v dnf >/dev/null; then dnf -y autoremove; dnf clean all
elif command -v yum >/dev/null; then yum -y autoremove; yum clean all
elif command -v zypper >/dev/null; then zypper -n clean --all
elif command -v pacman >/dev/null; then pacman -Sc --noconfirm
fi
command -v journalctl >/dev/null && journalctl --vacuum-size=200M 2>&1 | tail -n 1
find /tmp /var/tmp -xdev -type f -atime +7 -delete 2>/dev/null
command -v snap >/dev/null && snap list --all 2>/dev/null | awk '/disabled/ {print $1, $3}' | while read -r n r; do snap remove "$n" --revision="$r" >/dev/null 2>&1 && echo "Removed old snap $n (rev $r)"; done
after=$(df -k --output=avail / 2>/dev/null | tail -n 1)
if [ -n "$before" ] && [ -n "$after" ]; then echo; echo "Freed approximately $(( (after - before) / 1024 )) MB on /"; fi
df -h /
