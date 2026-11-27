# name: Scheduled jobs (cron and timers)
# category: Security
# description: Every user's crontab, system cron files and active systemd timers. Useful when hunting for unwanted jobs.
# timeout: 60
echo "=== User crontabs ==="
for u in $(cut -d: -f1 /etc/passwd); do
  c=$(crontab -l -u "$u" 2>/dev/null | grep -v '^\s*#' | grep -v '^\s*$')
  [ -n "$c" ] && { echo "--- $u"; printf '%s\n' "$c"; }
done
echo
echo "=== /etc/crontab and /etc/cron.d ==="
for f in /etc/crontab /etc/cron.d/*; do
  [ -f "$f" ] || continue
  c=$(grep -v '^\s*#' "$f" | grep -v '^\s*$' | grep -v '^[A-Z_]*=')
  [ -n "$c" ] && { echo "--- $f"; printf '%s\n' "$c"; }
done
echo
echo "=== cron.hourly / daily / weekly / monthly ==="
for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  [ -d "$d" ] && echo "$d: $(ls "$d" 2>/dev/null | tr '\n' ' ')"
done
echo
if command -v systemctl >/dev/null 2>&1; then echo "=== systemd timers ==="; systemctl list-timers --no-pager 2>/dev/null; fi
exit 0
