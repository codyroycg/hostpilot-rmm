# HostPilot task: macOS Application Firewall status (read-only; macOS has no port rules to manage here)
#__ARGS__
fw=/usr/libexec/ApplicationFirewall/socketfilterfw
echo "B	macos"
on=0; $fw --getglobalstate 2>/dev/null | grep -qi enabled && on=1
stealth=$($fw --getstealthmode 2>/dev/null | grep -qi enabled && echo "stealth on" || echo "stealth off")
block=$($fw --getblockall 2>/dev/null | grep -qi enabled && echo "block all incoming" || echo "allow signed apps")
printf 'F\tApplication Firewall\t%s\t%s\t%s\n' "$on" "$block" "$stealth"
$fw --listapps 2>/dev/null | awk '/^ALF: total|^Total/ {next} /[0-9]+ :/ { app = $0; sub(/^[0-9]+ : */, "", app); getline st; allow = (st ~ /Allow/) ? "allow" : "block"; n = app; sub(/.*\//, "", n); printf "R\tapp:%s\t%s\t1\tin\t%s\tany\tany\t\tany\t%s\t\t\treadonly\t\n", app, n, allow, app }'
