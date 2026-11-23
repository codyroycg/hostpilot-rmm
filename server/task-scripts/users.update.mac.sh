# HostPilot task: modify a local user (macOS)
set -e
#__ARGS__
dscl . -read "/Users/$A_name" >/dev/null 2>&1 || { echo "No such user: $A_name" >&2; exit 1; }
if [ -n "$A_password" ]; then sysadminctl -resetPasswordFor "$A_name" -newPassword "$A_password" 2>&1; echo "Password changed (the user's login keychain keeps its old password)"; fi
if [ "$A_must_change" = 1 ]; then pwpolicy -u "$A_name" -setpolicy "newPasswordRequired=1" >/dev/null 2>&1; echo "Must change password at next login"; fi
if [ "$A_fullname_set" = 1 ]; then dscl . -create "/Users/$A_name" RealName "$A_fullname"; echo "Full name updated"; fi
if [ "$A_enabled" = 1 ]; then pwpolicy -u "$A_name" -enableuser >/dev/null 2>&1; echo "Account enabled"
elif [ "$A_enabled" = 0 ]; then pwpolicy -u "$A_name" -disableuser >/dev/null 2>&1; echo "Account disabled"; fi
if [ "$A_admin" = 1 ]; then dseditgroup -o edit -a "$A_name" -t user admin; echo "Added to admin"
elif [ "$A_admin" = 0 ]; then dseditgroup -o edit -d "$A_name" -t user admin; echo "Removed from admin"; fi
