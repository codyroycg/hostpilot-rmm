# HostPilot task: list pending macOS updates (softwareupdate)
# Output: U\t<label>\t<kb>\t<severity>\t<category>\t<bytes>\t<title>   and   R\t<reboot required 0|1>
#__ARGS__
softwareupdate -l 2>&1 | awk '
  /^[[:space:]]*\* Label: / { label = $0; sub(/.*\* Label: /, "", label); next }
  /^[[:space:]]*\* / && !label { label = $0; sub(/^[[:space:]]*\* /, "", label); next }
  /Title: / && label {
    line = $0; title = line; sub(/.*Title: /, "", title); sub(/, Version:.*/, "", title)
    ver = line; sub(/.*Version: /, "", ver); sub(/,.*/, "", ver)
    size = line; sub(/.*Size: /, "", size); sub(/[Kk].*/, "", size)
    rec = (line ~ /Recommended: YES/) ? "Important" : ""
    sev = (label ~ /[Ss]ecurity/ || title ~ /[Ss]ecurity/) ? "Security" : rec
    cat = (label ~ /macOS|Security Update/) ? "macOS" : "Apps"
    printf "U\t%s\t\t%s\t%s\t%.0f\t%s %s\n", label, sev, cat, size * 1024, title, ver
    label = "" }'
printf 'R\t0\n'
