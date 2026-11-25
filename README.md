# HostPilot RMM

A self-hosted remote monitoring & management (RMM) platform for MSPs and IT teams. It runs as a single Docker container and manages Windows, Linux and macOS (10.15 Catalina and later) hosts through a lightweight agent.

### macOS

Install from the client page with the **macOS installer (.pkg)** (generated per client by the server, so no Mac is needed to build it), the downloadable `.sh`, or `curl -fsSL '<server>/install/macos?token=…' | sudo bash`. The package isn't signed with an Apple Developer ID, so the first time right-click it → **Open** (or System Preferences → Security & Privacy → **Open Anyway**); for silent deployment use `sudo installer -pkg HostPilot-Installer.pkg -target /`. The agent is plain bash 3.2 + curl under launchd (`/Library/LaunchDaemons/com.hostpilot.agent.plist`, files in `/Library/HostPilot`).

On macOS: monitoring (CPU, memory, disks, uptime, network), app inventory, Run command (bash/zsh/sh), Terminal, Files, Task manager (processes, launchd services), Updates (`softwareupdate`), Users (`sysadminctl`/`dscl`), Hardware (disks with SMART status, USB, printers), Application Firewall status, live performance, agent update/uninstall. Not on macOS: remote desktop, chat/tray icon, software install/uninstall, policies, network discovery (needs python3). For full file access grant `/bin/bash` **Full Disk Access** (System Preferences → Security & Privacy → Privacy).

Manual removal: `sudo launchctl bootout system/com.hostpilot.agent; sudo rm -rf /Library/HostPilot /Library/LaunchDaemons/com.hostpilot.agent.plist`

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
- **Linux terminal**: a full interactive root shell in the browser (xterm.js), so `top`, `vim`, `htop` and tab completion work. It needs only bash, curl, and util-linux `script` on the server.
- **File browser**: browse drives and folders, then upload (drag & drop), download (folders come as .zip / .tar.gz), rename, delete, or create folders.
- **OS patching**: scan for updates with Windows Update or apt/dnf/yum/zypper, then install all or selected updates with optional automatic reboot. The fleet **Patching** page shows pending, security, and reboot-required counts. Devices are scanned automatically every 24 h.
- **Software management**: uninstall or reinstall installed programs, and install new software with **winget** (Windows) or the package manager (Linux), on one device or in bulk.
- **Hardware**: disk make, model, serial, firmware and SMART health (temperature, power-on hours, life used, errors; Linux needs `smartmontools`), every USB device that is or ever was connected (Windows device history / Linux kernel log), and printers & scanners with their connection state. Drives under Utilization open straight into the file browser.
- **Background tools (no interruption for the user)**: interactive **PowerShell** and **Command Prompt** sessions on Windows (hidden, as SYSTEM) and a root terminal on Linux; **Task manager** (processes with live CPU/memory, end process or process tree; services with start/stop/restart and startup type); **Registry editor** (browse, create, edit and delete keys and values); file transfers in the Files tab.
- **Policies (configuration baselines)**: target device groups (clients, desktops/laptops/servers/VMs, platform, or a hand-picked list) with rules such as firewall on, Defender real-time protection, signatures current, BitLocker, SMBv1 off, guest disabled, password/lockout policy, screen lock, RDP/NLA, UAC, AutoRun, Windows Update, SSH hardening, automatic updates (Linux), service running/disabled, registry values, approved local admins and custom scripts. Report only, or **Enforce** to auto-fix drift. Compliance matrix per policy and per device.
- **Continuous monitoring**: CPU (including per-core), memory, disk, uptime and **watched services** (global per platform, per device, or from policy rules) with alerts when a service stops. Devices are classified as desktop, laptop, server or virtual machine.
- **Linux desktop tray icon**: on Linux machines with a graphical desktop (GNOME, KDE, Xfce, Cinnamon, MATE, …) the agent installs the same status icon as on Windows: connected / disconnected / not running / updating, **Update agent now**, and the IT support chat. It's a Python 3 + GTK 3 app (`/opt/hostpilot-tray/hostpilot-tray.py`, started for every user by `/etc/xdg/autostart/hostpilot-tray.desktop`) and needs `python3-gi`, which desktop distributions ship. On stock GNOME the icon needs the AppIndicator extension (enabled by default on Ubuntu). Servers without a desktop are skipped. Any user can also run `python3 /opt/hostpilot-tray/hostpilot-tray.py --update`.
- **Chat with end users**: technicians message the signed-in user from the device's Chat tab; the message pops up through the Windows taskbar icon and the user can reply or start a chat from the icon's menu. Unread messages show under **Messages**.
- **Network discovery & topology**: pick any HostPilot device as the probe for a subnet. It finds every device (ping + ARP), reads MAC vendor, DNS/NetBIOS names, open ports, SNMP, web page titles and UPnP descriptions, and classifies routers, firewalls, switches, access points, servers, workstations, printers, cameras, NAS, VoIP, phones, media devices and IoT. Shows a topology map (internet → ISP → gateway → infrastructure → LAN) and a device list, with scheduled rescans and manual type overrides. Private ranges only, up to /20. Links on the map are inferred, not read from switch port tables (LLDP/CDP isn't used yet).
- **Firewall**: list, search, create, edit, enable/disable and delete rules. Windows Defender Firewall on Windows (Group Policy rules are read-only); ufw or firewalld on Linux (plain iptables/nftables are shown read-only).
- **Mobile friendly**: the console works on phones. Tables become cards, dialogs go full screen, and remote control works like a touchpad on phones (slide to move the pointer, tap to click, double-tap and slide to drag, long-press or two-finger tap to right-click, two fingers to scroll, pinch to zoom, on-screen keyboard), or in "tap where you touch" mode. The Linux terminal gets an Esc/Tab/Ctrl/arrow key bar.
- **Local user management**: create, delete, enable/disable, reset passwords, and grant or remove admin on device accounts. Passwords are masked in job history.
- **Installer downloads**: a pre-configured **HostPilot-Setup.exe** (double-click, approve UAC, done; `/quiet` for GPO/Intune) and a `.sh` for Linux. There's a shareable link per client to email to customers.
- **Remote command console**: run PowerShell, cmd, bash, sh, or python on a device and see the output within a few seconds.
- **Script library**: 19 starter scripts (patching, cleanup, Defender, event logs, failed units, Docker, and more). You can edit them or add your own.
- **Bulk jobs**: run a script on many devices at once and track per-device results. Offline devices get queued jobs when they reconnect.
- **Automation**: run a library script on a schedule against all devices, a platform, a client, or a single device.
- **Alerting**: CPU, memory, and disk thresholds plus offline detection, with auto-resolve, acknowledge, maintenance mode, and webhook notifications (Slack, Discord, Teams, ntfy…).
- **Fleet software search**: for example, "which machines have OpenSSL 1.1?"
- **Users & roles**: `admin`, `tech` (can run scripts), and `viewer` (read-only). Includes a full audit log.
- **Agent self-update**: change an agent script on the server and every agent updates itself on its next poll. You can also force an update from the web console (device **Settings → Update agent now**, or **More actions → Update HostPilot agent now** for many devices) or from the device itself (see below).
- **Windows taskbar icon**: logged-in users see a HostPilot icon showing whether the agent is connected (green), disconnected (red), not running (grey) or updating (blue). Its menu has **Update agent now**. Turn it off under **Settings → Windows taskbar icon**.
- **Agent uninstall** from the console.
- **Android app for technicians**: the full console in an app (Android 8+), with push-style notifications for new alerts and end-user chat messages, file downloads to the phone's Downloads folder, and uploads from the phone. See [Android app](#android-app).

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

### Device tasks (files, updates, software, users)

These features are server-side PowerShell/bash templates in `server/task-scripts/`. They're filled with arguments (base64-encoded, so filenames and passwords can't break out of the script) and run through the normal job queue. Edit a template and redeploy to change behaviour; no agent update is needed. Every action is recorded in the audit log, and the executed script is visible in Script history with secrets masked.

