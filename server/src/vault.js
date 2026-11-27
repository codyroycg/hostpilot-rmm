// Password vault encryption: AES-256-GCM. The key comes from VAULT_KEY (64 hex chars or any passphrase) or is
// generated once into DATA_DIR/vault.key. Back that file up with the database, or the stored passwords can't be read.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

let key = null;
function getKey() {
  if (key) return key;
  const env = process.env.VAULT_KEY;
  if (env) {
    key = /^[a-f0-9]{64}$/i.test(env) ? Buffer.from(env, 'hex') : crypto.createHash('sha256').update(env).digest();
    return key;
  }
  const file = path.join(DATA_DIR, 'vault.key');
  if (fs.existsSync(file)) key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (!key || key.length !== 32) {
    key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  }
  return key;
}

export function seal(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function open(blob) {
  if (!blob) return '';
  const [v, iv, tag, enc] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unknown vault format');
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
