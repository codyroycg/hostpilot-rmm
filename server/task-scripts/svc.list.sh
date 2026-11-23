# HostPilot task: systemd services
# Output: S\tname\tdisplay\tstate\tstart\taccount\tpid\tdescription
#__ARGS__
command -v systemctl >/dev/null 2>&1 || { echo "This device does not use systemd" >&2; exit 1; }
declare -A EN
while read -r unit state _; do EN["$unit"]="$state"; done < <(systemctl list-unit-files --type=service --no-legend --plain 2>/dev/null)
systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | while read -r unit load active sub desc; do
  [ "$load" = not-found ] && continue
  case "$sub" in running) st=running ;; exited) st="exited" ;; dead) st=stopped ;; failed) st=failed ;; *) st="$sub" ;; esac
  en="${EN[$unit]:-static}"
  case "$en" in enabled) start=auto ;; disabled) start=manual ;; masked) start=disabled ;; *) start="$en" ;; esac
  pid=""; [ "$st" = running ] && pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null)
  printf 'S\t%s\t%s\t%s\t%s\t\t%s\t%s\n' "${unit%.service}" "$(printf '%s' "$desc" | tr '\t' ' ')" "$st" "$start" "$pid" "$(printf '%s' "$desc" | tr '\t' ' ')"
done
