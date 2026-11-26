# HostPilot task: detect server roles from enabled systemd services
# Output: ROLE\t<role id>\t<service,service,...>
#__ARGS__
if ! command -v systemctl >/dev/null 2>&1; then echo "Role detection needs systemd" >&2; exit 1; fi
enabled="$(systemctl list-unit-files --type=service --state=enabled --no-legend 2>/dev/null | awk '{ sub(/\.service$/, "", $1); print $1 }')"
emit() { # emit <role> <candidate services...>: prints the ones that are enabled here
  role="$1"; shift; found=""
  for s in "$@"; do printf '%s\n' "$enabled" | grep -qx "$s" && found="${found:+$found,}$s"; done
  [ -n "$found" ] && printf 'ROLE\t%s\t%s\n' "$role" "$found"
  return 0
}
emit domain_controller samba-ad-dc
emit dns_server named bind9 pdns
emit dhcp_server isc-dhcp-server dhcpd kea-dhcp4-server
emit file_server smbd nfs-server
emit kvm libvirtd
emit docker docker containerd
emit mysql mysql mysqld mariadb
pg="$(printf '%s\n' "$enabled" | grep -E '^postgresql(@.*)?$' | head -n 5 | tr '\n' ' ')"
# shellcheck disable=SC2086
[ -n "$pg" ] && emit postgresql $pg
emit mail_server postfix exim4 exim dovecot
emit web_server nginx apache2 httpd caddy
echo "Role detection finished"
