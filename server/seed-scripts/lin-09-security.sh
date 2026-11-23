# name: Security quick check
# category: Security
# description: Listening ports, sudo-capable users, recent failed SSH logins
# timeout: 120
echo "=== Listening ports ==="
ss -tulpn 2>/dev/null || netstat -tulpn
echo
echo "=== Users with sudo/wheel ==="
getent group sudo wheel admin 2>/dev/null
echo
echo "=== Recent failed SSH logins ==="
(journalctl -u ssh -u sshd --since "24 hours ago" --no-pager 2>/dev/null || cat /var/log/auth.log 2>/dev/null) | grep -i "failed password" | tail -n 20
exit 0
