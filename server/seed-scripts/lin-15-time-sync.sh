# name: Sync the clock
# category: Maintenance
# description: Turns on network time sync if it is off, forces a sync and shows the time source and offset
# timeout: 120
if command -v timedatectl >/dev/null 2>&1; then
  timedatectl set-ntp true 2>/dev/null
fi
if command -v chronyc >/dev/null 2>&1 && chronyc tracking >/dev/null 2>&1; then
  chronyc -a makestep >/dev/null 2>&1 && echo "chrony: clock stepped to network time."
  echo; chronyc tracking | grep -E 'Reference ID|Stratum|System time|Last offset|Leap status'
elif systemctl is-active --quiet systemd-timesyncd 2>/dev/null; then
  systemctl restart systemd-timesyncd && sleep 3
  echo "systemd-timesyncd restarted to force a sync."
  echo; timedatectl timesync-status 2>/dev/null | grep -E 'Server|Offset|Poll|Packet count'
elif command -v ntpq >/dev/null 2>&1; then ntpq -p
else echo "No time sync service found (chrony or systemd-timesyncd)."; fi
echo
timedatectl 2>/dev/null | grep -E 'Local time|Time zone|synchronized|NTP service' || date
exit 0
