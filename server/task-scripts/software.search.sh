# HostPilot task: search available packages
# Output: P\t<package>\t<description>\t<version>
#__ARGS__
#__INCLUDE:_pm.sh__
q="$A_query"
case "$pm" in
  apt-get) apt-cache search -- "$q" 2>/dev/null | head -n 60 | awk -F' - ' '{ printf "P\t%s\t%s\t\n", $1, $2 }' ;;
  dnf|yum) "$pm" -q search "$q" 2>/dev/null | awk -F' : ' '/ : / { n = $1; sub(/\.[^.]+ *$/, "", n); gsub(/ +$/, "", n); printf "P\t%s\t%s\t\n", n, $2 }' | head -n 60 ;;
  zypper) zypper -q search "$q" 2>/dev/null | awk -F'|' 'NR > 2 { gsub(/^ +| +$/, "", $2); gsub(/^ +| +$/, "", $3); printf "P\t%s\t%s\t\n", $2, $3 }' | head -n 60 ;;
  apk) apk search -v "$q" 2>/dev/null | head -n 60 | awk '{ n = $1; printf "P\t%s\t%s\t\n", n, substr($0, length($1) + 4) }' ;;
  pacman) pacman -Ss "$q" 2>/dev/null | paste - - | head -n 60 | awk '{ split($1, a, "/"); printf "P\t%s\t%s\t%s\n", a[2], substr($0, index($0, "\t") + 1), $2 }' ;;
esac
exit 0
