import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { route, sendText, clientIp, publicUrl } from './router.js';
import { get, run, tx, getSettings } from './db.js';
import { HttpError, uuid, randHex, sha256, safeEqualHex, truncate, clampInt } from './util.js';
import { addWaiter, claimJobs } from './jobs.js';
import { evaluateThresholds, resolveAlert } from './alerts.js';
import { onJobFinished } from './job-results.js';
import { checkToken, receiveInto, sendFile } from './transfers.js';
import { hostInput, hostOutput, hostClose } from './terminal.js';
import { liveSample } from './live.js';

const AGENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');

function loadFile(name, normalizeLf) {
  let buf = fs.readFileSync(path.join(AGENT_DIR, name));
  if (normalizeLf) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return { buf, version: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12) };
}

export const AGENT_FILES = {
  'windows.ps1': loadFile('windows-agent.ps1', false),
  'runner.ps1': loadFile('windows-runner.ps1', false),
  'remote.ps1': loadFile('windows-remote.ps1', false),
  'linux.sh': loadFile('linux-agent.sh', true),
};
const INSTALLERS = {
  windows: fs.readFileSync(path.join(AGENT_DIR, 'windows-install.ps1'), 'utf8'),
  linux: fs.readFileSync(path.join(AGENT_DIR, 'linux-install.sh'), 'utf8').replace(/\r\n/g, '\n'),
};
export const AGENT_VERSIONS = {
  windows: AGENT_FILES['windows.ps1'].version,
  linux: AGENT_FILES['linux.sh'].version,
};

function validToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{16,64}$/.test(token)) return null;
  const t = get('SELECT * FROM enroll_tokens WHERE token=?', token);
  if (!t || (t.expires_at && t.expires_at < Date.now())) return null;
  return t;
}

function authAgent(ctx) {
  const id = ctx.req.headers['x-agent-id'];
  const secret = ctx.req.headers['x-agent-secret'];
  if (!id || !secret) throw new HttpError(401, 'Missing agent credentials');
  const a = get('SELECT * FROM agents WHERE id=?', String(id));
  if (!a || !safeEqualHex(a.secret_hash, sha256(String(secret)))) throw new HttpError(401, 'Unknown agent');
  const t = Date.now();
  run('UPDATE agents SET last_seen=?, public_ip=? WHERE id=?', t, clientIp(ctx.req), a.id);
  if (!a.last_seen || t - a.last_seen > getSettings().offline_minutes * 60000) {
    resolveAlert(a, 'offline', 'agent is back online');
  }
  a.last_seen = t;
  return a;
}

const b64 = (s) => (typeof s === 'string' ? Buffer.from(s, 'base64').toString('utf8') : '');
const str = (v, max = 500) => (v == null ? null : String(v).slice(0, max));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------- agent downloads & installers ----------

route('GET', '/agent/:file', (ctx) => {
  const f = AGENT_FILES[ctx.params.file];
  if (!f) throw new HttpError(404, 'Not found');
  sendText(ctx.res, 200, f.buf, 'application/octet-stream');
});

route('GET', '/install/:platform', (ctx) => {
  const tpl = INSTALLERS[ctx.params.platform];
  if (!tpl) throw new HttpError(404, 'Unknown platform');
  const token = String(ctx.query.get('token') || '');
  if (!validToken(token)) {
    const msg = 'Invalid or expired enrollment token';
    return sendText(ctx.res, 403, ctx.params.platform === 'windows' ? `throw '${msg}'` : `echo '${msg}' >&2; exit 1`);
  }
  const script = tpl.replaceAll('__SERVER_URL__', publicUrl(ctx.req)).replaceAll('__TOKEN__', token);
  sendText(ctx.res, 200, script);
});

// ---------- agent API ----------

route('POST', '/api/agent/enroll', (ctx) => {
  const { token, hostname, platform } = ctx.body;
  const t = validToken(token);
  if (!t) throw new HttpError(403, 'Invalid or expired enrollment token');
  if (!['windows', 'linux'].includes(platform)) throw new HttpError(400, 'platform must be windows or linux');
  const id = uuid();
  const secret = randHex(32);
  tx(() => {
    run(`INSERT INTO agents(id, client_id, secret_hash, hostname, platform, enrolled_at, last_seen, public_ip, want_inventory)
         VALUES(?,?,?,?,?,?,?,?,1)`, id, t.client_id, sha256(secret), str(hostname, 255) || 'unknown', platform,
    Date.now(), Date.now(), clientIp(ctx.req));
    run('UPDATE enroll_tokens SET uses=uses+1 WHERE token=?', t.token);
  });
  console.log(`[enroll] ${platform} agent ${hostname} (${id})`);
  if (ctx.query.get('format') === 'text') return sendText(ctx.res, 200, `AGENT_ID='${id}'\nSECRET='${secret}'\n`);
  return { agent_id: id, secret, checkin_seconds: getSettings().checkin_seconds };
});

