/**
 * v0.6.15 — 말풍선 이모지 리액션
 *
 * 비서(AI)가 상황에 맞는 이모지를 사용자의 말풍선에 하나 붙인다.
 *   · react_to_message 도구 → 이 모듈 → message_reactions 테이블
 *   · 채팅 목록(GET /api/chat/messages)과 SSE(chat_reaction)로 화면에 바로 내려간다.
 *
 * 규칙
 *   · 한 말풍선에 최대 3개까지(같은 이모지는 한 번만)
 *   · 이모지 하나만 허용한다(문장·기호 남용 방지)
 *   · 대상은 그 방의 메시지여야 한다(다른 방 말풍선에 달 수 없음)
 */

import { addLog, db } from './db';

export const MAX_REACTIONS_PER_MESSAGE = 3;

/** 도구 설명·예시로 쓰는 대표 이모지(화면에서 잘 보이는 것만) */
export const REACTION_EXAMPLES = ['🎉', '😂', '❤️', '👍', '🥹', '🙌', '🔥', '👀', '✨', '💡', '✅', '🙏'];

export interface MessageRowLite {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

/**
 * 이모지 하나인지 확인하고 정리한다.
 * ❤️(문자+변형선택자), 👍🏽(피부색), 👨‍👩‍👧(ZWJ 결합)까지 이모지 하나로 본다.
 */
export function normalizeReaction(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[\s"'`.,!?]/g, '');
  if (!cleaned || cleaned.length > 24) return null;
  const single = /^\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic}|[\ufe0e\ufe0f\u20e3\u{1F3FB}-\u{1F3FF}])*$/u;
  return single.test(cleaned) ? cleaned : null;
}

/** 이 방에서 가장 최근 사용자 말풍선 */
export function latestUserMessage(sessionId: string): MessageRowLite | null {
  const row = db
    .prepare(
      `SELECT id, role, content, created_at FROM messages
        WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId) as MessageRowLite | undefined;
  return row || null;
}

/** 본문 일부로 이 방의 말풍선을 찾는다(가장 최근 것). */
export function findMessageByQuery(sessionId: string, query: string): MessageRowLite | null {
  const text = String(query || '').trim();
  if (!text) return null;
  const row = db
    .prepare(
      `SELECT id, role, content, created_at FROM messages
        WHERE session_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId, `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`) as MessageRowLite | undefined;
  return row || null;
}

/** 리액션을 달 대상 말풍선을 정한다(id → 본문 검색 → 방금 받은 사용자 메시지). */
export function resolveTarget(
  sessionId: string,
  input: { messageId?: unknown; query?: unknown }
): { row: MessageRowLite } | { error: string } {
  const id = Number(input.messageId);
  if (Number.isFinite(id) && id > 0) {
    const row = db
      .prepare('SELECT id, role, content, created_at FROM messages WHERE id = ? AND session_id = ?')
      .get(id, sessionId) as MessageRowLite | undefined;
    if (!row) return { error: `이 대화방에서 ${id}번 메시지를 찾지 못했습니다.` };
    return { row };
  }
  const query = String(input.query || '').trim();
  if (query) {
    const found = findMessageByQuery(sessionId, query);
    if (!found) return { error: `'${query}'가 들어간 말풍선을 찾지 못했습니다.` };
    return { row: found };
  }
  const latest = latestUserMessage(sessionId);
  if (!latest) return { error: '리액션을 달 사용자 메시지가 아직 없습니다.' };
  return { row: latest };
}

export function listForMessage(messageId: number): string[] {
  const rows = db
    .prepare('SELECT emoji FROM message_reactions WHERE message_id = ? ORDER BY id ASC')
    .all(messageId) as { emoji: string }[];
  return rows.map((r) => r.emoji);
}

/** 여러 메시지의 리액션을 한 번에(대화 목록 렌더링용) */
export function listForMessages(messageIds: number[]): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  if (!messageIds.length) return out;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT message_id, emoji FROM message_reactions WHERE message_id IN (${placeholders}) ORDER BY id ASC`)
    .all(...messageIds) as { message_id: number; emoji: string }[];
  for (const row of rows) (out[row.message_id] ||= []).push(row.emoji);
  return out;
}

export interface AddReactionResult {
  ok: boolean;
  messageId?: number;
  emoji?: string;
  reactions?: string[];
  error?: string;
}

/** 리액션을 저장한다. 이미 있으면 그대로 알려 준다(중복 저장 없음). */
export function addReaction(input: { sessionId: string; messageId: number; emoji: unknown }): AddReactionResult {
  const emoji = normalizeReaction(input.emoji);
  if (!emoji) {
    return {
      ok: false,
      error: `이모지 하나만 쓸 수 있습니다(예: ${REACTION_EXAMPLES.slice(0, 6).join(' ')}).`,
    };
  }
  const current = listForMessage(input.messageId);
  if (current.includes(emoji)) {
    return { ok: true, messageId: input.messageId, emoji, reactions: current };
  }
  if (current.length >= MAX_REACTIONS_PER_MESSAGE) {
    return {
      ok: false,
      messageId: input.messageId,
      reactions: current,
      error: `한 말풍선에는 리액션을 ${MAX_REACTIONS_PER_MESSAGE}개까지만 달 수 있습니다(지금: ${current.join(' ')}).`,
    };
  }
  db.prepare(
    'INSERT OR IGNORE INTO message_reactions(message_id, session_id, emoji, created_at) VALUES(?,?,?,?)'
  ).run(input.messageId, input.sessionId, emoji, new Date().toISOString());
  const reactions = listForMessage(input.messageId);
  addLog('info', `말풍선 리액션 · ${emoji} (메시지 ${input.messageId})`);
  return { ok: true, messageId: input.messageId, emoji, reactions };
}

/** 대화방을 지울 때 남은 리액션 정리(트리거가 지우지 못한 옛 행 대비) */
export function clearSession(sessionId: string): number {
  const info = db.prepare('DELETE FROM message_reactions WHERE session_id = ?').run(sessionId);
  return info.changes;
}

/** 리액션을 단 메시지 수(상태 표시·테스트용) */
export function countReactions(sessionId?: string): number {
  const row = sessionId
    ? (db.prepare('SELECT COUNT(*) AS n FROM message_reactions WHERE session_id = ?').get(sessionId) as { n: number })
    : (db.prepare('SELECT COUNT(*) AS n FROM message_reactions').get() as { n: number });
  return Number(row?.n || 0);
}
