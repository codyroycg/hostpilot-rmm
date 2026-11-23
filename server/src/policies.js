// Configuration baselines / security policies: a policy targets a group of devices and holds rules.
// Each rule has a check (and usually a fix) per platform. A device runs all rules of a policy in one job
// and prints one line per rule:  P \t <rule key> \t pass|fail|fixed|error|na \t <detail>
import { all, get, run, tx } from './db.js';
import { HttpError } from './util.js';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// ---------- rule library ----------
// param types: text, number, select (options), textarea
// win.check / linux.check must set the result: PowerShell returns @{ ok = <bool>; detail = '...' }; bash sets OK=1|0 and DETAIL=...
// a check may throw (PowerShell) / set NA=1 (bash) when the rule doesn't apply on that device
export const RULES = {
  firewall_on: {
    title: 'Firewall enabled', category: 'Security', platforms: ['windows', 'linux'],
    description: 'Windows Defender Firewall on for every profile; ufw or firewalld active on Linux.',
    win: {
      check: `$off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled } | ForEach-Object Name)
@{ ok = ($off.Count -eq 0); detail = $(if ($off.Count) { "Off for: $($off -join ', ')" } else { 'On for all profiles' }) }`,
      fix: 'Set-NetFirewallProfile -All -Enabled True',
    },
    linux: {
      check: `if command -v ufw >/dev/null 2>&1 && LC_ALL=C ufw status | grep -q '^Status: active'; then OK=1; DETAIL="ufw active"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then OK=1; DETAIL="firewalld running"
else OK=0; DETAIL="No active firewall (ufw/firewalld)"; fi`,
      fix: `if command -v ufw >/dev/null 2>&1; then ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null; ufw --force enable >/dev/null
elif command -v firewall-cmd >/dev/null 2>&1; then systemctl enable --now firewalld >/dev/null 2>&1; fi`,
    },
  },
  defender_rtp: {
    title: 'Microsoft Defender real-time protection on', category: 'Security', platforms: ['windows'],
    description: 'Antivirus and real-time protection enabled. Reported as not applicable when another antivirus product replaces Defender.',
    win: {
      check: `try { $s = Get-MpComputerStatus } catch { throw 'NA: Microsoft Defender is not available (third-party antivirus?)' }
if (-not $s.AntivirusEnabled -and $s.AMRunningMode -match 'Passive|Not running') { throw "NA: Defender is in $($s.AMRunningMode) mode (another antivirus is active)" }
@{ ok = [bool]($s.AntivirusEnabled -and $s.RealTimeProtectionEnabled); detail = "Antivirus: $($s.AntivirusEnabled), real-time: $($s.RealTimeProtectionEnabled)" }`,
      fix: 'Set-MpPreference -DisableRealtimeMonitoring $false',
    },
  },
  defender_signatures: {
    title: 'Antivirus signatures up to date', category: 'Security', platforms: ['windows'],
    params: [{ key: 'days', label: 'Maximum age (days)', type: 'number', default: 3 }],
    win: {
      check: `try { $s = Get-MpComputerStatus } catch { throw 'NA: Microsoft Defender is not available' }
@{ ok = ($s.AntivirusSignatureAge -le [int]$p.days); detail = "Signatures are $($s.AntivirusSignatureAge) day(s) old" }`,
      fix: 'Update-MpSignature',
    },
  },
  bitlocker_os: {
    title: 'BitLocker on the system drive', category: 'Security', platforms: ['windows'],
    description: 'Report only. Turning on BitLocker needs recovery-key planning, so it is never enabled automatically.',
    win: {
      check: `try { $v = Get-BitLockerVolume -MountPoint $env:SystemDrive } catch { throw 'NA: BitLocker is not available on this edition' }
@{ ok = ([string]$v.ProtectionStatus -eq 'On'); detail = "Protection $($v.ProtectionStatus), $($v.VolumeStatus), $($v.EncryptionPercentage)% encrypted" }`,
    },
  },
  smb1_off: {
    title: 'SMBv1 disabled', category: 'Security', platforms: ['windows'],
    win: {
      check: `$c = Get-SmbServerConfiguration
@{ ok = (-not $c.EnableSMB1Protocol); detail = "SMBv1 server enabled: $($c.EnableSMB1Protocol)" }`,
      fix: 'Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force',
    },
  },
  guest_disabled: {
    title: 'Guest account disabled', category: 'Accounts', platforms: ['windows'],
    win: {
      check: `$g = Get-LocalUser | Where-Object { $_.SID.Value -like '*-501' } | Select-Object -First 1
if (-not $g) { throw 'NA: no Guest account' }
@{ ok = (-not $g.Enabled); detail = "$($g.Name) enabled: $($g.Enabled)" }`,
      fix: `Get-LocalUser | Where-Object { $_.SID.Value -like '*-501' } | Disable-LocalUser`,
    },
  },
  password_policy: {
    title: 'Password and lockout policy', category: 'Accounts', platforms: ['windows', 'linux'],
    params: [{ key: 'min_length', label: 'Minimum password length', type: 'number', default: 12 },
      { key: 'lockout', label: 'Lock out after failed attempts (Windows, 0 = off)', type: 'number', default: 10 }],
    win: {
      check: `$t = net accounts
$len = [int](($t | Select-String 'Minimum password length').ToString() -replace '\\D', '')
$lk = ($t | Select-String 'Lockout threshold').ToString() -replace '.*:\\s*', ''
$lkN = if ($lk -match '^\\d+$') { [int]$lk } else { 0 }
$okLk = ([int]$p.lockout -eq 0) -or ($lkN -gt 0 -and $lkN -le [int]$p.lockout)
@{ ok = ($len -ge [int]$p.min_length -and $okLk); detail = "Min length $len, lockout threshold $lk" }`,
      fix: `net accounts /minpwlen:$([int]$p.min_length) | Out-Null
if ([int]$p.lockout -gt 0) { net accounts /lockoutthreshold:$([int]$p.lockout) | Out-Null }`,
    },
    linux: {
      check: `cur="$(sed -n 's/^[[:space:]]*minlen[[:space:]]*=[[:space:]]*\\([0-9]*\\).*/\\1/p' /etc/security/pwquality.conf 2>/dev/null | tail -n 1)"
if [ ! -f /etc/security/pwquality.conf ]; then NA=1; DETAIL="pwquality is not installed"; else
  if [ "\${cur:-0}" -ge "$P_min_length" ]; then OK=1; else OK=0; fi; DETAIL="minlen \${cur:-not set}"; fi`,
      fix: `sed -i '/^[[:space:]]*minlen[[:space:]]*=/d' /etc/security/pwquality.conf; echo "minlen = $P_min_length" >> /etc/security/pwquality.conf`,
    },
  },
  screen_lock: {
    title: 'Screen locks after inactivity', category: 'Accounts', platforms: ['windows'],
    params: [{ key: 'minutes', label: 'Lock after (minutes)', type: 'number', default: 15 }],
    win: {
      check: `$v = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue).InactivityTimeoutSecs
@{ ok = ($v -and [int]$v -gt 0 -and [int]$v -le [int]$p.minutes * 60); detail = $(if ($v) { "Locks after $([int]$v / 60) min" } else { 'No inactivity lock set' }) }`,
      fix: `Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name InactivityTimeoutSecs -Value ([int]$p.minutes * 60) -Type DWord`,
    },
  },
  rdp_policy: {
    title: 'Remote Desktop', category: 'Remote access', platforms: ['windows'],
    params: [{ key: 'mode', label: 'Required state', type: 'select', options: [['nla', 'Allowed with Network Level Authentication'], ['disabled', 'Disabled']], default: 'nla' }],
    win: {
      check: `$ts = Get-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server'
$nla = (Get-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp').UserAuthentication
$on = ($ts.fDenyTSConnections -eq 0)
if ($p.mode -eq 'disabled') { @{ ok = (-not $on); detail = "RDP enabled: $on" } } else { @{ ok = (-not $on -or $nla -eq 1); detail = "RDP enabled: $on, NLA: $($nla -eq 1)" } }`,
      fix: `if ($p.mode -eq 'disabled') { Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 1 }
else { Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name UserAuthentication -Value 1 }`,
    },
  },
  uac_on: {
    title: 'User Account Control on', category: 'Security', platforms: ['windows'],
    win: {
      check: `$v = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System').EnableLUA
@{ ok = ($v -eq 1); detail = "EnableLUA = $v" }`,
      fix: `Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name EnableLUA -Value 1 -Type DWord`,
    },
  },
  autorun_off: {
    title: 'AutoRun / AutoPlay disabled', category: 'Security', platforms: ['windows'],
    win: {
      check: `$v = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' -ErrorAction SilentlyContinue).NoDriveTypeAutoRun
@{ ok = ($v -eq 255); detail = "NoDriveTypeAutoRun = $v" }`,
      fix: `New-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' -Force | Out-Null
Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' -Name NoDriveTypeAutoRun -Value 255 -Type DWord`,
    },
  },
  windows_update_on: {
    title: 'Windows Update not disabled', category: 'Updates', platforms: ['windows'],
    win: {
      check: `$svc = Get-Service wuauserv
$pol = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU' -ErrorAction SilentlyContinue).NoAutoUpdate
@{ ok = ([string]$svc.StartType -ne 'Disabled' -and $pol -ne 1); detail = "Service start type $($svc.StartType)$(if ($pol -eq 1) { ', automatic updates disabled by policy' })" }`,
      fix: `Set-Service wuauserv -StartupType Manual
Remove-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU' -Name NoAutoUpdate -ErrorAction SilentlyContinue`,
    },
  },
  ssh_root_login: {
    title: 'SSH root login restricted', category: 'Remote access', platforms: ['linux'],
    params: [{ key: 'value', label: 'PermitRootLogin', type: 'select', options: [['no', 'no'], ['prohibit-password', 'prohibit-password (keys only)']], default: 'prohibit-password' }],
    linux: {
      check: `if ! command -v sshd >/dev/null 2>&1; then NA=1; DETAIL="OpenSSH server not installed"; else
  cur="$(sshd -T 2>/dev/null | awk '$1=="permitrootlogin"{print $2}')"
  case "$P_value:$cur" in no:no|prohibit-password:no|prohibit-password:prohibit-password|prohibit-password:without-password) OK=1 ;; *) OK=0 ;; esac
  DETAIL="PermitRootLogin \${cur:-unknown}"; fi`,
      fix: `mkdir -p /etc/ssh/sshd_config.d; echo "PermitRootLogin $P_value" > /etc/ssh/sshd_config.d/10-hostpilot-root.conf
grep -q '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config || sed -i "1i Include /etc/ssh/sshd_config.d/*.conf" /etc/ssh/sshd_config
sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)`,
    },
  },
  ssh_password_auth: {
    title: 'SSH password login disabled (keys only)', category: 'Remote access', platforms: ['linux'],
    description: 'Make sure administrators have SSH keys before enforcing this.',
    linux: {
      check: `if ! command -v sshd >/dev/null 2>&1; then NA=1; DETAIL="OpenSSH server not installed"; else
  cur="$(sshd -T 2>/dev/null | awk '$1=="passwordauthentication"{print $2}')"; [ "$cur" = no ] && OK=1 || OK=0; DETAIL="PasswordAuthentication \${cur:-unknown}"; fi`,
      fix: `mkdir -p /etc/ssh/sshd_config.d; echo "PasswordAuthentication no" > /etc/ssh/sshd_config.d/10-hostpilot-password.conf
grep -q '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config || sed -i "1i Include /etc/ssh/sshd_config.d/*.conf" /etc/ssh/sshd_config
sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)`,
    },
  },
  auto_updates_linux: {
    title: 'Automatic security updates', category: 'Updates', platforms: ['linux'],
    description: 'unattended-upgrades (Debian/Ubuntu) or dnf-automatic (RHEL/Fedora).',
    linux: {
      check: `if command -v apt-get >/dev/null 2>&1; then
  if dpkg -s unattended-upgrades >/dev/null 2>&1 && apt-config dump 2>/dev/null | grep -q 'APT::Periodic::Unattended-Upgrade "1"'; then OK=1; DETAIL="unattended-upgrades enabled"; else OK=0; DETAIL="unattended-upgrades not enabled"; fi
elif command -v dnf >/dev/null 2>&1; then
  if systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1 || systemctl is-enabled dnf-automatic-install.timer >/dev/null 2>&1; then OK=1; DETAIL="dnf-automatic enabled"; else OK=0; DETAIL="dnf-automatic not enabled"; fi
else NA=1; DETAIL="Unsupported package manager"; fi`,
      fix: `if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q unattended-upgrades >/dev/null
  printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades
elif command -v dnf >/dev/null 2>&1; then dnf install -y -q dnf-automatic >/dev/null && sed -i 's/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf && systemctl enable --now dnf-automatic.timer; fi`,
    },
  },
  service_running: {
    title: 'Service running', category: 'Services', platforms: ['windows', 'linux'],
    description: 'The service must be running (and start automatically). It is also monitored continuously and alerts when it stops.',
    params: [{ key: 'name', label: 'Service name (e.g. Spooler, sshd)', type: 'text', required: true }],
    win: {
      check: `$s = Get-Service -Name $p.name -ErrorAction SilentlyContinue
if (-not $s) { @{ ok = $false; detail = "Service $($p.name) is not installed" } } else { @{ ok = ([string]$s.Status -eq 'Running'); detail = "$($s.DisplayName): $($s.Status), $($s.StartType)" } }`,
      fix: `$s = Get-Service -Name $p.name -ErrorAction Stop
if ([string]$s.StartType -eq 'Disabled') { Set-Service -Name $p.name -StartupType Automatic }
Start-Service -Name $p.name`,
    },
    linux: {
      check: `st="$(systemctl is-active "$P_name" 2>/dev/null)"; [ "$st" = active ] && OK=1 || OK=0; DETAIL="$P_name: \${st:-not found}"`,
      fix: 'systemctl enable --now "$P_name"',
    },
  },
  service_disabled: {
    title: 'Service stopped and disabled', category: 'Services', platforms: ['windows', 'linux'],
    description: 'For services that should never run, e.g. RemoteRegistry, Telnet, or a vendor updater.',
    params: [{ key: 'name', label: 'Service name', type: 'text', required: true }],
    win: {
      check: `$s = Get-Service -Name $p.name -ErrorAction SilentlyContinue
if (-not $s) { @{ ok = $true; detail = "$($p.name) is not installed" } } else { @{ ok = ([string]$s.Status -ne 'Running' -and [string]$s.StartType -eq 'Disabled'); detail = "$($s.DisplayName): $($s.Status), $($s.StartType)" } }`,
      fix: `Stop-Service -Name $p.name -Force -ErrorAction SilentlyContinue; Set-Service -Name $p.name -StartupType Disabled`,
    },
    linux: {
      check: `st="$(systemctl is-active "$P_name" 2>/dev/null)"; en="$(systemctl is-enabled "$P_name" 2>/dev/null)"
if [ -z "$en" ]; then OK=1; DETAIL="$P_name is not installed"; else [ "$st" != active ] && [ "$en" != enabled ] && OK=1 || OK=0; DETAIL="$P_name: $st, $en"; fi`,
      fix: 'systemctl disable --now "$P_name"',
    },
  },
  registry_value: {
    title: 'Registry value', category: 'Configuration', platforms: ['windows'],
    params: [{ key: 'path', label: 'Key (e.g. HKLM:\\SOFTWARE\\Policies\\...)', type: 'text', required: true },
      { key: 'name', label: 'Value name', type: 'text', required: true },
      { key: 'type', label: 'Type', type: 'select', options: [['DWord', 'DWORD'], ['String', 'String'], ['QWord', 'QWORD'], ['ExpandString', 'Expandable string']], default: 'DWord' },
      { key: 'value', label: 'Required data', type: 'text', required: true }],
    win: {
      check: `$cur = (Get-ItemProperty -LiteralPath $p.path -Name $p.name -ErrorAction SilentlyContinue).($p.name)
@{ ok = ($null -ne $cur -and [string]$cur -eq [string]$p.value); detail = "$($p.path)\\$($p.name) = $(if ($null -eq $cur) { '(not set)' } else { $cur })" }`,
      fix: `if (-not (Test-Path -LiteralPath $p.path)) { New-Item -Path $p.path -Force | Out-Null }
$v = if ($p.type -in 'DWord', 'QWord') { [int64]$p.value } else { [string]$p.value }
New-ItemProperty -LiteralPath $p.path -Name $p.name -PropertyType $p.type -Value $v -Force | Out-Null`,
    },
  },
  local_admins: {
    title: 'Only approved local administrators', category: 'Accounts', platforms: ['windows', 'linux'],
    description: 'Report only: lists unexpected members of Administrators (Windows) or sudo/wheel (Linux).',
    params: [{ key: 'allowed', label: 'Allowed accounts (comma separated; domain admins/groups may be listed)', type: 'text', default: 'Administrator' }],
    win: {
      check: `$allowed = @($p.allowed -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
$m = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.Name })
$extra = @($m | Where-Object { $allowed -notcontains ($_ -split '\\\\')[-1].ToLower() -and $allowed -notcontains $_.ToLower() })
@{ ok = ($extra.Count -eq 0); detail = $(if ($extra.Count) { "Unexpected: $($extra -join ', ')" } else { "Members: $($m -join ', ')" }) }`,
    },
    linux: {
      check: `extra=""; for u in $(getent group sudo wheel admin 2>/dev/null | cut -d: -f4 | tr ',' ' '); do
  case ",$P_allowed," in *",$u,"*|*", $u,"*) ;; *) extra="$extra $u" ;; esac; done
[ -z "$extra" ] && OK=1 || OK=0; DETAIL="\${extra:+Unexpected:$extra}"; [ -z "$DETAIL" ] && DETAIL="No unexpected sudo users"`,
    },
  },
  custom_script: {
    title: 'Custom check script', category: 'Custom', platforms: ['windows', 'linux'],
    description: 'Exit code 0 means compliant. The first line of output is shown as the detail. The fix script runs when enforcing.',
    params: [{ key: 'label', label: 'Name shown in reports', type: 'text', required: true },
      { key: 'check', label: 'Check script (PowerShell on Windows, bash on Linux)', type: 'textarea', required: true },
      { key: 'fix', label: 'Fix script (optional)', type: 'textarea' }],
    win: {
      check: `$f = Join-Path $env:TEMP ("hp-chk-" + [guid]::NewGuid() + '.ps1'); [IO.File]::WriteAllText($f, $p.check)
$out = & powershell -NoProfile -ExecutionPolicy Bypass -File $f 2>&1; $code = $LASTEXITCODE; Remove-Item $f -Force
@{ ok = ($code -eq 0); detail = [string](@($out)[0]) }`,
      fix: `if ($p.fix) { $f = Join-Path $env:TEMP ("hp-fix-" + [guid]::NewGuid() + '.ps1'); [IO.File]::WriteAllText($f, $p.fix); & powershell -NoProfile -ExecutionPolicy Bypass -File $f | Out-Null; Remove-Item $f -Force }`,
    },
    linux: {
      check: `out="$(printf '%s' "$P_check" | bash 2>&1)"; [ $? -eq 0 ] && OK=1 || OK=0; DETAIL="$(printf '%s' "$out" | head -n 1)"`,
      fix: '[ -n "$P_fix" ] && printf \'%s\' "$P_fix" | bash >/dev/null 2>&1',
    },
  },
};

