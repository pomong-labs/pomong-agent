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

/* v0.6.6: 나만의 지침 도구(커스텀 스킬) */
/* v0.7.1: mode('prompt'|'workflow')·steps_json — 기존 프롬프트 스킬은 그대로 호환된다. */
CREATE TABLE IF NOT EXISTS custom_skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  keywords     TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  always_on    INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  mode         TEXT NOT NULL DEFAULT 'prompt',
  steps_json   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
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
  // v0.6.3: 특정 메시지에 대한 답장(인용) — 원본 메시지 id
  if (!msgCols.has('reply_to_id')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER');
}

{
  // v0.5.0: 금고 다중 계정 — 기본 계정 표시
  const vaultCols = columnsOf('vault_items');
  if (!vaultCols.has('is_default')) db.exec('ALTER TABLE vault_items ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
}

{
  // v0.7.1: 커스텀 도구 확장 — 단계별 워크플로우(기존 'prompt' 행은 기본값으로 그대로 남는다)
  const skillCols = columnsOf('custom_skills');
  if (!skillCols.has('mode')) db.exec("ALTER TABLE custom_skills ADD COLUMN mode TEXT NOT NULL DEFAULT 'prompt'");
  if (!skillCols.has('steps_json')) db.exec("ALTER TABLE custom_skills ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]'");
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

{
  // v0.7.1: 브라우저가 2단계 인증·캡차 화면에 머무는 동안 로그인 카드를 다시 띄우지 않게 기록한다.
  const browserCols = columnsOf('browser_sessions');
  if (!browserCols.has('verification')) db.exec('ALTER TABLE browser_sessions ADD COLUMN verification TEXT');
  if (!browserCols.has('verification_at')) db.exec('ALTER TABLE browser_sessions ADD COLUMN verification_at TEXT');
}

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

{
  // v0.6.5: 첨부 파일(PDF)에서 뽑아 둔 본문 텍스트 캐시.
  //   NULL = 아직 추출 안 함, '' = 추출했지만 글자가 없음(스캔본 등)
  const attachCols = columnsOf('chat_attachments');
  if (!attachCols.has('text_content')) db.exec('ALTER TABLE chat_attachments ADD COLUMN text_content TEXT');
}


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
/* v0.6.0 schema: 과거 대화 전체 검색(FTS5) · 서버 감시 알림              */
/* messages 테이블은 그대로 두고 검색 인덱스만 더한다.                    */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  message_id UNINDEXED,
  role UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS monitor_alerts (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'warning',
  title         TEXT NOT NULL,
  detail        TEXT,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  notified_at   TEXT,
  cooldown_until TEXT,
  notify_count  INTEGER NOT NULL DEFAULT 0,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_monitor_alerts_kind ON monitor_alerts(kind, last_seen DESC);

CREATE TABLE IF NOT EXISTS monitor_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/**
 * 새로 들어오는 메시지를 검색 인덱스에 자동으로 넣고 지운다.
 * (앱이 만드는 모든 경로가 messages INSERT/ DELETE 를 거치므로 트리거가 가장 안전하다)
 */
db.exec(`
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, session_id, message_id, role, created_at)
  VALUES (new.id, new.content, new.session_id, new.id, new.role, new.created_at);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;
`);

// 기존 대화 백필(한 번만, 인덱스가 비어 있을 때)
{
  const indexed = (db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as { n: number }).n;
  const total = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  if (total > indexed) {
    try {
      db.exec(`
        INSERT INTO messages_fts(rowid, content, session_id, message_id, role, created_at)
        SELECT m.id, m.content, m.session_id, m.id, m.role, m.created_at
        FROM messages m
        WHERE m.id NOT IN (SELECT rowid FROM messages_fts)
      `);
    } catch {
      /* 백필 실패는 앱 동작을 막지 않는다 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* v0.6.15 schema: 말풍선 이모지 리액션                                   */
/* messages 테이블은 건드리지 않고 리액션만 따로 쌓는다(같은 이모지 1번).   */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS message_reactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reactions_unique ON message_reactions(message_id, emoji);
CREATE INDEX IF NOT EXISTS idx_message_reactions_session ON message_reactions(session_id, message_id);

CREATE TRIGGER IF NOT EXISTS messages_reactions_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_reactions WHERE message_id = old.id;
END;
`);

/* ------------------------------------------------------------------ */
/* v0.6.16 schema: D-Day 카운터 · 택배 변동 추적                          */
/* 기존 테이블은 그대로 두고 새 테이블만 더한다.                          */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS ddays (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  target_date   TEXT NOT NULL,
  repeat_yearly INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ddays_date ON ddays(target_date);

CREATE TABLE IF NOT EXISTS parcel_watches (
  id              TEXT PRIMARY KEY,
  carrier         TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  label           TEXT,
  session_id      TEXT NOT NULL DEFAULT 'default',
  interval_min    INTEGER NOT NULL DEFAULT 20,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_state      TEXT,
  last_state_text TEXT,
  last_event_time TEXT,
  last_location   TEXT,
  last_summary    TEXT,
  last_checked_at TEXT,
  last_notified_at TEXT,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  next_check_at   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_parcel_watches_number ON parcel_watches(carrier, tracking_number);
CREATE INDEX IF NOT EXISTS idx_parcel_watches_due ON parcel_watches(enabled, next_check_at);
`);

/* ------------------------------------------------------------------ */
/* v0.6.18 schema: 민감 작업 승인 카드 (Human-in-the-Loop)                 */
/* 도구를 실행하기 전에 대기 상태로 남겨 두고, 사용자가 승인할 때 실행한다. */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS pending_approvals (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool       TEXT NOT NULL,
  args       TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT,
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  result     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_session ON pending_approvals(session_id, status, created_at DESC);
`);

/* ------------------------------------------------------------------ */
/* v0.7.0 schema: 실행 트레이스(토큰·비용) · 스텝 체크포인트(중단 복구)      */
/* 기존 대화·설정은 건드리지 않고 새 테이블만 더한다.                       */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS agent_traces (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  turn_id        TEXT NOT NULL,
  user_prompt    TEXT,
  provider       TEXT,
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'running',
  steps          INTEGER NOT NULL DEFAULT 0,
  tools          TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  cost_krw       REAL NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  escalated      INTEGER NOT NULL DEFAULT 0,
  loop_breaks    INTEGER NOT NULL DEFAULT 0,
  compacted      INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     TEXT NOT NULL,
  ended_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_traces_created ON agent_traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_traces_session ON agent_traces(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_trace_steps (
  id             TEXT PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  seq            INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL DEFAULT 'model',
  provider       TEXT,
  model          TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  tools          TEXT,
  escalated      INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_trace_steps ON agent_trace_steps(trace_id, seq);

CREATE TABLE IF NOT EXISTS agent_checkpoints (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  step         INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'running',
  provider     TEXT,
  model        TEXT,
  user_prompt  TEXT,
  conversation TEXT,
  tools_used   TEXT,
  done_tools   TEXT,
  reply        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_turn ON agent_checkpoints(turn_id, step DESC);
CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session ON agent_checkpoints(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_status ON agent_checkpoints(status, updated_at DESC);
`);

/* ------------------------------------------------------------------ */
/* v0.7.1 schema: 기억 최신화(대체·고정) · 기억 그래프 연결               */
/* 기존 memories 행은 지우지 않고 컬럼만 더한다(무손실).                  */
/* ------------------------------------------------------------------ */

{
  const memoryCols = columnsOf('memories');
  // 같은 주제의 새 기억이 들어오면 옛 기억을 superseded_by 로 가리킨다(행은 보존).
  if (!memoryCols.has('superseded_by')) db.exec('ALTER TABLE memories ADD COLUMN superseded_by TEXT');
  // 사용자가 '중요 고정'한 기억 — 매 대화 프롬프트에 항상 들어간다.
  if (!memoryCols.has('pinned')) db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  // 검색·그래프에 쓰는 키워드 태그(JSON 배열). 비어 있으면 본문에서 다시 뽑는다.
  if (!memoryCols.has('tags_json')) db.exec("ALTER TABLE memories ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by, importance DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned, importance DESC)');
}

db.exec(`
CREATE TABLE IF NOT EXISTS memory_links (
  a_id       TEXT NOT NULL,
  b_id       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (a_id, b_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_links_b ON memory_links(b_id);
`);

/* ------------------------------------------------------------------ */
/* v0.7.2 schema: 에이전트 명함(Agent Card) · 게스트 대화                 */
/* 기존 테이블은 건드리지 않고 새 테이블만 더한다(data/ 무손실).            */
/* 게스트 대화에는 주인 대화(messages)를 절대 섞지 않는다.                 */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS agent_cards (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL,
  purpose              TEXT NOT NULL DEFAULT 'intro',
  bio_text             TEXT NOT NULL DEFAULT '',
  system_guide         TEXT NOT NULL DEFAULT '',
  quick_prompts_json   TEXT NOT NULL DEFAULT '[]',
  collect_fields_json  TEXT NOT NULL DEFAULT '[]',
  custom_domain        TEXT,
  pin_hash             TEXT,
  max_turns_per_session INTEGER NOT NULL DEFAULT 20,
  daily_limit          INTEGER NOT NULL DEFAULT 100,
  daily_count          INTEGER NOT NULL DEFAULT 0,
  daily_date           TEXT,
  model_override       TEXT,
  expires_at           TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_cards_enabled ON agent_cards(enabled, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_cards_domain ON agent_cards(custom_domain);

CREATE TABLE IF NOT EXISTS guest_sessions (
  id               TEXT PRIMARY KEY,
  card_id          TEXT NOT NULL,
  visitor_name     TEXT,
  visitor_contact  TEXT,
  ip_hash          TEXT,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  blocked_count    INTEGER NOT NULL DEFAULT 0,
  summary_text     TEXT,
  structured_json  TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_card ON guest_sessions(card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_ip ON guest_sessions(ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS guest_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guest_messages_session ON guest_messages(session_id, id);
`);

{
  // 초기 설계안에서 빠졌던 열을 더해도 기존 행은 그대로 남는다(무손실).
  const cardCols = columnsOf('agent_cards');
  if (!cardCols.has('model_override')) db.exec('ALTER TABLE agent_cards ADD COLUMN model_override TEXT');
  if (!cardCols.has('daily_date')) db.exec('ALTER TABLE agent_cards ADD COLUMN daily_date TEXT');
  if (!cardCols.has('custom_domain')) db.exec('ALTER TABLE agent_cards ADD COLUMN custom_domain TEXT');
  const sessionCols = columnsOf('guest_sessions');
  if (!sessionCols.has('blocked_count')) db.exec('ALTER TABLE guest_sessions ADD COLUMN blocked_count INTEGER NOT NULL DEFAULT 0');
  db.exec('DELETE FROM guest_messages WHERE session_id NOT IN (SELECT id FROM guest_sessions)');
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
