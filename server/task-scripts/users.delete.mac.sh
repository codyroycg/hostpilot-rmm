# HostPilot task: delete a local user (macOS)
#__ARGS__
[ "$A_name" = root ] && { echo "Refusing to delete root" >&2; exit 1; }
dscl . -read "/Users/$A_name" >/dev/null 2>&1 || { echo "No such user: $A_name" >&2; exit 1; }
if [ "$A_remove_home" = 1 ]; then sysadminctl -deleteUser "$A_name" 2>&1; else sysadminctl -deleteUser "$A_name" -keepHome 2>&1; fi
dscl . -read "/Users/$A_name" >/dev/null 2>&1 && { echo "The user could not be deleted (logged in?)" >&2; exit 1; }
echo "Deleted user $A_name"
