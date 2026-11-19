import crypto from 'node:crypto';
import { db } from './db';

/**
 * 다중 대화방 (v0.5.4)
 *
 * 예전에는 대화가 `session_id = 'default'` 하나뿐이었다.
 * 이제 방 목록(chat_sessions)을 두고, 방마다 messages.session_id 로 대화를 나눈다.
 * 기존 'default' 방과 그 대화는 손대지 않고 그대로 보존한다.
 */

export interface ChatSessionView {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  isDefault: boolean;
}

interface ChatSessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: number;
}

function toView(row: ChatSessionRow): ChatSessionView {
  const stat = db
    .prepare('SELECT COUNT(*) AS n, MAX(id) AS last FROM messages WHERE session_id = ?')
    .get(row.id) as { n: number; last: number | null };
  let preview = '';
  if (stat.last) {
    const last = db.prepare('SELECT role, content FROM messages WHERE id = ?').get(stat.last) as
      | { role: string; content: string }
      | undefined;
    preview = (last?.content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(stat.n) || 0,
    preview,
    isDefault: row.id === 'default',
  };
}

export function listSessions(): ChatSessionView[] {
  const rows = db
    .prepare('SELECT * FROM chat_sessions WHERE archived = 0 ORDER BY updated_at DESC LIMIT 100')
    .all() as ChatSessionRow[];
  const views = rows.map(toView);
  // 'default' 방은 항상 목록에 남긴다(대화가 없어도 첫 방).
  if (!views.some((v) => v.id === 'default')) {
    const def = db.prepare("SELECT * FROM chat_sessions WHERE id = 'default'").get() as ChatSessionRow | undefined;
    if (def) views.push(toView(def));
  }
  return views;
}

export function getSession(id: string): ChatSessionView | null {
  const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as ChatSessionRow | undefined;
  return row ? toView(row) : null;
}

export function ensureSession(id: string): ChatSessionView {
  const existing = getSession(id);
  if (existing) return existing;
  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO chat_sessions(id, title, created_at, updated_at) VALUES(?,?,?,?)').run(
    id,
    '새 대화',
    now,
    now
  );
  return getSession(id) as ChatSessionView;
}

/** 새 방. 제목을 주지 않으면 '새 대화 N' 으로 짓는다. */
export function createSession(title?: string): ChatSessionView {
  const id = crypto.randomUUID();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get() as { n: number }).n;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO chat_sessions(id, title, created_at, updated_at) VALUES(?,?,?,?)').run(
    id,
    (title || `새 대화 ${count}`).slice(0, 60),
    now,
    now
  );
  return getSession(id) as ChatSessionView;
}

export function touchSession(id: string, title?: string | null): void {
  const now = new Date().toISOString();
  const exists = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(id);
  if (!exists) {
    db.prepare('INSERT OR IGNORE INTO chat_sessions(id, title, created_at, updated_at) VALUES(?,?,?,?)').run(
      id,
      (title || '새 대화').slice(0, 60),
      now,
      now
    );
    return;
  }
  if (title) {
    db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(title.slice(0, 60), now, id);
  } else {
    db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, id);
  }
}

/** 방 제목 바꾸기 */
export function renameSession(id: string, title: string): ChatSessionView | null {
  const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) throw new Error('방 이름을 입력해 주세요.');
  db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(
    clean,
    new Date().toISOString(),
    id
  );
  return getSession(id);
}

/** 방과 그 대화를 지운다. 'default' 방은 지우지 않고 비우기만 한다. */
export function deleteSession(id: string): { deletedMessages: number; keptDefault: boolean } {
  if (id === 'default') {
    const info = db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    return { deletedMessages: info.changes, keptDefault: true };
  }
  const info = db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM task_runs WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM login_requests WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM vault_unlock_requests WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  return { deletedMessages: info.changes, keptDefault: false };
}

/** 첫 사용자 메시지로 방 제목을 자동으로 붙인다(제목을 직접 바꾼 방은 건드리지 않는다). */
export function autoTitle(sessionId: string, text: string): void {
  const row = db.prepare('SELECT title FROM chat_sessions WHERE id = ?').get(sessionId) as
    | { title: string }
    | undefined;
  if (!row) {
    ensureSession(sessionId);
  } else if (!/^새 대화/.test(row.title) && row.title !== '첫 대화') {
    return;
  }
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^\[[^\]]*\]\s*/g, '')
    .trim()
    .slice(0, 34);
  if (!clean) return;
  db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(clean, sessionId);
}
