# HostPilot task: modify a firewall rule (ufw / firewalld have no in-place edit: remove the old rule, add the new one)
#__ARGS__
#__INCLUDE:_fw.sh__
fw_need_managed
if [ -n "$A_enabled" ] && [ -z "$A_direction" ]; then
  echo "Linux firewalls (ufw/firewalld) can't disable a rule; delete it instead." >&2; exit 1
fi
fw_del "$A_id"
fw_add
