import { randomUUID } from 'node:crypto';
import { addLog, db } from './db';

/**
 * v0.6.18: 민감 작업 직전 실시간 승인 카드 (Human-in-the-Loop)
 *
 * 도커 컨테이너의 상태를 바꾸는(stop/restart/start/pause/unpause) 도구는
 * 되돌리기 어렵다. 모델이 그 도구를 부르면 **실행하지 않고** 승인 요청을 DB에 남기고
 * 채팅 턴을 끝낸다. 사용자가 [승인]을 누르면 그때 실제로 실행하고 결과를 말풍선으로 남긴다.
 *
 * 승인 대기·실행은 모두 서버가 직접 한다(모델이 [승인]을 대신 누를 수 없다).
 */

export type ApprovalStatus = 'pending' | 'approved' | 'cancelled' | 'expired' | 'failed';

export interface ApprovalRow {
  id: string;
  session_id: string;
  tool: string;
  args: string;
  title: string;
  detail: string | null;
  reason: string | null;
  status: ApprovalStatus;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalView {
  id: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  title: string;
  detail: string;
  reason: string;
  status: ApprovalStatus;
  result: string | null;
  createdAt: string;
}

/** 승인 카드를 띄워야 하는 도구 호출인지 (지금은 도커 상태 변경) */
export interface SensitiveCall {
  title: string;
  detail: string;
  reason: string;
}

const DOCKER_MUTATIONS: Record<string, string> = {
  stop: '중지',
  restart: '재시작',
  start: '시작',
  pause: '일시정지',
  unpause: '일시정지 해제',
};

export function sensitiveToolCall(name: string, args: Record<string, unknown>): SensitiveCall | null {
  if (name !== 'manage_docker') return null;
  const action = String(args?.action || '').trim().toLowerCase();
  const label = DOCKER_MUTATIONS[action];
  if (!label) return null;
  const container = String(args?.container || '').trim();
  if (!container) return null;
  return {
    title: `도커 컨테이너 ${label}`,
    detail: `컨테이너 '${container}'을(를) ${label}합니다.`,
    reason: '컨테이너 상태를 바꾸는 작업은 되돌리기 어려울 수 있어 실행 전에 확인을 받습니다.',
  };
}

function toView(row: ApprovalRow): ApprovalView {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(row.args) as Record<string, unknown>;
  } catch {
    args = {};
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    tool: row.tool,
    args,
    title: row.title,
    detail: row.detail || '',
    reason: row.reason || '',
    status: row.status,
    result: row.result,
    createdAt: row.created_at,
  };
}

/** 10분이 지난 대기 요청은 스스로 만료시킨다(지난 카드를 눌러 엉뚱한 일이 일어나지 않게). */
function expireStale(): void {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE pending_approvals SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at < ?"
  ).run(new Date().toISOString(), cutoff);
}

export function createApproval(input: {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  title: string;
  detail: string;
  reason: string;
}): ApprovalView {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO pending_approvals(id, session_id, tool, args, title, detail, reason, status, result, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    id,
    input.sessionId,
    input.tool,
    JSON.stringify(input.args || {}),
    input.title,
    input.detail,
    input.reason,
    'pending',
    null,
    now,
    now
  );
  addLog('warn', `승인 대기 · ${input.title}`);
  return toView(getRow(id) as ApprovalRow);
}

function getRow(id: string): ApprovalRow | undefined {
  return db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
}

export function getApproval(id: string): ApprovalView | null {
  const row = getRow(id);
  return row ? toView(row) : null;
}

/** 채팅 화면에 붙일 대기 카드(최근 것부터) */
export function listForSession(sessionId: string): ApprovalView[] {
  expireStale();
  const rows = db
    .prepare("SELECT * FROM pending_approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 5")
    .all(sessionId) as ApprovalRow[];
  return rows.map(toView);
}

function setStatus(id: string, status: ApprovalStatus, result: string | null): void {
  db.prepare('UPDATE pending_approvals SET status = ?, result = ?, updated_at = ? WHERE id = ?').run(
    status,
    result,
    new Date().toISOString(),
    id
  );
}

/** 채팅에 한 줄 남긴다(승인·취소 결과). */
function postMessage(sessionId: string, content: string, meta: Record<string, unknown>): number {
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO messages(session_id, role, content, meta, created_at) VALUES(?,?,?,?,?)')
    .run(sessionId, 'assistant', content, JSON.stringify(meta), now);
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  return Number(info.lastInsertRowid);
}

/**
 * [승인] — 대기 중이던 도구를 실제로 실행한다.
 * 두 번 눌러도 한 번만 실행되도록 상태를 조건부로 바꾼다.
 */
export async function approve(id: string): Promise<{ ok: boolean; message: string }> {
  const row = getRow(id);
  if (!row) return { ok: false, message: '승인 요청을 찾지 못했어요.' };
  if (row.status !== 'pending') {
    return { ok: false, message: row.status === 'approved' ? '이미 승인해서 실행했어요.' : '이미 취소되었거나 만료된 요청이에요.' };
  }
  const claimed = db
    .prepare("UPDATE pending_approvals SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), id);
  if (!claimed.changes) return { ok: false, message: '이미 처리된 요청이에요.' };

  const risk = sensitiveToolCall(row.tool, JSON.parse(row.args || '{}'));
  if (!risk) {
    setStatus(id, 'failed', '허용되지 않은 도구');
    postMessage(row.session_id, '승인 요청이 만료되어 실행하지 않았어요. 다시 부탁해 주세요.', { type: 'approval_result', approvalId: id, status: 'failed' });
    return { ok: false, message: '승인 대기 중이던 작업이 더 이상 유효하지 않아요. 다시 부탁해 주세요.' };
  }

  const { runTool } = await import('./tools');
  const args = JSON.parse(row.args || '{}') as Record<string, unknown>;
  try {
    const output = await runTool(row.tool, args, { session: row.session_id, userRequest: '사용자가 승인 카드에서 승인함' });
    const content = output.content.trim();
    const text = `▶ 승인한 작업을 실행했어요.\n\n${content}`;
    setStatus(id, 'approved', content.slice(0, 4000));
    postMessage(row.session_id, text, { type: 'approval_result', approvalId: id, status: 'approved', tools: [row.tool] });
    addLog('success', `승인 실행 · ${risk.title}`);
    return { ok: true, message: text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(id, 'failed', message.slice(0, 4000));
    postMessage(row.session_id, `승인한 작업을 실행하다 실패했어요. (${message.slice(0, 200)})`, {
      type: 'approval_result',
      approvalId: id,
      status: 'failed',
    });
    addLog('error', `승인 실행 실패 · ${message.slice(0, 160)}`);
    return { ok: false, message };
  }
}

/** [취소] — 실행하지 않고 접는다. */
export function cancel(id: string): { ok: boolean; message: string } {
  const row = getRow(id);
  if (!row) return { ok: false, message: '승인 요청을 찾지 못했어요.' };
  if (row.status !== 'pending') return { ok: false, message: '이미 처리된 요청이에요.' };
  const claimed = db
    .prepare("UPDATE pending_approvals SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), id);
  if (!claimed.changes) return { ok: false, message: '이미 처리된 요청이에요.' };
  postMessage(row.session_id, '알겠어요, 그 작업은 실행하지 않았어요.', { type: 'approval_result', approvalId: id, status: 'cancelled' });
  addLog('info', `승인 취소 · ${row.title}`);
  return { ok: true, message: '작업을 취소했어요.' };
}
