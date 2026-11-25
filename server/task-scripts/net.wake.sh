# HostPilot task: send Wake-on-LAN magic packets to sleeping machines on this device's network
# Uses Python (3, or 2 on older macOS); falls back to wakeonlan / etherwake when Python is missing.
#__ARGS__
py=""
# actually run it: on macOS /usr/bin/python3 is a stub that fails until the developer tools are installed
for p in python3 python; do "$p" -c 'import socket' >/dev/null 2>&1 && { py="$p"; break; }; done
if [ -n "$py" ]; then
  "$py" - "$A_macs" "$A_bcasts" <<'PY'
import socket, sys, binascii
macs = [m for m in sys.argv[1].split(',') if m]
targets = [t for t in sys.argv[2].split(',') if t]
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
sent = 0
for mac in macs:
    raw = binascii.unhexlify(mac.replace(':', '').replace('-', ''))
    packet = b'\xff' * 6 + raw * 16
    for t in targets:
        for port in (9, 7):
            for _ in range(3):
                try:
                    s.sendto(packet, (t, port)); sent += 1
                except Exception as e:
                    print("Could not send to %s:%d: %s" % (t, port, e))
    print("Magic packet sent for %s via %s" % (mac, ', '.join(targets)))
sys.exit(0 if sent else 1)
PY
  exit $?
fi
IFS=',' read -r -a macs <<< "$A_macs"
if command -v wakeonlan >/dev/null 2>&1; then
  for m in "${macs[@]}"; do wakeonlan "$m"; done; exit 0
fi
if command -v etherwake >/dev/null 2>&1; then
  for m in "${macs[@]}"; do etherwake -b "$m" && echo "Magic packet sent for $m"; done; exit 0
fi
echo "Can't send Wake-on-LAN packets from this device: install python3 (or wakeonlan / etherwake)." >&2
exit 1
