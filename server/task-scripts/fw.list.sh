# HostPilot task: Linux firewall status and rules (ufw / firewalld; iptables or nftables read-only)
# Output:
#   F\tprofile\tenabled 0|1\tdefault_inbound\tdefault_outbound
#   R\tid\tname\tenabled 0|1\tdirection in|out\taction allow|block\tprotocol\tlocal_ports\tremote_ports\tremote_addresses\tprogram\tprofiles\tgroup\tsource local|readonly\tdescription
#__ARGS__
#__INCLUDE:_fw.sh__
clean() { printf '%s' "$1" | tr '\t\r\n' '   '; }
echo "B	$FW"
case "$FW" in
  ufw|ufw-inactive)
    v="$(LC_ALL=C ufw status verbose 2>/dev/null)"
    on=0; printf '%s' "$v" | grep -q '^Status: active' && on=1
    din="$(printf '%s\n' "$v" | sed -n 's/^Default: \([a-z]*\) (incoming), \([a-z]*\) (outgoing).*/\1/p')"
    dout="$(printf '%s\n' "$v" | sed -n 's/^Default: \([a-z]*\) (incoming), \([a-z]*\) (outgoing).*/\2/p')"
    printf 'F\tufw\t%s\t%s\t%s\n' "$on" "$din" "$dout"
    LC_ALL=C ufw show added 2>/dev/null | grep '^ufw ' | while IFS= read -r cmd; do
      printf '%s\n' "$cmd" | awk -v id="$(clean "$cmd")" '
        { s = $0; c = ""; if (match(s, / comment \047.*\047$/)) { c = substr(s, RSTART + 10, RLENGTH - 11); s = substr(s, 1, RSTART - 1) }
          n = split(s, t, " "); act = ""; dir = "in"; proto = "any"; port = ""; from = "any"; to = "any"; app = ""
          for (i = 2; i <= n; i++) {
            w = t[i]
            if (w ~ /^(allow|deny|reject|limit)$/ && act == "") act = w
            else if (w == "in" || w == "out") dir = w
            else if (w == "proto") proto = t[++i]
            else if (w == "from") from = t[++i]
            else if (w == "to") to = t[++i]
            else if (w == "port") port = t[++i]
            else if (w == "app") app = t[++i]
            else if (w ~ /^[0-9]/ && port == "") { split(w, pp, "/"); port = pp[1]; if (pp[2] != "") proto = pp[2] }
            else if (w ~ /^[A-Za-z]/ && w != "route" && w != "insert" && app == "") app = w
          }
          a = (act == "allow" || act == "limit") ? "allow" : "block"
          remote = (dir == "out") ? to : from
          name = (c != "") ? c : (app != "" ? app : "")
          printf "R\t%s\t%s\t1\t%s\t%s\t%s\t%s\t\t%s\t\t\t%s\tlocal\t%s\n", id, name, dir, a, proto, (port == "" ? (app != "" ? app : "any") : port), remote, act, s }'
    done
    ;;
  firewalld)
    zone="$(firewall-cmd --get-default-zone 2>/dev/null)"
    target="$(firewall-cmd --permanent --zone="$zone" --get-target 2>/dev/null)"
    printf 'F\tfirewalld zone %s\t1\t%s\taccept\n' "$zone" "${target:-default}"
    for s in $(firewall-cmd --zone="$zone" --list-services 2>/dev/null); do
      printf 'R\tservice:%s\t%s\t1\tin\tallow\tany\t%s\t\tany\t\t\tservice\tlocal\tfirewalld service\n' "$s" "$s" "$s"
    done
    for p in $(firewall-cmd --zone="$zone" --list-ports 2>/dev/null); do
      printf 'R\tport:%s\t%s\t1\tin\tallow\t%s\t%s\t\tany\t\t\tport\tlocal\t\n' "$p" "$p" "${p#*/}" "${p%/*}"
    done
    firewall-cmd --zone="$zone" --list-rich-rules 2>/dev/null | while IFS= read -r r; do
      [ -n "$r" ] || continue
      addr="$(printf '%s' "$r" | sed -n 's/.*source address="\([^"]*\)".*/\1/p')"
      port="$(printf '%s' "$r" | sed -n 's/.* port port="\([^"]*\)".*/\1/p')"
      proto="$(printf '%s' "$r" | sed -n 's/.* protocol="\([^"]*\)".*/\1/p')"
      [ -z "$proto" ] && proto="$(printf '%s' "$r" | sed -n 's/.*protocol value="\([^"]*\)".*/\1/p')"
      act=allow; case "$r" in *" drop"*|*" reject"*) act=block ;; esac
      printf 'R\trich:%s\t%s\t1\tin\t%s\t%s\t%s\t\t%s\t\t\trich rule\tlocal\t%s\n' "$(clean "$r")" "rich rule" "$act" "${proto:-any}" "${port:-any}" "${addr:-any}" "$(clean "$r")"
    done
    ;;
  nftables)
    printf 'F\tnftables\t1\t\t\n'
    nft list ruleset 2>/dev/null | grep -E '^\s+(ip|ip6|tcp|udp|iif|oif|ct|meta|accept|drop|reject|counter)' | head -n 500 | nl -ba | while IFS=$'\t' read -r n r; do
      printf 'R\tnft:%s\t%s\t1\tin\t%s\tany\tany\t\tany\t\t\t\treadonly\t%s\n' "$(echo $n)" "$(clean "$(echo $r)")" "$(case "$r" in *drop*|*reject*) echo block ;; *) echo allow ;; esac)" "$(clean "$r")"
    done
    ;;
  iptables)
    printf 'F\tiptables\t1\t%s\t%s\n' "$(iptables -S INPUT 2>/dev/null | awk '/^-P/{print $3}')" "$(iptables -S OUTPUT 2>/dev/null | awk '/^-P/{print $3}')"
    iptables -S 2>/dev/null | grep '^-A' | head -n 500 | nl -ba | while IFS=$'\t' read -r n r; do
      dir=in; case "$r" in "-A OUTPUT"*) dir=out ;; esac
      act=allow; case "$r" in *"-j DROP"*|*"-j REJECT"*) act=block ;; esac
      printf 'R\tipt:%s\t%s\t1\t%s\t%s\tany\tany\t\tany\t\t\t\treadonly\t%s\n' "$(echo $n)" "$(clean "$r")" "$dir" "$act" "$(clean "$r")"
    done
    ;;
  *) printf 'F\tnone\t0\t\t\n' ;;
esac
