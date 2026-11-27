# name: Disk health
# category: Hardware
# description: SMART health of every disk (if smartmontools is installed), filesystem usage and inode usage
# timeout: 180
echo "=== Disks ==="
lsblk -d -o NAME,MODEL,SIZE,ROTA,TYPE 2>/dev/null | grep -v ' loop'
echo
bad=0
if command -v smartctl >/dev/null 2>&1; then
  echo "=== SMART health ==="
  for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk" {print $1}'); do
    out=$(smartctl -H -A "/dev/$d" 2>/dev/null)
    health=$(printf '%s\n' "$out" | grep -Ei 'overall-health|SMART Health Status' | sed 's/.*: *//')
    [ -z "$health" ] && health="not available"
    printf '%-10s %s\n' "$d" "$health"
    printf '%s\n' "$out" | grep -Ei '^ *(5|187|197|198) |Percentage Used|Media and Data Integrity Errors|Power_On_Hours|Power On Hours|Temperature' | sed 's/^/           /'
    case "$health" in PASSED|OK) ;; "not available") ;; *) bad=1 ;; esac
  done
else
  echo "smartmontools is not installed, so SMART health can't be read (apt install smartmontools)."
fi
echo
echo "=== Filesystems ==="
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -h
echo
echo "=== Inodes ==="
df -i -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | awk 'NR==1 || $5+0 >= 50'
if [ "$bad" = 1 ]; then echo; echo "WARNING: at least one disk failed its SMART health check. Back up this computer."; exit 1; fi
exit 0
