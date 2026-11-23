# name: System summary
# category: Inventory
# description: OS, uptime, memory, disks and network overview
# timeout: 120
echo "Host:    $(hostname -f 2>/dev/null || hostname)"
[ -r /etc/os-release ] && echo "OS:      $(. /etc/os-release; echo "$PRETTY_NAME")"
echo "Kernel:  $(uname -r)"
echo "Uptime:  $(uptime -p 2>/dev/null || uptime)"
echo
free -h
echo
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay
echo
ip -br addr 2>/dev/null || hostname -I