route('POST', '/api/agent/checkin', (ctx) => {
  const a = authAgent(ctx);
  const b = ctx.body;
  const disks = Array.isArray(b.disks)
    ? b.disks.slice(0, 64).map((d) => ({ mount: str(d.mount, 200), total: num(d.total) || 0, free: num(d.free) || 0 }))
    : null;
  const ips = Array.isArray(b.ip_addrs) ? b.ip_addrs.slice(0, 32).map((x) => str(x, 64)) : null;
  const cpu = num(b.cpu);
  const mem = num(b.mem);
  const fields = {
    hostname: str(b.hostname, 255), os_name: str(b.os_name), os_version: str(b.os_version), arch: str(b.arch, 50),
    cpu_model: str(b.cpu_model), cpu_cores: num(b.cpu_cores), ram_total: num(b.ram_total),
    logged_user: str(b.logged_user), boot_time: num(b.boot_time), agent_version: str(b.agent_version, 50),
    manufacturer: str(b.manufacturer), model: str(b.model), serial: str(b.serial, 200),
    cpu_pct: cpu, mem_pct: mem,
    ip_addrs: ips ? JSON.stringify(ips) : null, disks: disks ? JSON.stringify(disks) : null,
  };
  const keys = Object.keys(fields).filter((k) => fields[k] !== null);
  if (keys.length) {
    run(`UPDATE agents SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => fields[k]), a.id);
  }
  const diskMax = disks && disks.length
    ? Math.max(...disks.filter((d) => d.total > 0).map((d) => ((d.total - d.free) / d.total) * 100), 0) : null;
  run('INSERT INTO metrics(agent_id, ts, cpu, mem, disk) VALUES(?,?,?,?,?)', a.id, Date.now(), cpu, mem, diskMax);
  evaluateThresholds({ ...a, hostname: fields.hostname || a.hostname }, disks);
  return { ok: true, checkin_seconds: getSettings().checkin_seconds };
});

route('POST', '/api/agent/inventory', (ctx) => {
  const a = authAgent(ctx);
  let sw = [];
  if (Array.isArray(ctx.body.software)) {
    sw = ctx.body.software;
  } else if (ctx.body.software_b64) {
    sw = b64(ctx.body.software_b64).split('\n').filter(Boolean).map((l) => {
      const [name, version, publisher] = l.split('\t');
      return { name, version, publisher };
    });
  }
  tx(() => {
    run('DELETE FROM software WHERE agent_id=?', a.id);
    for (const s of sw.slice(0, 20000)) {
      if (!s || !s.name) continue;
      run('INSERT INTO software(agent_id, name, version, publisher) VALUES(?,?,?,?)', a.id, str(s.name), str(s.version, 200), str(s.publisher));
    }
    run('UPDATE agents SET want_inventory=0, inventory_at=? WHERE id=?', Date.now(), a.id);
  });
  return { ok: true, count: sw.length };
});

route('GET', '/api/agent/poll', async (ctx) => {
  const a = authAgent(ctx);
  const wait = clampInt(ctx.query.get('wait'), 0, 30, 0);
  let jobs = claimJobs(a.id);
  if (!jobs.length && wait > 0) {
    await new Promise((resolve) => {
      let remove = () => {};
      const done = () => { clearTimeout(timer); remove(); resolve(); };
      const timer = setTimeout(done, wait * 1000);
      remove = addWaiter(a.id, done);
      ctx.res.on('close', done);
    });
    if (ctx.res.destroyed) return undefined;
    jobs = claimJobs(a.id);
    run('UPDATE agents SET last_seen=? WHERE id=?', Date.now(), a.id);
  }
  const s = getSettings();
  const fresh = get('SELECT want_inventory, inventory_at FROM agents WHERE id=?', a.id);
  const wantInv = !!fresh.want_inventory || !fresh.inventory_at || Date.now() - fresh.inventory_at > s.inventory_hours * 3600000;
  const version = AGENT_VERSIONS[a.platform];

  if (ctx.query.get('format') === 'text') {
    const lines = [`VERSION\t${version}`, `INTERVAL\t${s.checkin_seconds}`];
    if (wantInv) lines.push('INV\t1');
    for (const j of jobs) {
      lines.push(['JOB', j.id, j.shell, j.timeout, Buffer.from(j.body || '', 'utf8').toString('base64')].join('\t'));
    }
    return sendText(ctx.res, 200, lines.join('\n') + '\n');
  }
  return { jobs, want_inventory: wantInv, version, checkin_seconds: s.checkin_seconds };
});

route('POST', '/api/agent/result', (ctx) => {
  const a = authAgent(ctx);
  const b = ctx.body;
  const job = get('SELECT id, agent_id, status FROM jobs WHERE id=?', String(b.job_id || ''));
  if (!job || job.agent_id !== a.id) throw new HttpError(404, 'Unknown job');
  if (job.status === 'cancelled') return { ok: true };
  const stdout = truncate(b.stdout_b64 != null ? b64(b.stdout_b64) : b.stdout);
  const stderr = truncate(b.stderr_b64 != null ? b64(b.stderr_b64) : b.stderr);
  const code = num(b.exit_code);
  const status = b.timed_out ? 'timeout' : code === 0 ? 'success' : 'failed';
  run('UPDATE jobs SET status=?, exit_code=?, stdout=?, stderr=?, finished_at=? WHERE id=?',
    status, code, stdout, stderr, Date.now(), job.id);
  onJobFinished(job.id);
  return { ok: true };
});

// ---------- file transfers (device side; authorised by the per-transfer token) ----------

route('PUT', '/api/transfer/:id', async (ctx) => {
  const t = checkToken(ctx.params.id, ctx.query.get('token'));
  if (t.direction !== 'to-server' || t.ready) throw new HttpError(409, 'Transfer already completed');
  await receiveInto(t, ctx.req);
  return { ok: true, size: t.size };
}, { raw: true });

route('GET', '/api/transfer/:id', (ctx) => {
  const t = checkToken(ctx.params.id, ctx.query.get('token'));
  if (t.direction !== 'to-device') throw new HttpError(409, 'Wrong direction');
  return sendFile(t, ctx.res, { attachment: false });
});

// ---------- terminal streams (device side) ----------

route('GET', '/api/term/:id/in', (ctx) => hostInput(ctx));
route('POST', '/api/term/:id/out', (ctx) => hostOutput(ctx), { raw: true });
route('POST', '/api/term/:id/close', (ctx) => hostClose(ctx), { raw: true });

// Live performance samples (token in the URL identifies the session)
route('POST', '/api/live/:id', async (ctx) => sendText(ctx.res, 200, await liveSample(ctx)), { raw: true });

// ---------- downloadable installers ----------
// /download/<enrollment token>/<file>: the token is the secret (same as the one-line install commands),
// so these links can be emailed to a client.

const SETUP_STUB = path.join(AGENT_DIR, 'HostPilotSetup.exe');
const CONFIG_MARKER = '##HOSTPILOT-CONFIG##';

route('GET', '/download/:token/:file', (ctx) => {
  const token = ctx.params.token;
  if (!validToken(token)) throw new HttpError(403, 'This download link has expired or was revoked.');
  const server = publicUrl(ctx.req);
  let buf, type = 'application/octet-stream';
  switch (ctx.params.file) {
    case 'HostPilot-Setup.exe': {
      if (!fs.existsSync(SETUP_STUB)) throw new HttpError(404, 'Setup stub missing from server/agents');
      buf = Buffer.concat([fs.readFileSync(SETUP_STUB), Buffer.from(`\n${CONFIG_MARKER}${server}\n${token}\n`, 'utf8')]);
      break;
    }
    case 'hostpilot-install.sh':
      buf = Buffer.from(INSTALLERS.linux.replaceAll('__SERVER_URL__', server).replaceAll('__TOKEN__', token));
      type = 'text/x-shellscript';
      break;
    case 'hostpilot-install.ps1':
      buf = Buffer.from(INSTALLERS.windows.replaceAll('__SERVER_URL__', server).replaceAll('__TOKEN__', token));
      break;
    default:
      throw new HttpError(404, 'Not found');
  }
  ctx.res.writeHead(200, {
    'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${ctx.params.file}"`,
  });
  ctx.res.end(buf);
});