File transfers go through the server. The device PUTs a file to a one-time URL and the browser downloads it, or the other way round. Files are staged in `/data/transfers` for at most 2 hours, with a 4 GB limit per file.

### Linux terminal

The agent runs `script -qfc "bash -l"` to get a real pseudo-terminal. Keystrokes arrive over one long-lived HTTPS GET, and output is sent back in small POST batches. This works through proxies that buffer request bodies, such as Nginx Proxy Manager. Your reverse proxy must **not buffer responses**: the server sends `X-Accel-Buffering: no`, which nginx respects, and Caddy streams by default.

### Windows Setup.exe

`server/agents/HostPilotSetup.exe` is a small, generic .NET Framework 4 program built from `setup/HostPilotSetup.cs`. When someone downloads it, the server appends that client's server URL and enrollment token to the file, so the same binary serves every client. Rebuild it on any Windows machine with `powershell -File setup\build.ps1`; it uses the C# compiler that ships with Windows. It isn't code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time. To remove the warning, sign it with your own code-signing certificate (`signtool sign`). Appending data to a signed exe can break signature validation on strictly configured machines (for example with `EnableCertPaddingCheck`). If you sign, test it, or sign each downloaded per-client exe instead of the stub.

### Taskbar icon and updating from the device

On Windows, the agent installs `C:\Program Files\HostPilot\HostPilotTray.exe` and a logon task (`HostPilotTray`, group *Users*) so the icon starts in every user's session. The agent (SYSTEM) publishes its state in `HKLM\SOFTWARE\HostPilot`, which the icon reads. **Update agent now** signals the event `Global\HostPilotUpdateNow`. Any signed-in user may signal it, but it only makes the agent re-download itself from your server. The tray app is built from `setup/HostPilotTray.cs` by `setup\build.ps1`.

