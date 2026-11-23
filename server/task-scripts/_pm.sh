# detect the package manager
export DEBIAN_FRONTEND=noninteractive
pm=""
for c in apt-get dnf yum zypper apk pacman; do
  if command -v "$c" >/dev/null 2>&1; then pm="$c"; break; fi
done
[ -n "$pm" ] || { echo "No supported package manager found" >&2; exit 1; }