export const ruleCatalog = () => Object.entries(RULES).map(([id, r]) => ({
  id, title: r.title, category: r.category, platforms: r.platforms, description: r.description || '', params: r.params || [], fixable: !!(r.win?.fix || r.linux?.fix),
}));

// ---------- validation ----------
const CLASSES = ['desktop', 'laptop', 'server', 'vm'];
export function cleanPolicy(b) {
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Name is required');
  const t = b.target || {};
  const target = {
    platform: ['any', 'windows', 'linux'].includes(t.platform) ? t.platform : 'any',
    clients: (Array.isArray(t.clients) ? t.clients : []).map(Number).filter(Number.isInteger).slice(0, 500),
    classes: (Array.isArray(t.classes) ? t.classes : []).filter((c) => CLASSES.includes(c)),
    agents: (Array.isArray(t.agents) ? t.agents : []).map(String).filter((x) => /^[\w-]{1,64}$/.test(x)).slice(0, 5000),
  };
  if (!Array.isArray(b.rules) || !b.rules.length) throw new HttpError(400, 'Add at least one rule');
  const seen = new Map();
  const rules = b.rules.slice(0, 60).map((r) => {
    const def = RULES[r?.type];
    if (!def) throw new HttpError(400, `Unknown rule ${r?.type}`);
    const params = {};
    for (const p of def.params || []) {
      let v = r.params?.[p.key] ?? p.default ?? '';
      if (p.type === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0 || v > 1e6) throw new HttpError(400, `${def.title}: ${p.label} must be a number`); }
      else {
        v = String(v).slice(0, p.type === 'textarea' ? 20000 : 500);
        if (p.type === 'select' && !p.options.some(([o]) => o === v)) throw new HttpError(400, `${def.title}: invalid ${p.label}`);
        if (p.type === 'text' && /[\r\n\0]/.test(v)) throw new HttpError(400, `${def.title}: ${p.label} must be one line`);
      }
      if (p.required && v === '') throw new HttpError(400, `${def.title}: ${p.label} is required`);
      if (p.key === 'name' && r.type.startsWith('service_') && !/^[\w.@:+ -]{1,100}$/.test(v)) throw new HttpError(400, `${def.title}: invalid service name`);
      params[p.key] = v;
    }
    const n = (seen.get(r.type) || 0) + 1; seen.set(r.type, n);
    return { key: n > 1 ? `${r.type}-${n}` : r.type, type: r.type, params };
  });
  return {
    name, description: String(b.description || '').slice(0, 500), enabled: b.enabled === false ? 0 : 1, enforce: b.enforce ? 1 : 0,
    interval_hours: Math.max(1, Math.min(24 * 30, Math.round(Number(b.interval_hours) || 24))), target, rules,
  };
}

