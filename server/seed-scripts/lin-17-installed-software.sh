# name: Installed software
# category: Inventory
# description: Package count, the 25 most recently installed packages, plus snap and flatpak apps
# timeout: 120
if command -v dpkg-query >/dev/null 2>&1; then
  echo "$(dpkg-query -f '${binary:Package}\n' -W | wc -l) packages installed (dpkg)"
  echo; echo "=== Most recently installed ==="
  zgrep -h ' install ' /var/log/dpkg.log* 2>/dev/null | sort | tail -n 25 | awk '{print $1, $2, $4, $6}'
elif command -v rpm >/dev/null 2>&1; then
  echo "$(rpm -qa | wc -l) packages installed (rpm)"
  echo; echo "=== Most recently installed ==="
  rpm -qa --last | head -n 25
elif command -v pacman >/dev/null 2>&1; then
  echo "$(pacman -Q | wc -l) packages installed (pacman)"
  echo; echo "=== Most recently installed ==="
  grep -h 'installed' /var/log/pacman.log 2>/dev/null | tail -n 25
fi
if command -v snap >/dev/null 2>&1; then echo; echo "=== Snaps ==="; snap list 2>/dev/null; fi
if command -v flatpak >/dev/null 2>&1; then echo; echo "=== Flatpaks ==="; flatpak list --app --columns=application,version,origin 2>/dev/null; fi
exit 0
