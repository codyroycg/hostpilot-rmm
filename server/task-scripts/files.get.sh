# HostPilot task: send a file (or a tar.gz of a folder) from this device to the server
set -o pipefail
#__ARGS__
#__INCLUDE:_server.sh__
p="$A_path"
if [ -d "$p" ]; then
  tar -czf - -C "$(dirname "$p")" "$(basename "$p")" |
    curl -sS --fail -X PUT -H 'Content-Type: application/octet-stream' -H 'Expect:' -T - "$HP$A_url" || exit 1
  echo "Sent folder $p as tar.gz"
elif [ -f "$p" ]; then
  curl -sS --fail -H 'Content-Type: application/octet-stream' -H 'Expect:' -T "$p" "$HP$A_url" || exit 1
  echo "Sent $(wc -c < "$p" | tr -d ' ') bytes"
else
  echo "Not found: $p" >&2; exit 1
fi
