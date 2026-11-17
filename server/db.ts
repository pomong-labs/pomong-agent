import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDataDir } from './config';

ensureDataDir();

const dbPath = path.join(DATA_DIR, 'pomong-agent.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS vault_items (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL,
  username     TEXT,
  secret_enc   TEXT NOT NULL,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  due        TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

/* ------------------------------------------------------------------ */
/* Schema migrations (기존 data/ 를 지우지 않고 컬럼만 더한다)          */
/* ------------------------------------------------------------------ */

function columnsOf(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

{
  const taskCols = columnsOf('tasks');
  if (!taskCols.has('priority')) db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
  if (!taskCols.has('notes')) db.exec('ALTER TABLE tasks ADD COLUMN notes TEXT');
  if (!taskCols.has('updated_at')) db.exec('ALTER TABLE tasks ADD COLUMN updated_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(done, priority, due)');
}

{
  const msgCols = columnsOf('messages');
  if (!msgCols.has('model')) db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
}


/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getJson<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export function addLog(level: LogLevel, message: string): void {
  db.prepare('INSERT INTO logs(level, message, created_at) VALUES(?,?,?)').run(level, message, new Date().toISOString());
  db.prepare('DELETE FROM logs WHERE id <= (SELECT MAX(id) - 500 FROM logs)').run();
}

export function recentLogs(limit = 8): { id: number; level: LogLevel; message: string; at: string }[] {
  const rows = db
    .prepare('SELECT id, level, message, created_at FROM logs ORDER BY id DESC LIMIT ?')
    .all(limit) as { id: number; level: LogLevel; message: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, level: r.level, message: r.message, at: r.created_at }));
}

export function dbFileSize(): number {
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}
