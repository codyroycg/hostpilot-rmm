# name: Top processes
# category: Troubleshooting
# description: Top 15 processes by CPU and by memory
# timeout: 60
echo "=== By CPU ==="
ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -n 16
echo
echo "=== By memory ==="
ps -eo pid,user,%cpu,%mem,rss,comm --sort=-%mem | head -n 16
