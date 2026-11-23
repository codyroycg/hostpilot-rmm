# HostPilot task: delete a firewall rule (ufw or firewalld)
#__ARGS__
#__INCLUDE:_fw.sh__
fw_need_managed
fw_del "$A_id"
