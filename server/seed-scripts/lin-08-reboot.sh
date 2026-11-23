# name: Reboot in 5 minutes (with warning)
# category: Maintenance
# description: Broadcasts a warning and reboots in 5 minutes. Cancel on the host with "shutdown -c".
# timeout: 60
shutdown -r +5 "Rebooting in 5 minutes for maintenance"
echo "Reboot scheduled in 5 minutes."
