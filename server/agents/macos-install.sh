#!/bin/bash
# HostPilot RMM - macOS agent installer (macOS 10.15 Catalina and later)
# Usage:  curl -fsSL '__SERVER_URL__/install/macos?token=__TOKEN__' | sudo bash
# The .pkg installer runs this same script as its postinstall step.
set -eu

SERVER='__SERVER_URL__'
TOKEN='__TOKEN__'
DIR=/Library/HostPilot
PLIST=/Library/LaunchDaemons/com.hostpilot.agent.plist
LABEL=com.hostpilot.agent

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root (pipe to 'sudo bash')." >&2; exit 1; fi
if [ "$(uname -s)" != Darwin ]; then echo "This installer is for macOS." >&2; exit 1; fi
for c in curl shasum awk df launchctl; do
  command -v "$c" >/dev/null 2>&1 || { echo "Missing required command: $c" >&2; exit 1; }
done

echo "Installing HostPilot agent to $DIR"
launchctl bootout system "$PLIST" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
mkdir -p "$DIR"
chown root:wheel "$DIR"
chmod 700 "$DIR"
curl -fsSL "$SERVER/agent/macos.sh" -o "$DIR/agent.sh"
chmod 700 "$DIR/agent.sh"

existing_server=""
if [ -f "$DIR/config.env" ]; then existing_server="$(. "$DIR/config.env"; echo "${SERVER:-}")"; fi
if [ -f "$DIR/config.env" ] && [ "$existing_server" = "$SERVER" ]; then
  echo "Keeping existing device identity"
else
  host="$(scutil --get ComputerName 2>/dev/null || hostname)"
  host="$(printf '%s' "$host" | tr -d '"\\')"
  resp="$(curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"token\":\"$TOKEN\",\"hostname\":\"$host\",\"platform\":\"macos\"}" \
    "$SERVER/api/agent/enroll?format=text")"
  umask 077
  { printf "SERVER='%s'\n" "$SERVER"; printf '%s\n' "$resp"; } > "$DIR/config.env"
  chmod 600 "$DIR/config.env"
  echo "Enrolled: $(grep AGENT_ID "$DIR/config.env")"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/agent.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$DIR/agent.err</string>
  <key>WorkingDirectory</key><string>/tmp</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"
chmod 644 "$PLIST"
launchctl bootstrap system "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true
echo "HostPilot agent installed and running. It should appear in the console within a minute."
echo "Tip: for full file and disk access, allow /bin/bash under System Preferences > Security & Privacy > Privacy > Full Disk Access."
