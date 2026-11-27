# name: Signed-in users and sessions
# category: Inventory
# description: Who is signed in (desktop and SSH) with idle time, plus the last 15 sign-ins and recent reboots
# timeout: 60
echo "=== Signed in now ==="
w 2>/dev/null || who
echo
if command -v loginctl >/dev/null 2>&1; then echo "=== Sessions ==="; loginctl list-sessions --no-legend 2>/dev/null; echo; fi
echo "=== Last 15 sign-ins ==="
last -n 15 -w 2>/dev/null | grep -v '^$' || echo "(no sign-in history available)"
exit 0
