# HostPilot task: rename a file or folder
#__ARGS__
target="$(dirname "$A_path")/$A_to"
[ -e "$target" ] && { echo "Already exists: $target" >&2; exit 1; }
mv -- "$A_path" "$target" && echo "Renamed to $A_to"
