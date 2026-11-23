# HostPilot task: USB devices, connected now (sysfs) or seen before (kernel log history)
# Output: U\tconnected 0|1\tname\tmanufacturer\tclass\tvid\tpid\tserial\thub 0|1\tlast_arrival_unix\tlast_removal_unix\tinstance_id
#__ARGS__
clean() { printf '%s' "$1" | tr '\t\r\n' '   ' | sed 's/^ *//;s/ *$//'; }
rd() { cat "$1" 2>/dev/null | head -n 1; }
seen=" "
for d in /sys/bus/usb/devices/*; do
  [ -r "$d/idVendor" ] || continue
  vid="$(rd "$d/idVendor")"; pid="$(rd "$d/idProduct")"
  cls="$(rd "$d/bDeviceClass")"
  case "${d##*/}" in usb*) continue ;; esac   # root hubs
  name="$(rd "$d/product")"; mfr="$(rd "$d/manufacturer")"; serial="$(rd "$d/serial")"
  if [ -z "$name" ] && command -v lsusb >/dev/null 2>&1; then
    name="$(lsusb -d "$vid:$pid" 2>/dev/null | head -n 1 | sed -E 's/^.*ID [0-9a-f]{4}:[0-9a-f]{4} ?//')"
  fi
  hub=0; [ "$cls" = 09 ] && hub=1
  case "$cls" in 00) cname="" ;; 01) cname=Audio ;; 02) cname=Communications ;; 03) cname=HID ;; 06) cname=Image ;; 07) cname=Printer ;;
    08) cname="Mass storage" ;; 09) cname=Hub ;; 0e) cname=Video ;; e0) cname=Wireless ;; ef) cname=Miscellaneous ;; ff) cname="Vendor specific" ;; *) cname="$cls" ;; esac
  if [ -z "$cname" ]; then
    # class is defined per interface: take the first interface's class
    ic="$(cat "$d"/*:*/bInterfaceClass 2>/dev/null | head -n 1)"
    case "$ic" in 01) cname=Audio ;; 02) cname=Communications ;; 03) cname=HID ;; 06) cname=Image ;; 07) cname=Printer ;; 08) cname="Mass storage" ;; 0e) cname=Video ;; e0) cname=Wireless ;; *) cname="" ;; esac
  fi
  seen="$seen$vid:$pid:$serial "
  printf 'U\t1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t\t\t%s\n' "$(clean "$name")" "$(clean "$mfr")" "$cname" "$vid" "$pid" "$(clean "$serial")" "$hub" "usb/${d##*/}"
done

# previously connected devices: "New USB device found" messages in the kernel log (all boots kept by journald, or kern.log)
{
  if command -v journalctl >/dev/null 2>&1; then journalctl -q _TRANSPORT=kernel -o short-unix --no-pager 2>/dev/null
  else zcat -f /var/log/kern.log* 2>/dev/null; fi
} | awk -v seen="$seen" '
  function flush(bus,   k) {
    if (!(bus in vid)) return
    k = vid[bus] ":" pid[bus] ":" ser[bus]
    if (index(seen, " " k " ") == 0 && !(k in done)) {
      done[k] = 1
      out[k] = sprintf("U\t0\t%s\t%s\t\t%s\t%s\t%s\t%d\t%s\t\tusb-history/%s", prod[bus], mf[bus], vid[bus], pid[bus], ser[bus], hub[bus], ts[bus], bus)
      last[k] = ts[bus]
    } else if (k in out && ts[bus] > last[k]) { last[k] = ts[bus] }
    delete vid[bus]
  }
  {
    t = $1; sub(/\..*/, "", t)
    if (match($0, /usb [0-9]+-[0-9.]+: /)) {
      bus = substr($0, RSTART + 4, RLENGTH - 6)
      msg = substr($0, RSTART + RLENGTH)
      if (msg ~ /^New USB device found/) {
        flush(bus)
        v = msg; sub(/.*idVendor=/, "", v); v = substr(v, 1, 4)
        p = msg; sub(/.*idProduct=/, "", p); p = substr(p, 1, 4)
        vid[bus] = v; pid[bus] = p; prod[bus] = ""; mf[bus] = ""; ser[bus] = ""; hub[bus] = 0; ts[bus] = t
      } else if (bus in vid) {
        if (msg ~ /^Product: /) { prod[bus] = substr(msg, 10); if (prod[bus] ~ /[Hh]ub/) hub[bus] = 1 }
        else if (msg ~ /^Manufacturer: /) mf[bus] = substr(msg, 15)
        else if (msg ~ /^SerialNumber: /) ser[bus] = substr(msg, 15)
      }
    }
  }
  END {
    for (b in vid) flush(b)
    for (k in out) { s = out[k]; n = split(s, f, "\t"); f[10] = last[k]; line = f[1]; for (i = 2; i <= n; i++) line = line "\t" f[i]; print line }
  }'
