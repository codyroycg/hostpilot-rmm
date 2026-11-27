# name: Local user accounts
# category: Security
# description: Accounts that can sign in, their groups, password state and last sign-in
# timeout: 60
min=$(awk '/^UID_MIN/ {print $2}' /etc/login.defs 2>/dev/null); min=${min:-1000}
printf '%-18s %-6s %-22s %-10s %s\n' USER UID SHELL PASSWORD GROUPS
getent passwd | awk -F: -v min="$min" '($3 == 0 || ($3 >= min && $3 < 65534))' | while IFS=: read -r u _ uid _ _ home sh; do
  st=$(passwd -S "$u" 2>/dev/null | awk '{print $2}')
  case "$st" in P|PS) pw=set ;; L|LK) pw=locked ;; NP) pw=EMPTY ;; *) pw=? ;; esac
  printf '%-18s %-6s %-22s %-10s %s\n' "$u" "$uid" "$sh" "$pw" "$(id -nG "$u" 2>/dev/null)"
done
echo
echo "=== Last sign-in per account ==="
if command -v lastlog >/dev/null 2>&1; then lastlog 2>/dev/null | grep -v 'Never logged in'
elif command -v lastlog2 >/dev/null 2>&1; then lastlog2 2>/dev/null
else last -n 20 -w 2>/dev/null | head -n 20; fi
echo
echo "=== Accounts with sudo rights ==="
getent group sudo wheel admin 2>/dev/null
grep -rhs '^[^#].*ALL' /etc/sudoers /etc/sudoers.d/ 2>/dev/null | grep -v '^Defaults'
exit 0
