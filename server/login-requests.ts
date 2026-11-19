import crypto from 'node:crypto';
import { db } from './db';
import { publish } from './events';
import { findServiceInText } from './services';

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

/** 이번 턴에 만든 카드를 AI 답변 말풍선에 붙인다(새로고침해도 같은 자리에 보이게). */export function linkPendingToMessage(sessionId: string, messageId: number): void {
  const pending = db
    .prepare("SELECT id FROM login_requests WHERE session_id = ? AND message_id IS NULL AND status = 'pending'")
    .all(sessionId) as { id: string }[];
  db.prepare(
    "UPDATE login_requests SET message_id = ? WHERE session_id = ? AND message_id IS NULL AND status = 'pending'"
  ).run(messageId, sessionId);
  // v0.5.3: 말풍선에 붙은 사실을 화면에 바로 알린다(새로고침 없이 카드가 제자리에 뜨게).
  for (const row of pending) {
    const view = get(row.id);
    if (view) publish({ type: 'login_request', title: `${view.service} 로그인 카드`, body: '', data: { request: view } });
  }
}

/** 이 방에서 since 이후에 만든 대기 카드를 모두 취소한다(중복 카드 정리용 · v0.6.1). */
export function cancelPendingSince(sessionId: string, sinceIso: string, service?: string | null): number {
  const rows = db
    .prepare("SELECT id, service FROM login_requests WHERE session_id = ? AND status = 'pending' AND created_at >= ?")
    .all(sessionId, sinceIso) as { id: string; service: string }[];
  let cancelled = 0;
  for (const row of rows) {
    if (service && row.service.toLowerCase() !== service.toLowerCase()) continue;
    setStatus(row.id, 'cancelled');
    cancelled += 1;
  }
  return cancelled;
}

/**
 * 서버 로그인 카드 안전장치 (v0.5.3)
 *
 * 가벼운 모델이 `vault_find_for_site`만 부르고 `vault_request_login`을 빠뜨린 채
 * "아래 로그인 카드에 입력해 주세요"라고 말하는 경우(IMG_3586)를 서버가 바로잡는다.
 * 금고에 계정이 없었거나 답변에서 카드를 언급했는데 이번 턴에 카드가 없으면
 * 서비스 카탈로그로 카드를 직접 만들고, 필요하면 답변 끝에 안내 문장을 붙인다.
 */
export function ensureLoginCard(input: {
  sessionId: string;
  prompt: string;
  reply: string;
  vaultEmptyTerm: string | null;
  cardCreatedThisTurn: boolean;
  /** v0.6.1: 이번 턴에 금고 PIN 해제 카드가 나갔다면 로그인 카드는 만들지 않는다 */
  lockedCardThisTurn?: boolean;
  /** v0.6.1: 금고에 그 사이트 계정이 이미 있는 것으로 확인됐다면 만들지 않는다 */
  vaultHasAccount?: boolean;
}): { card: LoginRequestView | null; service: string | null; reply: string } {
  const reply = input.reply;
  if (input.cardCreatedThisTurn) return { card: null, service: null, reply };
  /**
   * v0.6.1: 금고 잠금 카드(PIN 입력)와 로그인 카드가 한 턴에 같이 나가던 문제를 막는다.
   * 금고에 계정이 있는 상황이면 사용자가 채울 것은 PIN 하나뿐이므로 로그인 카드는 만들지 않는다.
   */
  if (input.lockedCardThisTurn || input.vaultHasAccount) return { card: null, service: null, reply };
  const wantsLogin = /로그인|연동|계정|연결/.test(input.prompt);
  // '카드에 ... 입력' 문구는 금고 PIN 카드 안내("카드에 금고 PIN을 입력해 주세요")까지 걸리므로
  // 로그인 카드 문구만 참조하게 좁혔다.
  const mentionsCard = /로그인\s*카드|계정\s*정보[\s\S]{0,20}입력|아이디[·\s]*비밀번호[\s\S]{0,20}입력/.test(reply);
  if (!mentionsCard && !(input.vaultEmptyTerm && wantsLogin)) return { card: null, service: null, reply };
  const service =
    findServiceInText(input.vaultEmptyTerm || '') || findServiceInText(input.prompt) || findServiceInText(reply);
  if (!service) return { card: null, service: null, reply };
  const existing = listForSession(input.sessionId).find(
    (r) => r.status === 'pending' && r.service.toLowerCase() === service.name.toLowerCase()
  );
  const card =
    existing ||
    create({
      sessionId: input.sessionId,
      service: service.name,
      loginUrl: service.loginUrl,
      note: `${service.name} 계정을 한 번만 저장해 두면 다음부터는 제가 바로 로그인해요.`,
    });
  const finalReply = mentionsCard
    ? reply
    : `${reply.trim()}\n\n아래 카드에 계정 정보를 입력해 주시면 바로 로그인해서 이어서 진행할게요!`.trim();
  return { card, service: service.name, reply: finalReply };
}
