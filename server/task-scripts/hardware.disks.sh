# HostPilot task: physical disks with SMART data (smartctl from smartmontools, if installed)
# Output: D\tid\tmake\tmodel\tserial\tsize\tmedia\tbus\thealth\ttemp_c\tpower_on_hours\twear_pct\treallocated\terrors\tvolumes\tfirmware\tnote
#__ARGS__
clean() { printf '%s' "$1" | tr '\t\r\n' '   ' | sed 's/^ *//;s/ *$//'; }
have_smart=0; command -v smartctl >/dev/null 2>&1 && have_smart=1
command -v lsblk >/dev/null 2>&1 || { echo "lsblk (util-linux) is required" >&2; exit 1; }

sysattr() { cat "/sys/block/$1/device/$2" 2>/dev/null | head -n 1; }
# columns without spaces only; text fields come from sysfs (no eval of device-provided strings)
lsblk -dnb -o NAME,TYPE,SIZE,ROTA,TRAN 2>/dev/null | while read -r NAME TYPE SIZE ROTA TRAN; do
  [ "$TYPE" = disk ] || continue
  MODEL="$(sysattr "$NAME" model)"; VENDOR="$(sysattr "$NAME" vendor)"
  SERIAL="$(sysattr "$NAME" serial)"; REV="$(sysattr "$NAME" rev)"; [ -z "$REV" ] && REV="$(sysattr "$NAME" firmware_rev)"
  case "$VENDOR" in ATA*) VENDOR="" ;; esac
  case "$NAME" in loop*|ram*|zram*|sr*|fd*) continue ;; esac
  dev="/dev/$NAME"
  media=""; [ "$ROTA" = 1 ] && media=HDD; [ "$ROTA" = 0 ] && media=SSD
  case "$NAME" in nvme*) media="NVMe SSD"; TRAN="${TRAN:-nvme}" ;; esac
  vols="$(lsblk -nlo MOUNTPOINT "$dev" 2>/dev/null | awk 'NF' | paste -sd' ' -)"
  health=Unknown; temp=""; poh=""; wear=""; realloc=""; errs=""; note=""
  if [ "$have_smart" = 1 ]; then
    out="$(smartctl -i -H -A "$dev" 2>/dev/null)"
    case "$out" in
      *"test result: PASSED"*|*"SMART Health Status: OK"*) health=OK ;;
      *"test result: FAILED"*) health=Failing; note="SMART reports the drive is failing. Back up and replace it." ;;
    esac
    [ -z "$SERIAL" ] && SERIAL="$(printf '%s\n' "$out" | awk -F': *' '/^Serial [Nn]umber:/{print $2; exit}')"
    [ -z "$MODEL" ] && MODEL="$(printf '%s\n' "$out" | awk -F': *' '/^(Device Model|Model Number|Product):/{print $2; exit}')"
    [ -z "$REV" ] && REV="$(printf '%s\n' "$out" | awk -F': *' '/^Firmware Version:/{print $2; exit}')"
    # NVMe
    temp="$(printf '%s\n' "$out" | awk '/^Temperature:/{print $2; exit}')"
    poh="$(printf '%s\n' "$out" | awk -F': *' '/^Power On Hours:/{gsub(/[^0-9]/,"",$2); print $2; exit}')"
    wear="$(printf '%s\n' "$out" | awk -F': *' '/^Percentage Used:/{gsub(/[^0-9]/,"",$2); print $2; exit}')"
    errs="$(printf '%s\n' "$out" | awk -F': *' '/^Media and Data Integrity Errors:/{gsub(/[^0-9]/,"",$2); print $2; exit}')"
    # ATA attribute table: ID NAME FLAG VALUE WORST THRESH TYPE UPDATED WHEN_FAILED RAW
    [ -z "$temp" ] && temp="$(printf '%s\n' "$out" | awk '$1==194 || $1==190 {print $10+0; exit}')"
    [ -z "$poh" ] && poh="$(printf '%s\n' "$out" | awk '$1==9 {print $10+0; exit}')"
    realloc="$(printf '%s\n' "$out" | awk '$1==5 {print $10+0; exit}')"
    [ -z "$wear" ] && wear="$(printf '%s\n' "$out" | awk '$1==177 || $1==233 || $1==231 || $1==202 {v=100-$4; if (v<0) v=0; print v; exit}')"
    [ -z "$errs" ] && errs="$(printf '%s\n' "$out" | awk '$1==187 || $1==198 {s+=$10} END{ if (s!="") print s+0 }')"
    if [ "$health" = OK ] && [ "${realloc:-0}" -gt 0 ] 2>/dev/null; then health=Warning; note="$realloc reallocated sectors"; fi
    [ -z "$out" ] && note="smartctl could not read this disk"
  else
    note="Install smartmontools for SMART data"
  fi
  printf 'D\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$NAME" "$(clean "$VENDOR")" "$(clean "$MODEL")" "$(clean "$SERIAL")" "$SIZE" "$media" "$(clean "$TRAN")" "$health" \
    "$temp" "$poh" "$wear" "$realloc" "$errs" "$(clean "$vols")" "$(clean "$REV")" "$note"
done
