#!/usr/bin/env bash
# HostPilot RMM - Linux agent installer
# Usage:  curl -fsSL '__SERVER_URL__/install/linux?token=__TOKEN__' | sudo bash
set -euo pipefail

SERVER='__SERVER_URL__'
TOKEN='__TOKEN__'
DIR=/opt/hostpilot
UNIT=/etc/systemd/system/hostpilot-agent.service

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root (pipe to 'sudo bash')." >&2; exit 1; fi
if ! command -v systemctl >/dev/null 2>&1; then echo "systemd is required." >&2; exit 1; fi
for c in curl base64 timeout sha256sum awk df; do
  command -v "$c" >/dev/null 2>&1 || { echo "Missing required command: $c" >&2; exit 1; }
done

echo "Installing HostPilot agent to $DIR"
systemctl stop hostpilot-agent >/dev/null 2>&1 || true
mkdir -p "$DIR"
chmod 700 "$DIR"
curl -fsSL "$SERVER/agent/linux.sh" -o "$DIR/agent.sh"
chmod 700 "$DIR/agent.sh"

existing_server=""
if [ -f "$DIR/config.env" ]; then existing_server="$(. "$DIR/config.env"; echo "${SERVER:-}")"; fi
if [ -f "$DIR/config.env" ] && [ "$existing_server" = "$SERVER" ]; then
  echo "Keeping existing device identity"
else
  host="$(hostname)"
  host="${host//\"/}"
  resp="$(curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"token\":\"$TOKEN\",\"hostname\":\"$host\",\"platform\":\"linux\"}" \
    "$SERVER/api/agent/enroll?format=text")"
  umask 077
  { printf "SERVER='%s'\n" "$SERVER"; printf '%s\n' "$resp"; } > "$DIR/config.env"
  chmod 600 "$DIR/config.env"
  echo "Enrolled: $(grep AGENT_ID "$DIR/config.env")"
fi

cat > "$UNIT" <<EOF
[Unit]
Description=HostPilot RMM agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env bash $DIR/agent.sh
Restart=always
RestartSec=5
User=root
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now hostpilot-agent >/dev/null 2>&1
systemctl restart hostpilot-agent
echo "HostPilot agent installed and running. It should appear in the console within a minute."
