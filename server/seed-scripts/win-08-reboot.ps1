# name: Reboot in 5 minutes (with warning)
# category: Maintenance
# description: Warns logged-on users and reboots after 5 minutes. Cancel on the device with "shutdown /a".
# timeout: 60
shutdown.exe /r /t 300 /c "This computer will restart in 5 minutes for maintenance. Please save your work."
"Reboot scheduled in 5 minutes."
