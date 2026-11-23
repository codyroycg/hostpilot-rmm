# HostPilot task: modify a local user
set -e
#__ARGS__
#__INCLUDE:_admingroup.sh__
id "$A_name" >/dev/null
if [ -n "$A_password" ]; then printf '%s:%s\n' "$A_name" "$A_password" | chpasswd; echo "Password changed"; fi
if [ "$A_must_change" = 1 ]; then chage -d 0 "$A_name"; echo "Must change password at next login"; fi
if [ "$A_fullname_set" = 1 ]; then usermod -c "$A_fullname" "$A_name"; echo "Full name updated"; fi
if [ "$A_enabled" = 1 ]; then usermod -U -e '' "$A_name" 2>/dev/null || usermod -U "$A_name"; echo "Account enabled"
elif [ "$A_enabled" = 0 ]; then usermod -L -e 1 "$A_name"; echo "Account disabled (password locked + account expired)"
fi
if [ "$A_admin" = 1 ]; then
  [ -n "$admin_group" ] || { echo "No sudo/wheel group on this system" >&2; exit 1; }
  usermod -aG "$admin_group" "$A_name"; echo "Added to $admin_group"
elif [ "$A_admin" = 0 ]; then
  for g in sudo wheel admin; do gpasswd -d "$A_name" "$g" >/dev/null 2>&1 && echo "Removed from $g"; done
  true
fi