// ---------- targeting ----------
export function policyTargets(p) {
  const t = typeof p.target === 'string' ? JSON.parse(p.target) : p.target;
  if (t.agents?.length) return all(`SELECT id, hostname, platform, device_class, client_id FROM agents WHERE id IN (${t.agents.map(() => '?').join(',')})`, ...t.agents);
  return all('SELECT id, hostname, platform, device_class, client_id FROM agents').filter((a) =>
    (t.platform === 'any' || a.platform === t.platform) && (!t.clients?.length || t.clients.includes(a.client_id)) && (!t.classes?.length || t.classes.includes(a.device_class || 'desktop')));
}
const appliesTo = (p, a) => policyTargets(p).some((x) => x.id === a.id);

/** service names that enabled "service running" rules want watched on this device (for continuous monitoring) */
export function policyServicesFor(a) {
  const out = [];
  try {
    for (const p of all('SELECT * FROM policies WHERE enabled=1')) {
      const rules = JSON.parse(p.rules).filter((r) => r.type === 'service_running');
      if (rules.length && appliesTo(p, a)) out.push(...rules.map((r) => r.params.name));
    }
  } catch { /* table not ready yet */ }
  return out;
}

// ---------- script generation ----------
export function buildPolicyScript(p, platform) {
  const rules = JSON.parse(p.rules).filter((r) => RULES[r.type]?.platforms.includes(platform));
  if (!rules.length) return null;
  const enforce = !!p.enforce;
  if (platform === 'windows') {
    const parts = rules.map((r) => {
      const def = RULES[r.type];
      return `# ---- ${def.title}
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(JSON.stringify(r.params))}')) | ConvertFrom-Json
try {
  $r = & { ${def.win.check} }
  if ($r.ok) { Emit '${r.key}' 'pass' $r.detail }
  elseif ($Enforce -and ${def.win.fix ? '$true' : '$false'}) {
    try { & { ${def.win.fix || ''} } | Out-Null } catch { Emit '${r.key}' 'fail' ("Fix failed: " + $_.Exception.Message); continue }
    $r2 = & { ${def.win.check} }
    if ($r2.ok) { Emit '${r.key}' 'fixed' $r2.detail } else { Emit '${r.key}' 'fail' $r2.detail }
  } else { Emit '${r.key}' 'fail' $r.detail }
} catch { if ($_.Exception.Message -like 'NA:*') { Emit '${r.key}' 'na' ($_.Exception.Message -replace '^NA:\\s*', '') } else { Emit '${r.key}' 'error' $_.Exception.Message } }`;
    });
    // each rule sits in its own one-iteration loop so "continue" skips to the next rule
    return { shell: 'powershell', body: `$ErrorActionPreference = 'Stop'
$Enforce = ${enforce ? '$true' : '$false'}
function Emit($k, $s, $d) { "P\`t$k\`t$s\`t$(([string]$d) -replace "[\`t\`r\`n]", ' ')" }
"POLICY\`t${p.id}"
${parts.map((x) => `foreach ($__ in 1) {\n${x}\n}`).join('\n')}
` };
  }
  const parts = rules.map((r) => {
    const def = RULES[r.type];
    const vars = Object.entries(r.params).map(([k, v]) => `P_${k}="$(printf '%s' '${b64(v)}' | base64 -d)"`).join('\n');
    return `# ---- ${def.title}
${vars}
OK=0; NA=0; DETAIL=""
rule_check() {
${def.linux.check}
}
rule_check
if [ "$NA" = 1 ]; then emit '${r.key}' na "$DETAIL"
elif [ "$OK" = 1 ]; then emit '${r.key}' pass "$DETAIL"
elif [ "$ENFORCE" = 1 ] && ${def.linux.fix ? 'true' : 'false'}; then
  ( ${def.linux.fix || ':'} ) >/dev/null 2>&1
  OK=0; NA=0; DETAIL=""; rule_check
  if [ "$OK" = 1 ]; then emit '${r.key}' fixed "$DETAIL"; else emit '${r.key}' fail "$DETAIL"; fi
else emit '${r.key}' fail "$DETAIL"; fi`;
  });
  return { shell: 'bash', body: `ENFORCE=${enforce ? 1 : 0}
emit() { printf 'P\\t%s\\t%s\\t%s\\n' "$1" "$2" "$(printf '%s' "$3" | tr '\\t\\r\\n' '   ')"; }
printf 'POLICY\\t${p.id}\\n'
${parts.join('\n')}
` };
}

