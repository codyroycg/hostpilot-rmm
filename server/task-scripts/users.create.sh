# HostPilot task: create a local user
set -e
#__ARGS__
#__INCLUDE:_admingroup.sh__
shell=/bin/bash; [ -x "$shell" ] || shell=/bin/sh
useradd -m -s "$shell" -c "$A_fullname" "$A_name"
printf '%s:%s\n' "$A_name" "$A_password" | chpasswd
echo "Created user $A_name"
if [ "$A_admin" = 1 ]; then
  [ -n "$admin_group" ] || { echo "No sudo/wheel group on this system" >&2; exit 1; }
  usermod -aG "$admin_group" "$A_name" && echo "Added to $admin_group"
fi
if [ "$A_must_change" = 1 ]; then chage -d 0 "$A_name" && echo "Must change password at next login"; fi
