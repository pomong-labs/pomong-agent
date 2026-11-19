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

{
  // v0.5.0: 금고 다중 계정 — 기본 계정 표시
  const vaultCols = columnsOf('vault_items');
  if (!vaultCols.has('is_default')) db.exec('ALTER TABLE vault_items ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
}

/* ------------------------------------------------------------------ */
/* Phase 2 schema: 예약 실행(잡)·워치·자율 브라우저·도메인 정책            */
/* 기존 테이블은 건드리지 않고 새 테이블만 더한다(data/ 보존).            */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  cron           TEXT NOT NULL,
  timezone       TEXT NOT NULL DEFAULT 'Asia/Seoul',
  prompt         TEXT NOT NULL,
  tools_allow    TEXT,
  max_steps      INTEGER NOT NULL DEFAULT 6,
  notify         TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    TEXT,
  last_run_at    TEXT,
  last_status    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  status     TEXT NOT NULL,
  trigger    TEXT NOT NULL DEFAULT 'schedule',
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  steps      INTEGER NOT NULL DEFAULT 0,
  result     TEXT,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS watchers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'text',
  target        TEXT,
  interval_min  INTEGER NOT NULL DEFAULT 30,
  quiet_hours   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_hash     TEXT,
  last_value    TEXT,
  last_checked  TEXT,
  last_status   TEXT,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watcher_snapshots (
  id          TEXT PRIMARY KEY,
  watcher_id  TEXT NOT NULL,
  hash        TEXT NOT NULL,
  content     TEXT,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watcher_snapshots ON watcher_snapshots(watcher_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS watch_events (
  id           TEXT PRIMARY KEY,
  watcher_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  diff_summary TEXT,
  before_text  TEXT,
  after_text   TEXT,
  url          TEXT,
  created_at   TEXT NOT NULL,
  notified_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_events ON watch_events(watcher_id, created_at DESC);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id              TEXT PRIMARY KEY,
  conv_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  control_owner   TEXT NOT NULL DEFAULT 'agent',
  handover_reason TEXT,
  control_detail  TEXT,
  lease_expires_at TEXT,
  url             TEXT,
  title           TEXT,
  actions         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL,
  ended_at        TEXT
);

CREATE TABLE IF NOT EXISTS browser_actions (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  actor      TEXT NOT NULL,
  tool       TEXT NOT NULL,
  args       TEXT,
  result     TEXT,
  url        TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_actions ON browser_actions(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS handovers (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  detail       TEXT,
  requested_at TEXT NOT NULL,
  accepted_at  TEXT,
  ended_at     TEXT,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS policies (
  pattern    TEXT PRIMARY KEY,
  level      TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
`);

/* ------------------------------------------------------------------ */
/* v0.5.0 schema: 영구 기억 · 채팅 작업 카드 · 웹 푸시 구독               */
/* 새 테이블만 더한다(기존 대화·금고·설정은 그대로 보존).                 */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL DEFAULT 'other',
  content    TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 2,
  source     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category, importance DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  ua         TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT
);

CREATE TABLE IF NOT EXISTS task_runs (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id INTEGER,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  steps      INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS task_run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  label       TEXT NOT NULL,
  summary     TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_run_steps ON task_run_steps(run_id, seq);
`);

/* ------------------------------------------------------------------ */
/* v0.5.1 schema: 채팅 인라인 로그인 카드                                 */
/* 비밀번호는 여기에 저장하지 않는다(금고에만 암호화 저장).               */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS login_requests (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  service    TEXT NOT NULL,
  login_url  TEXT NOT NULL,
  site_host  TEXT,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  vault_id   TEXT,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_requests ON login_requests(session_id, created_at DESC);
`);

// v0.5.1: 작업 카드는 실제 도구가 돌 때만 만든다. 예전 버전이 남긴 빈 카드는 지운다.
db.prepare("DELETE FROM task_runs WHERE steps = 0").run();

/* ------------------------------------------------------------------ */
/* v0.5.2 schema: 채팅 첨부(사진·파일)                                   */
/* 파일 자체는 data/uploads/ 에 두고, 여기에는 메타데이터만 남긴다.        */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS chat_attachments (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id INTEGER,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'other',
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_session ON chat_attachments(session_id, created_at DESC);
`);


/* ------------------------------------------------------------------ */
/* v0.5.4 schema: 다중 대화방 · 금고 PIN 해제 카드                        */
/* 기존 'default' 방의 대화(messages.session_id='default')는 그대로 둔다.  */
/* PIN 원문은 어디에도 저장하지 않는다.                                    */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS vault_unlock_requests (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  service    TEXT,
  login_url  TEXT,
  vault_id   TEXT,
  intent     TEXT,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_unlock_requests ON vault_unlock_requests(session_id, created_at DESC);
`);

/* ------------------------------------------------------------------ */
/* v0.5.5 schema: 파일함(saved_files)                                    */
/* 채팅 첨부(chat_attachments)와 별도로 브라우저 화면·AI 결과물을 등록한다. */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS saved_files (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'other',
  source     TEXT NOT NULL DEFAULT 'agent',
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_files_path ON saved_files(path);
CREATE INDEX IF NOT EXISTS idx_saved_files_created ON saved_files(created_at DESC);
`);

// 예전 대화가 있는데 방 목록이 비어 있으면 'default' 방을 만들어 준다.
{
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO chat_sessions(id, title, created_at, updated_at) VALUES(?,?,?,?)').run(
    'default',
    '첫 대화',
    now,
    now
  );
  // 메시지가 있는데 방 목록에 없는 세션이 있으면 제목을 첫 메시지로 잡아 만든다.
  const orphans = db
    .prepare(
      `SELECT m.session_id AS id, MIN(m.id) AS first_id, MAX(m.created_at) AS last_at
       FROM messages m LEFT JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.id IS NULL GROUP BY m.session_id`
    )
    .all() as { id: string; first_id: number; last_at: string }[];
  for (const row of orphans) {
    const first = db.prepare('SELECT content FROM messages WHERE id = ?').get(row.first_id) as { content: string } | undefined;
    const title = (first?.content || '대화').replace(/\s+/g, ' ').trim().slice(0, 40) || '대화';
    db.prepare('INSERT OR IGNORE INTO chat_sessions(id, title, created_at, updated_at) VALUES(?,?,?,?)').run(
      row.id,
      title,
      row.last_at || now,
      row.last_at || now
    );
  }
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
