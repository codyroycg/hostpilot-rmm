# HostPilot task: install macOS updates (all, or comma-separated labels), optional restart
#__ARGS__
rc=0
args="-i"; [ "$A_reboot" = 1 ] && args="-i -R"
if [ "$A_ids" = all ]; then softwareupdate $args -a 2>&1 || rc=$?
else
  IFS=','; for l in $A_ids; do softwareupdate $args "$l" 2>&1 || rc=$?; done; unset IFS
fi
[ "$A_reboot" = 1 ] && echo "Updates that need a restart restart the Mac automatically (-R)."
echo "--- remaining updates ---"
#__INCLUDE:updates.scan.mac.sh__
exit $rc
