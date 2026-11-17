import fs from 'node:fs';
import path from 'node:path';

export const APP_VERSION = '0.1.1';
export const APP_NAME = 'Pomong Agent';

/** Root of the project at runtime (inside the container: /app). */
export const ROOT_DIR = path.resolve(__dirname, '..');

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const CLIENT_DIST = path.join(ROOT_DIR, 'dist');

export const PORT = Number(process.env.PORT || 3100);
export const HOST = process.env.HOST || '0.0.0.0';
export const IS_PROD = process.env.NODE_ENV === 'production';

/** Host filesystem roots (bind-mounted read-only in docker-compose for real host metrics). */
export const HOST_PROC = fs.existsSync('/host/proc/stat') ? '/host/proc' : '/proc';
export const HOST_ROOT = fs.existsSync('/host/etc/os-release') ? '/host' : '/';

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Read a small text file and return its trimmed content, or null. */
export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

export function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}
