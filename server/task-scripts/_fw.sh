# shared firewall helpers for Linux: ufw or firewalld (plain iptables/nftables are listed read-only)
fw_backend() {
  if command -v ufw >/dev/null 2>&1 && LC_ALL=C ufw status 2>/dev/null | grep -q '^Status: active'; then echo ufw
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then echo firewalld
  elif command -v ufw >/dev/null 2>&1; then echo ufw-inactive
  elif command -v nft >/dev/null 2>&1 && [ -n "$(nft list ruleset 2>/dev/null)" ]; then echo nftables
  elif command -v iptables >/dev/null 2>&1; then echo iptables
  else echo none; fi
}

fw_need_managed() {
  case "$FW" in
    ufw|firewalld) return 0 ;;
    ufw-inactive) echo "ufw is installed but not enabled. Enable it first (ufw enable), making sure SSH is allowed." >&2; exit 1 ;;
    *) echo "Rule management needs ufw or firewalld; this device uses ${FW}. Install and enable ufw (Debian/Ubuntu) or firewalld (RHEL/Fedora/SUSE)." >&2; exit 1 ;;
  esac
}

# fw_add: uses A_direction A_action A_protocol A_local_port A_remote_address A_name
fw_add() {
  local act="allow" dir="${A_direction:-in}" proto="${A_protocol:-any}" port="${A_local_port}" addr="${A_remote_address}"
  [ "$A_action" = block ] && act=deny
  [ "$port" = any ] && port=""
  [ "$addr" = any ] && addr=""
  [ "$A_enabled" = 0 ] && echo "Note: Linux firewalls have no disabled rules; the rule was added enabled." >&2
  case "$FW" in
    ufw)
      local args=("$act" "$dir")
      case "$proto" in tcp|udp) args+=(proto "$proto") ;; any) ;; *) [ -n "$proto" ] && args+=(proto "${proto%v4}") ;; esac
      local p="${port//-/:}"; p="${p// /}"
      if [ "$dir" = out ]; then
        args+=(from any to "${addr:-any}"); [ -n "$p" ] && args+=(port "$p")
      else
        args+=(from "${addr:-any}" to any); [ -n "$p" ] && args+=(port "$p")
      fi
      [ -n "$A_name" ] && args+=(comment "$A_name")
      ufw "${args[@]}" || exit 1
      echo "Added: ufw ${args[*]}"
      ;;
    firewalld)
      [ "$dir" = out ] && { echo "firewalld zones only filter incoming traffic; outbound rules need ufw or nftables." >&2; exit 1; }
      local fam=ipv4 rule
      case "$addr" in *:*) fam=ipv6 ;; esac
      [ "$proto" = icmpv6 ] && fam=ipv6
      rule="rule family=\"$fam\""
      [ -n "$addr" ] && rule="$rule source address=\"$addr\""
      if [ -n "$port" ]; then
        case "$proto" in tcp|udp) ;; *) echo "A port needs protocol TCP or UDP" >&2; exit 1 ;; esac
        rule="$rule port port=\"${port// /}\" protocol=\"$proto\""
      elif [ "$proto" = tcp ] || [ "$proto" = udp ]; then rule="$rule protocol value=\"$proto\""
      elif [ "$proto" = icmpv4 ] || [ "$proto" = icmpv6 ]; then rule="$rule protocol value=\"${proto/v4/}\""
      fi
      if [ "$act" = allow ]; then rule="$rule accept"; else rule="$rule drop"; fi
      firewall-cmd --permanent --add-rich-rule="$rule" >/dev/null || exit 1
      firewall-cmd --reload >/dev/null
      echo "Added firewalld rich rule: $rule"
      ;;
  esac
}

# fw_del <id> as produced by fw.list
fw_del() {
  local id="$1"
  case "$FW" in
    ufw)
      local spec="${id#ufw }"
      spec="$(printf '%s' "$spec" | sed -E "s/ comment '.*'\$//")"
      printf '%s' "$spec" | grep -qE '^[A-Za-z0-9 ./:,_-]+$' || { echo "Unrecognised rule: $id" >&2; exit 1; }
      local parts; read -ra parts <<< "$spec"
      ufw --force delete "${parts[@]}" || exit 1
      echo "Deleted: ufw $spec"
      ;;
    firewalld)
      case "$id" in
        service:*) firewall-cmd --permanent --remove-service="${id#service:}" >/dev/null || exit 1 ;;
        port:*) firewall-cmd --permanent --remove-port="${id#port:}" >/dev/null || exit 1 ;;
        rich:*) firewall-cmd --permanent --remove-rich-rule="${id#rich:}" >/dev/null || exit 1 ;;
        *) echo "Unrecognised rule: $id" >&2; exit 1 ;;
      esac
      firewall-cmd --reload >/dev/null
      echo "Deleted: $id"
      ;;
  esac
}
FW="$(fw_backend)"
