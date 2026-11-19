import crypto from 'node:crypto';
import { db } from './db';
import { publish } from './events';

/**
 * 금고 PIN 해제 카드 (v0.5.4)
 *
 * 금고가 잠겨 있으면 AI가 로그인·자동 입력을 이어갈 수 없다. 예전에는 "금고 탭에서
 * PIN을 풀어 주세요"라고 말로만 안내했는데, 이제 채팅 화면에 카드를 띄우고
 * 사용자가 카드에 PIN을 넣으면 서버가 검증 → 잠금 해제 → 하던 일을 이어서 한다.
 *
 * PIN 원문은 이 테이블·로그·프롬프트·SSE 어디에도 저장/전송하지 않는다.
 * 카드에는 '무엇을 하려다 잠겼는지'(intent)만 남긴다.
 */

export type VaultUnlockStatus = 'pending' | 'unlocked' | 'cancelled';

export interface VaultUnlockRequestView {
  id: string;
  sessionId: string;
  service: string | null;
  loginUrl: string | null;
  vaultId: string | null;
  intent: string | null;
  note: string | null;
  status: VaultUnlockStatus;
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  session_id: string;
  service: string | null;
  login_url: string | null;
  vault_id: string | null;
  intent: string | null;
  note: string | null;
  status: string;
  message_id: number | null;
  created_at: string;
  updated_at: string;
}

function toView(row: Row): VaultUnlockRequestView {
  return {
    id: row.id,
    sessionId: row.session_id,
    service: row.service,
    loginUrl: row.login_url,
    vaultId: row.vault_id,
    intent: row.intent,
    note: row.note,
    status: row.status as VaultUnlockStatus,
    messageId: row.message_id === null ? null : Number(row.message_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function create(input: {
  sessionId: string;
  service?: string | null;
  loginUrl?: string | null;
  vaultId?: string | null;
  intent?: string | null;
  note?: string | null;
}): VaultUnlockRequestView {
  // 같은 방에 대기 중인 카드가 있으면 새로 만들지 않고 그것을 쓴다.
  const existing = db
    .prepare("SELECT * FROM vault_unlock_requests WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(input.sessionId) as Row | undefined;
  if (existing) {
    db.prepare('UPDATE vault_unlock_requests SET service = ?, login_url = ?, vault_id = ?, intent = ?, note = ?, updated_at = ? WHERE id = ?').run(
      input.service ?? existing.service,
      input.loginUrl ?? existing.login_url,
      input.vaultId ?? existing.vault_id,
      input.intent ?? existing.intent,
      input.note ?? existing.note,
      new Date().toISOString(),
      existing.id
    );
    const view = get(existing.id) as VaultUnlockRequestView;
    publish({ type: 'vault_unlock_request', title: '금고 PIN 입력 요청', body: '', data: { request: view } });
    return view;
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO vault_unlock_requests(id, session_id, service, login_url, vault_id, intent, note, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(
    id,
    input.sessionId,
    input.service?.slice(0, 80) ?? null,
    input.loginUrl?.slice(0, 400) ?? null,
    input.vaultId ?? null,
    input.intent?.slice(0, 400) ?? null,
    input.note?.slice(0, 300) ?? null,
    'pending',
    now,
    now
  );
  // 방마다 대기 카드는 하나만 남긴다.
  const stale = db
    .prepare("SELECT id FROM vault_unlock_requests WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT -1 OFFSET 1")
    .all(input.sessionId) as { id: string }[];
  for (const row of stale) {
    db.prepare("UPDATE vault_unlock_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, row.id);
  }
  const view = get(id) as VaultUnlockRequestView;
  publish({ type: 'vault_unlock_request', title: '금고 PIN 입력 요청', body: '', data: { request: view } });
  return view;
}

export function get(id: string): VaultUnlockRequestView | null {
  const row = db.prepare('SELECT * FROM vault_unlock_requests WHERE id = ?').get(id) as Row | undefined;
  return row ? toView(row) : null;
}

export function listForSession(sessionId: string): VaultUnlockRequestView[] {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM vault_unlock_requests
       WHERE session_id = ? AND status IN ('pending','unlocked') AND created_at >= ?
       ORDER BY created_at ASC LIMIT 20`
    )
    .all(sessionId, since) as Row[];
  return rows.map(toView);
}

export function setStatus(id: string, status: VaultUnlockStatus): VaultUnlockRequestView | null {
  db.prepare('UPDATE vault_unlock_requests SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    id
  );
  const view = get(id);
  if (view) publish({ type: 'vault_unlock_request', title: '금고 PIN 입력 카드', body: '', data: { request: view } });
  return view;
}

/** 이번 턴에 만든 카드를 AI 답변 말풍선에 붙인다(새로고침해도 같은 자리). */
export function linkPendingToMessage(sessionId: string, messageId: number): void {
  const pending = db
    .prepare("SELECT id FROM vault_unlock_requests WHERE session_id = ? AND message_id IS NULL AND status = 'pending'")
    .all(sessionId) as { id: string }[];
  db.prepare(
    "UPDATE vault_unlock_requests SET message_id = ? WHERE session_id = ? AND message_id IS NULL AND status = 'pending'"
  ).run(messageId, sessionId);
  for (const row of pending) {
    const view = get(row.id);
    if (view) publish({ type: 'vault_unlock_request', title: '금고 PIN 입력 카드', body: '', data: { request: view } });
  }
}
