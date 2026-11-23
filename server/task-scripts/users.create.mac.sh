# HostPilot task: create a local user (macOS)
set -e
#__ARGS__
dscl . -read "/Users/$A_name" >/dev/null 2>&1 && { echo "User $A_name already exists" >&2; exit 1; }
adm=""; [ "$A_admin" = 1 ] && adm="-admin"
sysadminctl -addUser "$A_name" -fullName "${A_fullname:-$A_name}" -password "$A_password" $adm 2>&1
dscl . -read "/Users/$A_name" >/dev/null 2>&1 || { echo "Creating the user failed" >&2; exit 1; }
echo "Created user $A_name${adm:+ (administrator)}"
if [ "$A_must_change" = 1 ]; then pwpolicy -u "$A_name" -setpolicy "newPasswordRequired=1" >/dev/null 2>&1 && echo "Must change password at next login"; fi
