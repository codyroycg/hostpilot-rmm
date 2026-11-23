// Live performance monitor: while someone watches the "1 minute" chart, the device posts a
// CPU/memory/disk sample every 2 s. Samples are kept in memory only (last ~2 minutes).
import { randHex, safeEqualHex, HttpError } from './util.js';
import { queueJobs } from './jobs.js';
import { buildTask } from './task-catalog.js';

const sessions = new Map(); // agentId -> session
const KEEP_MS = 120_000;     // samples kept
const VIEW_GRACE = 30_000;   // sampler stops this long after the last viewer request
const START_GRACE = 45_000;  // a sampler that hasn't sent anything by then is considered dead

function alive(s) {
  const now = Date.now();
  return s.until > now && (s.lastSample ? now - s.lastSample < 15_000 : now - s.started < START_GRACE);
}

/** Starts (or keeps alive) the live sampler for a device. */
export function startLive(agent, user) {
  let s = sessions.get(agent.id);
  if (s && alive(s)) { s.until = Date.now() + VIEW_GRACE; return { started: false }; }
  s = { token: randHex(24), started: Date.now(), until: Date.now() + VIEW_GRACE, lastSample: 0, samples: s?.samples || [] };
  const r = queueJobs({
    agents: [agent], name: 'Live performance monitor', task: 'metrics.live', createdBy: user.username, timeout: 3600,
    build: (a) => buildTask('metrics.live', a.platform, { url: `/api/live/${agent.id}?token=${s.token}` }, { allowInternal: true }),
  });
  if (!r.created) throw new HttpError(400, 'Live monitoring is not available for this device');
  sessions.set(agent.id, s);
  return { started: true };
}

/** Samples from the last minute; also counts as a viewer heartbeat. */
export function readLive(agentId) {
  const s = sessions.get(agentId);
  if (!s) return { active: false, samples: [] };
  if (s.until > Date.now()) s.until = Math.max(s.until, Date.now() + VIEW_GRACE);
  const since = Date.now() - 65_000;
  return { active: alive(s), waiting: !s.lastSample, samples: s.samples.filter((x) => x.ts > since) };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; };

/** POST /api/live/:id?token=  body: "cpu mem disk" — answers "ok" or "stop". */
export async function liveSample(ctx) {
  const s = sessions.get(ctx.params.id);
  if (!s || !safeEqualHex(String(ctx.query.get('token') || ''), s.token)) return 'stop';
  let body = '';
  for await (const c of ctx.req) { body += c; if (body.length > 200) break; }
  if (Date.now() > s.until) { sessions.delete(ctx.params.id); return 'stop'; }
  const [cpu, mem, disk] = body.trim().split(/\s+/);
  const now = Date.now();
  s.lastSample = now;
  s.samples.push({ ts: now, cpu: num(cpu), mem: num(mem), disk: num(disk) });
  while (s.samples.length && s.samples[0].ts < now - KEEP_MS) s.samples.shift();
  return 'ok';
}
