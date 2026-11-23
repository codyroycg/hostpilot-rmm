# HostPilot task: delete a local user (optionally the home folder)
#__ARGS__
[ "$A_name" = root ] && { echo "Refusing to delete root" >&2; exit 1; }
id "$A_name" >/dev/null || exit 1
if [ "$A_remove_home" = 1 ]; then userdel -r "$A_name"; else userdel "$A_name"; fi
rc=$?
[ $rc -eq 0 ] && echo "Deleted user $A_name"
[ $rc -eq 8 ] && echo "The user is currently logged in. Log them out (or disable the account) first." >&2
exit $rc
