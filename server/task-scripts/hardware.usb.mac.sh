# HostPilot task: connected USB devices (macOS; macOS keeps no history of disconnected devices)
# Output: U\tconnected\tname\tmanufacturer\tclass\tvid\tpid\tserial\thub\tlast_arrival\tlast_removal\tid
#__ARGS__
system_profiler SPUSBDataType 2>/dev/null | awk '
  function flush() { if (name != "" && vid != "") printf "U\t1\t%s\t%s\t\t%s\t%s\t%s\t%d\t\t\tusb/%s\n", name, mfr, vid, pid, ser, hub, loc; name = ""; vid = ""; pid = ""; ser = ""; mfr = ""; hub = 0; loc = "" }
  /^ +[^ ].*:$/ && !/^ +(USB|Host Controller)/ { line = $0; sub(/^ +/, "", line); sub(/:$/, "", line); if (line !~ /^(Product ID|Vendor ID|Version|Speed|Location ID|Serial Number|Manufacturer|Current|Extra|Built-In|Media|BSD|Capacity|Removable|Detachable|Partition|File System|Writable|Mount|Volume|Content|S\.M\.A\.R\.T)/) { flush(); name = line; if (name ~ /[Hh]ub/) hub = 1 } }
  /Product ID:/ { pid = $3; sub(/^0x/, "", pid) }
  /Vendor ID:/ { vid = $3; sub(/^0x/, "", vid); m = $0; if (sub(/.*\(/, "", m)) { sub(/\).*/, "", m); mfr = m } }
  /Serial Number:/ { ser = $3 }
  /Manufacturer:/ { m = $0; sub(/.*Manufacturer: /, "", m); mfr = m }
  /Location ID:/ { loc = $3 }
  END { flush() }'
