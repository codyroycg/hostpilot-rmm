# HostPilot task: download a file from the server onto this device
#__ARGS__
#__INCLUDE:_server.sh__
dest="$A_path"
dir="$(dirname "$dest")"
[ -d "$dir" ] || { echo "Folder does not exist: $dir" >&2; exit 1; }
curl -sS --fail -o "$dest.hpdownload" "$HP$A_url" || { rm -f "$dest.hpdownload"; exit 1; }
mv -f "$dest.hpdownload" "$dest"
echo "Saved $(wc -c < "$dest" | tr -d ' ') bytes to $dest"
