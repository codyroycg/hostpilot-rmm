# name: Failed systemd units + recent errors
# category: Troubleshooting
# description: Lists failed systemd units and error-level journal entries from the last 24 hours
# timeout: 120
echo "=== Failed units ==="
systemctl --failed --no-pager
echo
echo "=== Journal errors (24h, last 50) ==="
journalctl -p err --since "24 hours ago" --no-pager -n 50 2>/dev/null || echo "journalctl not available"
