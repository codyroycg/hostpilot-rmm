# name: Firewall status
# category: Security
# description: Shows whether a firewall is active (ufw, firewalld or nftables / iptables) and its rules
# timeout: 60
found=0
if command -v ufw >/dev/null 2>&1; then found=1; echo "=== ufw ==="; ufw status verbose; echo; fi
if command -v firewall-cmd >/dev/null 2>&1; then
  found=1; echo "=== firewalld ==="
  if firewall-cmd --state >/dev/null 2>&1; then firewall-cmd --state; firewall-cmd --list-all; else echo "not running"; fi
  echo
fi
if command -v nft >/dev/null 2>&1; then
  rules=$(nft list ruleset 2>/dev/null)
  if [ -n "$rules" ]; then found=1; echo "=== nftables ruleset (first 80 lines) ==="; printf '%s\n' "$rules" | head -n 80; echo; fi
fi
if [ "$found" = 0 ] && command -v iptables >/dev/null 2>&1; then found=1; echo "=== iptables ==="; iptables -S 2>/dev/null | head -n 80; fi
[ "$found" = 0 ] && echo "No firewall tool found (ufw, firewalld, nft or iptables)."
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q inactive && ! firewall-cmd --state >/dev/null 2>&1; then
  echo "WARNING: ufw is installed but inactive."
fi
exit 0
