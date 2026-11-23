# name: Largest directories
# category: Troubleshooting
# description: Shows the 20 largest directories on the root filesystem (2 levels deep)
# timeout: 600
du -xh --max-depth=2 / 2>/dev/null | sort -rh | head -n 20