Force an update on the device:

| | Command |
|---|---|
| Windows, any user | `"C:\Program Files\HostPilot\HostPilotTray.exe" /update`, or right-click the tray icon → **Update agent now** |
| Windows, elevated | `powershell -ExecutionPolicy Bypass -File C:\ProgramData\HostPilot\agent.ps1 -Update` |
| Linux | `sudo /opt/hostpilot/agent.sh --update` (and `--status` to check the connection) |

The agent picks the request up within about 30 seconds, downloads the latest version from the server, and restarts.

### Files on the endpoints

| | Windows | Linux |
|---|---|---|
| Install dir | `C:\ProgramData\HostPilot` (SYSTEM + Administrators only) | `/opt/hostpilot` (root, 0700) |
| Service | Scheduled task `HostPilotAgent` → `runner.ps1` → `agent.ps1` | `hostpilot-agent.service` |
| Tray icon | `C:\Program Files\HostPilot\HostPilotTray.exe`, task `HostPilotTray` | — |
| Log | `agent.log` | `agent.log` |

Manual removal (if the server is gone):

```powershell
Unregister-ScheduledTask HostPilotAgent -Confirm:$false; Unregister-ScheduledTask HostPilotTray -Confirm:$false -ErrorAction SilentlyContinue; Get-Process HostPilotTray -ErrorAction SilentlyContinue | Stop-Process -Force; Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ? CommandLine -like '*HostPilot*' | Invoke-CimMethod -MethodName Terminate; Remove-Item C:\ProgramData\HostPilot, 'C:\Program Files\HostPilot', HKLM:\SOFTWARE\HostPilot -Recurse -Force -ErrorAction SilentlyContinue
```
```bash
sudo systemctl disable --now hostpilot-agent; sudo rm -rf /opt/hostpilot /etc/systemd/system/hostpilot-agent.service; sudo systemctl daemon-reload
```

## Android app

The `android/` folder is a small native app (Java, no third-party libraries). It shows the console in a WebView and adds:

- **Notifications** for new alerts and for chat messages from end users. Tapping one opens that device or conversation. After you sign in, the phone registers itself (`POST /api/mobile/register`) and gets a token that can only read the notification feed. It's revoked when you sign out, change server, or an admin resets your password.
  - By default the phone checks about every 15 minutes (Android stretches this while the phone sleeps).
  - **Instant notifications** (in **Phone app settings** in the console menu) checks every minute and keeps a small notification in the status bar.
- **Downloads** from the Files tab go to the phone's Downloads folder. **Uploads** use the phone's file picker.
- Links to other sites, such as a device's web interface, open in the phone's browser.

The server needs a certificate the phone trusts. A public domain behind Caddy gets one automatically. Plain `http://` on a LAN also works.

### Building the APK

GitHub Actions builds it (`.github/workflows/android.yml`) whenever something under `android/` changes, or when you run the workflow by hand (**Actions → Android app → Run workflow**).

- The APK is attached to the run and published as the **android-latest** release: `https://github.com/<owner>/<repo>/releases/download/android-latest/HostPilot.apk`.
- If the repository is private, you must be signed in to GitHub to download it.

To install it, open that link on the phone, allow "install unknown apps" for the browser, then enter your server address (for example `https://rmm.example.com`).

To keep updates installing over the old version, every build has to be signed with the same key. Create one once with `keytool`, which comes with any JDK:

```powershell
keytool -genkeypair -keystore hostpilot-release.jks -storetype PKCS12 -alias hostpilot -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=HostPilot RMM"
[Convert]::ToBase64String([IO.File]::ReadAllBytes("hostpilot-release.jks")) | Set-Clipboard
```

Then add these repository secrets under **Settings → Secrets and variables → Actions**:

- `ANDROID_KEYSTORE_BASE64`: the clipboard contents
- `ANDROID_KEYSTORE_PASSWORD`: the keystore password
- `ANDROID_KEY_ALIAS`: `hostpilot`

Keep the `.jks` file and its password safe, and don't commit them; `.gitignore` already excludes `*.jks`. Without the secrets, builds are signed with a throw-away debug key, so you have to uninstall the app before installing each new build.

To build locally instead, open `android/` in Android Studio.

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

Remote desktop for Linux *desktops* (X11/Wayland), major OS version upgrades (e.g. Windows 10 → 11, Ubuntu release upgrades), and PSA/ticketing or billing aren't included. Alerts can feed your helpdesk through the webhook.
