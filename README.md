# HostPilot RMM

A self-hosted remote monitoring & management (RMM) platform for MSPs and IT teams. It runs as a single Docker container and manages Windows and Linux hosts through a lightweight agent.

| | |
|---|---|
| **Server** | Node.js 22+, zero npm dependencies, built-in SQLite (`node:sqlite`) |
| **Windows agent** | Plain PowerShell 5.1 script, runs as SYSTEM via a scheduled task |
| **Linux agent** | Plain bash + curl, runs as root via systemd |
| **Transport** | Agents make outbound HTTPS requests only (long-polling), so hosts need no inbound ports |

## Features

- **Clients & enrollment**: group devices by client, and generate expiring enrollment tokens with one-line install commands for Windows and Linux.
- **Device inventory**: OS/build, hardware, serial, CPU, RAM, disks, IPs (local and public), logged-in user, uptime, and installed software (registry / dpkg / rpm / apk / pacman).
- **Live monitoring**: CPU, memory, and disk utilisation, with 1h/24h/7d charts and online/offline status.
- **Remote control (Windows)**: view and control the screen in a browser tab, with no app to install on either side. It follows UAC prompts and the login screen, sends only changed regions, and has quality presets, special-key combos (Win, Alt+Tab, Ctrl+Shift+Esc…) and "type text" for pasting passwords.
- **Remote command console**: run PowerShell, cmd, bash, sh, or python on a device and see the output within a few seconds.
- **Script library**: 19 starter scripts (patching, cleanup, Defender, event logs, failed units, Docker, and more). You can edit them or add your own.
- **Bulk jobs**: run a script on many devices at once and track per-device results. Offline devices get queued jobs when they reconnect.
- **Automation**: run a library script on a schedule against all devices, a platform, a client, or a single device.
- **Alerting**: CPU, memory, and disk thresholds plus offline detection, with auto-resolve, acknowledge, maintenance mode, and webhook notifications (Slack, Discord, Teams, ntfy…).
- **Fleet software search**: for example, "which machines have OpenSSL 1.1?"
- **Users & roles**: `admin`, `tech` (can run scripts), and `viewer` (read-only). Includes a full audit log.
- **Agent self-update**: change an agent script on the server and every agent updates itself on its next poll.
- **Agent uninstall** from the console.

## Quick start

```bash
cp .env.example .env          # set ADMIN_PASSWORD (or read the generated one from the logs)
docker compose up -d --build
docker compose logs hostpilot # shows the admin password if you didn't set one
```

Open `http://<server>:8080`, sign in, then:

1. **Clients → New client**
2. On the client page, copy the install command:
   - **Windows** (elevated PowerShell): `irm 'https://rmm.example.com/install/windows?token=…' | iex`
   - **Linux** (root): `curl -fsSL 'https://rmm.example.com/install/linux?token=…' | sudo bash`
3. The device appears under **Devices** within about a minute.

### Production: HTTPS

Agents run commands as SYSTEM/root, so **anyone who controls the server controls every enrolled host**. Do not expose it over plain HTTP on the internet.

The bundled Caddy profile gets a Let's Encrypt certificate automatically:

```bash
# .env
DOMAIN=rmm.yourcompany.com
PUBLIC_URL=https://rmm.yourcompany.com
```
```bash
docker compose --profile https up -d --build
```

Point the DNS A record at the server, open ports 80/443, and remove the `8080` port mapping from `docker-compose.yml` once HTTPS works. You can use your own reverse proxy (Traefik, nginx, Cloudflare Tunnel…) instead. Allow ≥ 60 s read timeouts, because agents long-poll.

Recommended hardening:
- Use strong admin passwords and give technicians the `tech` role, not `admin`.
- Restrict the web UI by IP or VPN at the proxy if you can. Agents only need `/agent/*`, `/install/*`, and `/api/agent/*`.
- Use short-lived enrollment tokens (1–30 days) and revoke them after rollout.
- Back up the `hostpilot-data` volume (a single SQLite file: `/data/hostpilot.db`).

## How it works

