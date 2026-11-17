import type { NextFunction, Request, Response } from 'express';
import { db } from './db';
import { signValue, unsignValue } from './crypto';

export const SESSION_COOKIE = 'pa_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: number;
  username: string;
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isSecureRequest(req: Request): boolean {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  return req.secure || proto === 'https';
}

export function setCookie(req: Request, res: Response, name: string, value: string, maxAgeMs: number): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(req: Request, res: Response, name: string): void {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function createSession(req: Request, res: Response, user: SessionUser): void {
  const payload = JSON.stringify({ uid: user.id, u: user.username, exp: Date.now() + SESSION_TTL_MS });
  setCookie(req, res, SESSION_COOKIE, signValue(payload), SESSION_TTL_MS);
}

export function readSession(req: Request): SessionUser | null {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const value = unsignValue(raw);
  if (!value) return null;
  try {
    const data = JSON.parse(value) as { uid: number; u: string; exp: number };
    if (!data.exp || data.exp < Date.now()) return null;
    return { id: data.uid, username: data.u };
  } catch {
    return null;
  }
}

export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const user = readSession(req);
  if (user) (req as Request & { user?: SessionUser }).user = user;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = readSession(req);
  if (!user) {
    res.status(401).json({ ok: false, code: 'unauthorized', message: '로그인이 필요합니다.' });
    return;
  }
  (req as Request & { user?: SessionUser }).user = user;
  next();
}

export function getUser(req: Request): SessionUser | null {
  return (req as Request & { user?: SessionUser }).user ?? readSession(req);
}

export function getUserCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}

/* ------------------------------------------------------------------ */
/* Simple brute-force guard for the login form                         */
/* ------------------------------------------------------------------ */

const attempts = new Map<string, { count: number; first: number; blockedUntil: number }>();

export function loginGuard(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.blockedUntil > now) return { allowed: false, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000) };
  return { allowed: true };
}

export function noteFailedLogin(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.first > 10 * 60 * 1000) {
    attempts.set(ip, { count: 1, first: now, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= 8) {
    entry.blockedUntil = now + 15 * 60 * 1000;
    entry.count = 0;
    entry.first = now;
  }
}

export function clearLoginAttempts(ip: string): void {
  attempts.delete(ip);
}
