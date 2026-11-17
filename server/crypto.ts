import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readText, writePrivate } from './config';

/** Load or create a 32-byte random secret kept in the data directory. */
function loadKey(file: string): Buffer {
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  }
  const key = crypto.randomBytes(32);
  writePrivate(p, key.toString('base64'));
  return key;
}

let _serverKey: Buffer | null = null;
export function serverKey(): Buffer {
  if (!_serverKey) _serverKey = loadKey('.server_key');
  return _serverKey;
}

let _sessionKey: Buffer | null = null;
export function sessionKey(): Buffer {
  if (!_sessionKey) _sessionKey = loadKey('.session_key');
  return _sessionKey;
}

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt)                                           */
/* ------------------------------------------------------------------ */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* AES-256-GCM                                                         */
/* ------------------------------------------------------------------ */

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1') throw new Error('unsupported ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Signed values (cookies, setup tokens)                               */
/* ------------------------------------------------------------------ */

export function sign(value: string, key: Buffer = sessionKey()): string {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

export function signValue(value: string): string {
  return `${Buffer.from(value, 'utf8').toString('base64url')}.${sign(value)}`;
}

export function unsignValue(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx < 1) return null;
  const raw = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const value = Buffer.from(raw, 'base64url').toString('utf8');
  const expected = sign(value);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return value;
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}${'•'.repeat(Math.min(18, Math.max(6, value.length - 7)))}${value.slice(-4)}`;
}

export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at < 0) return maskSecret(value);
  const name = value.slice(0, at);
  const domain = value.slice(at);
  const keep = name.slice(0, Math.min(6, Math.max(1, name.length - 2)));
  return `${keep}${'*'.repeat(4)}${domain}`;
}

export function readSetupToken(): string | null {
  return readText(path.join(DATA_DIR, 'setup-token.txt'));
}
