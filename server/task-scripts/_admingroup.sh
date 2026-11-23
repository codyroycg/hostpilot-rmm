# the distro's admin (sudo) group
admin_group=""
for g in sudo wheel; do
  if getent group "$g" >/dev/null 2>&1; then admin_group="$g"; break; fi
done
