# HostPilot task: physical disks with SMART status (macOS)
# Output: D\tid\tmake\tmodel\tserial\tsize\tmedia\tbus\thealth\ttemp_c\tpower_on_hours\twear_pct\treallocated\terrors\tvolumes\tfirmware\tnote
#__ARGS__
for d in $(diskutil list physical 2>/dev/null | awk '/^\/dev\/disk/ {print $1}'); do
  info=$(diskutil info "$d" 2>/dev/null)
  get() { printf '%s\n' "$info" | awk -F': *' -v k="$1" '$1 ~ "^ *" k "$" {sub(/^[^:]*: */, ""); print; exit}'; }
  model=$(get "Device / Media Name"); size=$(printf '%s\n' "$info" | sed -n 's/.*Disk Size:.*(\([0-9]*\) Bytes).*/\1/p' | head -n 1)
  ssd=$(get "Solid State"); proto=$(get "Protocol"); smart=$(get "SMART Status")
  media=HDD; [ "$ssd" = Yes ] && media=SSD; [ "$proto" = "PCI-Express" ] && [ "$ssd" = Yes ] && media="NVMe SSD"
  case "$smart" in Verified) health=OK ;; Failing) health=Failing ;; *) health=Unknown ;; esac
  vols=$(diskutil list "$d" 2>/dev/null | awk '/disk[0-9]+s[0-9]+$/ {print $NF}' | while read -r p; do diskutil info "$p" 2>/dev/null | awk -F': *' '/Mount Point/ && $2 != "" {print $2}'; done | paste -sd ' ' -)
  serial=$(system_profiler SPSerialATADataType SPNVMeDataType 2>/dev/null | awk -v m="$model" '$0 ~ m {f = 1} f && /Serial Number/ {print $3; exit}')
  note=""; [ "$health" = Unknown ] && note="SMART status: ${smart:-not reported} (external/USB disks often don't report SMART)"
  printf 'D\t%s\t\t%s\t%s\t%s\t%s\t%s\t%s\t\t\t\t\t\t%s\t\t%s\n' "${d#/dev/}" "$model" "$serial" "${size:-0}" "$media" "$proto" "$health" "$vols" "$note"
done
