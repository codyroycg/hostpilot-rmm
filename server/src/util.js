import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const now = () => Date.now();
export const randHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
export const uuid = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return want.length === calc.length && crypto.timingSafeEqual(calc, want);
}

export const SHELLS = {
  powershell: 'windows',
  cmd: 'windows',
  bash: 'linux',
  sh: 'linux',
  python: 'any',
};

export function shellSupported(shell, platform) {
  const p = SHELLS[shell];
  return p === 'any' || p === platform;
}

export function truncate(s, max = 1024 * 1024) {
  if (s == null) return '';
  s = String(s);
  return s.length > max ? '[... output truncated ...]\n' + s.slice(s.length - max) : s;
}

export function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
