# name: Pending reboot check
# category: Patching
# description: Says whether a reboot is needed (and which packages want it), and shows whether the running kernel is older than the installed one
# timeout: 120
need=0
echo "Running kernel: $(uname -r)"
echo "Up since:       $(uptime -s 2>/dev/null || uptime)"
if [ -f /var/run/reboot-required ]; then
  need=1; echo; echo "A reboot IS required (Debian/Ubuntu):"
  [ -f /var/run/reboot-required.pkgs ] && sort -u /var/run/reboot-required.pkgs | sed 's/^/  - /'
elif command -v needs-restarting >/dev/null 2>&1; then
  echo; needs-restarting -r; [ $? -eq 1 ] && need=1
fi
latest=$(ls -1 /boot/vmlinuz-* 2>/dev/null | sed 's|/boot/vmlinuz-||' | sort -V | tail -n 1)
if [ -n "$latest" ] && [ "$latest" != "$(uname -r)" ]; then
  need=1; echo; echo "Newer kernel installed: $latest (reboot to use it)"
fi
if command -v needrestart >/dev/null 2>&1; then
  echo; echo "=== Services using outdated libraries ==="; needrestart -b -r l 2>/dev/null | grep -E 'NEEDRESTART-(SVC|KSTA)'
fi
echo
if [ "$need" = 1 ]; then echo "Result: reboot needed."; else echo "Result: no reboot needed."; fi
exit 0
