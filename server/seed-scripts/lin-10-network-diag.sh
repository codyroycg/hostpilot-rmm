# name: Network diagnostics
# category: Network
# description: Interfaces, addresses, routes and DNS servers, then tests the gateway, DNS lookups and internet reachability
# timeout: 180
echo "=== Interfaces ==="
ip -brief address 2>/dev/null || ifconfig
echo
echo "=== Default route ==="
ip route show default 2>/dev/null
echo
echo "=== DNS servers ==="
if command -v resolvectl >/dev/null 2>&1; then resolvectl dns 2>/dev/null | grep -v ': *$'; else grep '^nameserver' /etc/resolv.conf; fi
echo
echo "=== Tests ==="
check() { printf '%-22s %s\n' "$1" "$2"; }
gw=$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')
if [ -n "$gw" ]; then
  if ping -c 2 -W 2 "$gw" >/dev/null 2>&1; then check "Ping gateway" "OK  ($gw)"; else check "Ping gateway" "FAILED  ($gw)"; fi
else check "Ping gateway" "skipped (no default route)"; fi
if ping -c 2 -W 2 1.1.1.1 >/dev/null 2>&1; then check "Ping internet (IP)" "OK  (1.1.1.1)"; else check "Ping internet (IP)" "FAILED  (1.1.1.1)"; fi
for n in www.google.com www.cloudflare.com; do
  ip=$(getent ahostsv4 "$n" 2>/dev/null | awk '{print $1; exit}')
  if [ -n "$ip" ]; then check "DNS lookup" "OK  ($n -> $ip)"; else check "DNS lookup" "FAILED  ($n)"; fi
done
if command -v curl >/dev/null 2>&1; then
  if curl -s -o /dev/null -m 10 https://www.google.com; then check "HTTPS (port 443)" "OK"; else check "HTTPS (port 443)" "FAILED"; fi
  pub=$(curl -s -m 10 https://api.ipify.org) && [ -n "$pub" ] && check "Public IP" "$pub"
fi
exit 0
