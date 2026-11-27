# HostPilot task: cancel a scheduled restart or shutdown (Linux: shutdown -c; macOS: stop the waiting shutdown process)
#__ARGS__
if shutdown -c >/dev/null 2>&1; then echo "Scheduled restart / shutdown cancelled."; exit 0; fi
if pkill -x shutdown 2>/dev/null; then echo "Scheduled restart / shutdown cancelled."; exit 0; fi
echo "Nothing was scheduled."
