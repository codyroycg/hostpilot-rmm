# HostPilot task: launchd services in the system domain (macOS)
# Output: S\tname(label)\tdisplay\tstate\tstart\taccount\tpid\tdescription
#__ARGS__
disabled=" $(launchctl print-disabled system 2>/dev/null | awk -F'"' '/=> true/ {printf "%s ", $2}')"
launchctl list | awk 'NR > 1' | while IFS=$'\t' read -r pid status label; do
  case "$label" in com.apple.*) origin=Apple ;; *) origin=Third-party ;; esac
  if [ "$pid" != "-" ]; then st=running; elif [ "$status" != 0 ] && [ "$status" != "-" ]; then st="stopped (exit $status)"; else st=stopped; fi
  start=auto; case "$disabled" in *" $label "*) start=disabled ;; esac
  printf 'S\t%s\t%s\t%s\t%s\troot\t%s\t%s\n' "$label" "$label" "$st" "$start" "${pid#-}" "$origin"
done
