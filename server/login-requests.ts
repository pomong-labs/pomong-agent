import crypto from 'node:crypto';
import { db } from './db';
import { publish } from './events';

/**
 * 채팅 인라인 로그인 카드 (v0.5.1)
 *
 * 금고에 계정이 없을 때 AI가 `vault_request_login` 도구를 부르면 이 모듈이
 * 로그인 요청(login_requests)을 만들고 SSE로 채팅 화면에 카드를 띄운다.
 * 사용자가 카드에 아이디/비밀번호를 넣고 [저장하고 로그인하기]를 누르면
 * 서버가 금고(vault_items)에 암호화 저장하고, AI에게 후속 턴을 붙여 브라우저
 * 로그인까지 이어서 하게 한다.
 *
 * 비밀번호 원문은 이 테이블·로그·프롬프트 어디에도 남기지 않는다.
 */

export type LoginRequestStatus = 'pending' | 'submitted' | 'cancelled';

export interface LoginRequestView {
  id: string;
  sessionId: string;
  service: string;
  loginUrl: string;
  siteHost: string | null;
  note: string | null;
  status: LoginRequestStatus;
  vaultId: string | null;
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface LoginRequestRow {
  id: string;
  session_id: string;
  service: string;
  login_url: string;
  site_host: string | null;
  note: string | null;
  status: string;
  vault_id: string | null;
  message_id: number | null;
  created_at: string;
  updated_at: string;
}

function toView(row: LoginRequestRow): LoginRequestView {
  return {
    id: row.id,
    sessionId: row.session_id,
    service: row.service,
    loginUrl: row.login_url,
    siteHost: row.site_host,
    note: row.note,
    status: row.status as LoginRequestStatus,
    vaultId: row.vault_id,
    messageId: row.message_id === null ? null : Number(row.message_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function create(input: {
  sessionId: string;
  service: string;
  loginUrl: string;
  siteHost?: string | null;
  note?: string | null;
}): LoginRequestView {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const siteHost =
    input.siteHost?.trim() || (() => {
      try {
        return new URL(input.loginUrl).host;
      } catch {
        return null;
      }
    })();
  db.prepare(
    'INSERT INTO login_requests(id, session_id, service, login_url, site_host, note, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id, input.sessionId, input.service.slice(0, 80), input.loginUrl, siteHost, input.note?.slice(0, 300) ?? null, 'pending', now, now);
  // 대기 카드는 세션당 5개까지만 남긴다(오래된 것은 취소 처리).
  const stale = db
    .prepare("SELECT id FROM login_requests WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT -1 OFFSET 5")
    .all(input.sessionId) as { id: string }[];
  for (const row of stale) {
    db.prepare("UPDATE login_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, row.id);
  }
  const view = get(id) as LoginRequestView;
  publish({ type: 'login_request', title: `${view.service} 로그인 정보 요청`, body: '', data: { request: view } });
  return view;
}

export function get(id: string): LoginRequestView | null {
  const row = db.prepare('SELECT * FROM login_requests WHERE id = ?').get(id) as LoginRequestRow | undefined;
  return row ? toView(row) : null;
}

/** 화면에 다시 그릴 카드 목록(대기 + 최근 저장 완료). */
export function listForSession(sessionId: string): LoginRequestView[] {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM login_requests
       WHERE session_id = ? AND status IN ('pending','submitted') AND created_at >= ?
       ORDER BY created_at ASC LIMIT 20`
    )
    .all(sessionId, since) as LoginRequestRow[];
  return rows.map(toView);
}

export function setStatus(id: string, status: LoginRequestStatus, patch: { vaultId?: string } = {}): LoginRequestView | null {
  const now = new Date().toISOString();
  db.prepare('UPDATE login_requests SET status = ?, vault_id = COALESCE(?, vault_id), updated_at = ? WHERE id = ?').run(
    status,
    patch.vaultId ?? null,
    now,
    id
  );
  const view = get(id);
  if (view) publish({ type: 'login_request', title: `${view.service} 로그인 카드`, body: '', data: { request: view } });
  return view;
}

/** 이번 턴에 만든 카드를 AI 답변 말풍선에 붙인다(새로고침해도 같은 자리에 보이게). */
export function linkPendingToMessage(sessionId: string, messageId: number): void {
  db.prepare(
    "UPDATE login_requests SET message_id = ? WHERE session_id = ? AND message_id IS NULL AND status = 'pending'"
  ).run(messageId, sessionId);
}