```
 ┌──────────────┐   HTTPS (outbound only)   ┌───────────────────────────┐
 │ Windows host │──── checkin / long-poll ─▶│  HostPilot server (Docker) │◀── browser (web console)
 │ agent.ps1    │◀─── jobs ────────────────│  Node.js + SQLite /data    │
 └──────────────┘                           └───────────────────────────┘
 ┌──────────────┐                                       ▲
 │ Linux host   │───────────────────────────────────────┘
 │ agent.sh     │
 └──────────────┘
```

- **Enroll**: the installer trades the client's enrollment token for a per-device ID and secret. Only a SHA-256 hash of the secret is stored on the server.
- **Check-in** (default every 60 s): metrics, hardware, and OS info. Software inventory is sent every 12 h or on demand.
- **Long-poll**: each agent keeps a request open for up to 25 s. A queued job is handed over immediately, so commands start within about a second.
- **Jobs**: each job runs in its own process with a timeout. stdout and stderr (up to 1 MB each) and the exit code are sent back.

### Remote control

Click **Remote control** on a Windows device (tech or admin role). Here's what happens:

1. The server creates a one-time session and queues a `_remote` job for the agent.
2. The agent downloads `remote.ps1` and starts it **as SYSTEM inside the active console session**. It uses the same technique as commercial RMM tools, which is why the login screen and UAC prompts are visible and clickable.
3. The helper opens an outbound WebSocket to `/ws/remote`. It captures the screen, compares 64×64 tiles against the previous frame, and sends only the changed regions as JPEG. Flow control limits it to 2 un-acknowledged frames in flight, so it adapts to slow links.
4. The browser draws the tiles on a canvas and sends mouse and keyboard events back. The helper injects them with `SendInput`.

The session ends when either side disconnects. The helper exits and `remote.start` / `remote.end` are recorded in the audit log. Typical bandwidth is 30–150 KB/s while the screen is changing and close to zero while it's idle.

Limitations:
- It controls the **console** session (the physical screen), not separate RDP sessions.
- **Ctrl+Alt+Del** isn't sent. Windows 10/11 lock screens don't need it.
- There's no clipboard sync. Use **Type text…** instead.
- The logged-in user is **not shown a notification** that someone is connected. Tell your clients this is part of your service agreement.
- Linux desktops aren't supported. Linux servers are managed through the Run command console.

If you use your own reverse proxy, make sure it forwards WebSocket upgrades for `/ws/remote`. Caddy does this automatically.

### Files on the endpoints

| | Windows | Linux |
|---|---|---|
| Install dir | `C:\ProgramData\HostPilot` (SYSTEM + Administrators only) | `/opt/hostpilot` (root, 0700) |
| Service | Scheduled task `HostPilotAgent` → `runner.ps1` → `agent.ps1` | `hostpilot-agent.service` |
| Log | `agent.log` | `agent.log` |

Manual removal (if the server is gone):

```powershell
Unregister-ScheduledTask HostPilotAgent -Confirm:$false; Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ? CommandLine -like '*HostPilot*' | Invoke-CimMethod -MethodName Terminate; Remove-Item C:\ProgramData\HostPilot -Recurse -Force
```
```bash
sudo systemctl disable --now hostpilot-agent; sudo rm -rf /opt/hostpilot /etc/systemd/system/hostpilot-agent.service; sudo systemctl daemon-reload
```

## Configuration

Set environment variables in `.env`:

| Variable | Default | |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / random | First-run admin only |
| `PUBLIC_URL` | from request | URL embedded in install commands |
| `PORT` | `8080` | |
| `DATA_DIR` | `/data` | SQLite location |
| `TRUST_PROXY` | `true` | Honour `X-Forwarded-For` for client IPs |

Thresholds, check-in interval, retention, and the webhook URL are under **Settings** in the UI.

## Scale notes

A single container with SQLite in WAL mode comfortably handles hundreds to a few thousand agents at the default 60 s check-in. For larger fleets, raise the check-in interval and put the data volume on SSD.

## Running without Docker

```bash
cd server
node --version   # 22.13+ required
ADMIN_PASSWORD='change-me-please' npm start
```

## Not included (yet)

Remote desktop for Linux desktops, file transfer, and PSA/ticketing or billing aren't included. Alerts can feed your helpdesk through the webhook.