// ---------- results ----------
export function ingestPolicyResult(job) {
  const lines = String(job.stdout || '').split(/\r?\n/).map((l) => l.split('\t'));
  const head = lines.find((f) => f[0] === 'POLICY');
  if (!head) return;
  const pid = Number(head[1]);
  if (!get('SELECT id FROM policies WHERE id=?', pid)) return;
  const now = Date.now();
  const rows = lines.filter((f) => f[0] === 'P' && f[1]);
  tx(() => {
    run('DELETE FROM policy_results WHERE policy_id=? AND agent_id=?', pid, job.agent_id);
    for (const [, key, status, detail] of rows) {
      run('INSERT INTO policy_results(policy_id, agent_id, rule_key, status, detail, checked_at, job_id) VALUES(?,?,?,?,?,?,?)',
        pid, job.agent_id, key, ['pass', 'fail', 'fixed', 'error', 'na'].includes(status) ? status : 'error', String(detail || '').slice(0, 1000), now, job.id);
    }
    if (!rows.length) {
      run('INSERT INTO policy_results(policy_id, agent_id, rule_key, status, detail, checked_at, job_id) VALUES(?,?,?,?,?,?,?)',
        pid, job.agent_id, '_run', 'error', (job.stderr || 'The policy did not run').slice(0, 1000), now, job.id);
    }
  });
}
