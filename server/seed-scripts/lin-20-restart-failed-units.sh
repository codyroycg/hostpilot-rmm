# name: Restart failed services
# category: Maintenance
# description: Restarts every failed systemd service once and reports which ones came back
# timeout: 300
units=$(systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}')
if [ -z "$units" ]; then echo "No failed services."; exit 0; fi
fail=0
for u in $units; do
  systemctl reset-failed "$u" 2>/dev/null
  if systemctl restart "$u" 2>/dev/null && sleep 2 && systemctl is-active --quiet "$u"; then
    echo "OK      $u"
  else
    fail=1; echo "FAILED  $u"
    journalctl -u "$u" -n 5 --no-pager 2>/dev/null | sed 's/^/        /'
  fi
done
exit $fail
