# HostPilot task: printers (CUPS queues) and scanners (SANE) on Linux
# Output:
#   P\tname\tdriver\tport\tstatus\tconnected 0|1|-\tshared 0|1\tdefault 0|1\tlocation\tvirtual 0|1
#   H\tkind printer|scanner\tconnected 0|1\tname\tmanufacturer\tlast_arrival_unix\tinstance_id
#__ARGS__
clean() { printf '%s' "$1" | tr '\t\r\n' '   ' | sed 's/^ *//;s/ *$//'; }
if command -v lpstat >/dev/null 2>&1; then
  def="$(LC_ALL=C lpstat -d 2>/dev/null | sed -n 's/^system default destination: //p')"
  LC_ALL=C lpstat -v 2>/dev/null | sed -n 's/^device for \([^:]*\): \(.*\)$/\1\t\2/p' | while IFS=$'\t' read -r name uri; do
    st="$(LC_ALL=C lpstat -p "$name" 2>/dev/null | head -n 1)"
    case "$st" in *disabled*) status=Disabled; conn=0 ;; *idle*) status=Idle; conn=1 ;; *printing*) status=Printing; conn=1 ;; *) status="${st:-Unknown}"; conn=1 ;; esac
    # a USB printer that is unplugged makes CUPS report "waiting for printer to become available"
    if LC_ALL=C lpstat -l -p "$name" 2>/dev/null | grep -qiE 'not (connected|available)|waiting for printer|unplugged|offline'; then conn=0; status="$status (offline)"; fi
    virt=0; case "$uri" in cups-pdf:*|file:*|/dev/null) virt=1; conn=- ;; esac
    shared=0; LC_ALL=C lpoptions -p "$name" 2>/dev/null | grep -q 'printer-is-shared=true' && shared=1
    loc="$(LC_ALL=C lpoptions -p "$name" 2>/dev/null | sed -n "s/.*printer-location='\{0,1\}\([^' ]*\).*/\1/p")"
    drv="$(LC_ALL=C lpoptions -p "$name" 2>/dev/null | sed -n "s/.*printer-make-and-model='\([^']*\)'.*/\1/p")"
    isdef=0; [ "$name" = "$def" ] && isdef=1
    printf 'P\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(clean "$name")" "$(clean "$drv")" "$(clean "$uri")" "$(clean "$status")" "$conn" "$shared" "$isdef" "$(clean "$loc")" "$virt"
  done
else
  echo "NOTE	CUPS (lpstat) is not installed, so no printers are configured"
fi
# USB printers/scanners that are physically connected (USB interface class 07 = printer, 06 = still image)
for d in /sys/bus/usb/devices/*:*; do
  ic="$(cat "$d/bInterfaceClass" 2>/dev/null)"
  case "$ic" in 07) kind=printer ;; 06) kind=scanner ;; *) continue ;; esac
  dev="${d%:*}"
  printf 'H\t%s\t1\t%s\t%s\t\tusb/%s\n' "$kind" "$(clean "$(cat "$dev/product" 2>/dev/null)")" "$(clean "$(cat "$dev/manufacturer" 2>/dev/null)")" "${dev##*/}"
done | sort -u
if command -v scanimage >/dev/null 2>&1; then
  timeout 30 scanimage -L 2>/dev/null | sed -n "s/^device \`\([^']*\)' is a \(.*\)$/\1\t\2/p" | while IFS=$'\t' read -r id desc; do
    printf 'H\tscanner\t1\t%s\t\t\t%s\n' "$(clean "$desc")" "$(clean "$id")"
  done
fi
