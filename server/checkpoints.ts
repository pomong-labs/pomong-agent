import crypto from 'node:crypto';
import { addLog, db } from './db';
import type { AgentMessage } from './providers';

/**
 * v0.7.0 — 스텝 체크포인트 & 중단 복구(Resume)
 *
 * 에이전트 턴은 스텝이 많으면 몇 분씩 걸린다. 그 사이에 서버가 재시작되거나(배포·크래시),
 * 사용자가 앱을 닫거나, 연결이 끊기면 지금까지의 진행이 통째로 사라졌다.
 *
 * 그래서 **스텝이 끝날 때마다** 그 시점의 대화 스냅샷과 이미 실행한 도구 결과를 저장한다.
 *   · 서버가 다시 뜨면 이전에 'running' 이던 체크포인트를 'interrupted' 로 바꾼다.
 *   · 사용자는 채팅 화면에서 [이어서 하기]를 눌러 그 지점부터 재개할 수 있다.
 *   · 이미 실행한 도구는 **다시 실행하지 않고 저장된 결과를 재사용**한다(부작용 중복 방지).
 *
 * 사진·PDF 원본(base64)은 DB를 부풀리므로 스냅샷에서 텍스트 설명으로 바꿔 저장한다.
 */

export type CheckpointStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'approval' | 'interrupted';

export interface CheckpointSnapshot {
  sessionId: string;
  turnId: string;
  provider: string;
  model: string;
  userPrompt: string;
  step: number;
  status: CheckpointStatus;
  conversation: AgentMessage[];
  toolsUsed: string[];
  reply: string;
  /** 이미 실행한 도구 — toolCallId → 결과(재개 시 재실행 금지) */
  doneTools: Record<string, { name: string; content: string }>;
}

export interface CheckpointRecord extends CheckpointSnapshot {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResumableCheckpoint {
  id: string;
  sessionId: string;
  turnId: string;
  step: number;
  provider: string;
  model: string;
  userPrompt: string;
  toolsUsed: string[];
  status: CheckpointStatus;
  updatedAt: string;
}

/** 스냅샷 대화에서 큰 이진 파트를 걷어낸다(텍스트는 그대로). */
export function slimConversation(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.parts?.length) return message;
    const parts = message.parts.map((part) => {
      if (part.type === 'text') return part;
      if (part.type === 'image') return { type: 'text' as const, text: `[첨부 사진 · ${part.mime} · 체크포인트에는 원본을 저장하지 않음]` };
      if (part.type === 'pdf') return { type: 'text' as const, text: `[첨부 PDF · ${part.mime} · 체크포인트에는 원본을 저장하지 않음]` };
      return { type: 'text' as const, text: `[첨부 오디오 · ${part.mime} · 체크포인트에는 원본을 저장하지 않음]` };
    });
    return { ...message, parts };
  });
}

/** 대화 JSON 이 너무 커지지 않게 상한을 둔다(넘으면 앞쪽을 잘라낸다). */
const MAX_CONVERSATION_CHARS = 600_000;

/** 이미 실행한 도구 결과도 무한정 쌓지 않게 잘라 저장한다(복구에 필요한 앞부분만). */
export function slimDoneTools(
  tools: Record<string, { name: string; content: string }>
): Record<string, { name: string; content: string }> {
  const out: Record<string, { name: string; content: string }> = {};
  for (const [id, value] of Object.entries(tools)) {
    out[id] = { name: value.name, content: value.content.slice(0, 8_000) };
  }
  return out;
}

function serializeConversation(messages: AgentMessage[]): string {
  let json = JSON.stringify(slimConversation(messages));
  if (json.length > MAX_CONVERSATION_CHARS) {
    // 끝(최근)을 남기고 앞을 버린다 — 재개에 필요한 것은 최근 문맥이다.
    const keep = messages.slice(-12);
    json = JSON.stringify([
      { role: 'system', content: '[v0.7.0] 체크포인트 용량 제한으로 이전 대화 일부를 저장하지 못했습니다.' },
      ...slimConversation(keep),
    ]);
  }
  return json;
}

interface Row {
  id: string;
  session_id: string;
  turn_id: string;
  step: number;
  status: string;
  provider: string;
  model: string;
  user_prompt: string;
  conversation: string;
  tools_used: string | null;
  done_tools: string | null;
  reply: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: Row): CheckpointRecord {
  let conversation: AgentMessage[] = [];
  try {
    conversation = JSON.parse(row.conversation) as AgentMessage[];
  } catch {
    conversation = [];
  }
  let tools: string[] = [];
  try {
    tools = row.tools_used ? (JSON.parse(row.tools_used) as string[]) : [];
  } catch {
    tools = [];
  }
  let doneTools: Record<string, { name: string; content: string }> = {};
  try {
    doneTools = row.done_tools ? (JSON.parse(row.done_tools) as Record<string, { name: string; content: string }>) : {};
  } catch {
    doneTools = {};
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    step: row.step,
    status: row.status as CheckpointStatus,
    provider: row.provider,
    model: row.model,
    userPrompt: row.user_prompt,
    conversation,
    toolsUsed: tools,
    doneTools,
    reply: row.reply || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 턴 시작 시 체크포인트 하나를 만든다.
 * 같은 턴(turnId)의 이전 체크포인트가 있으면 이어서 갱신한다.
 */
export function startCheckpoint(input: CheckpointSnapshot & { id?: string }): string {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id FROM agent_checkpoints WHERE turn_id = ? ORDER BY step DESC LIMIT 1')
    .get(input.turnId) as { id: string } | undefined;
  if (existing) {
    updateCheckpoint(existing.id, { ...input, status: input.status });
    return existing.id;
  }
  const id = input.id || crypto.randomUUID();
  db.prepare(
    `INSERT INTO agent_checkpoints(id, session_id, turn_id, step, status, provider, model, user_prompt, conversation, tools_used, done_tools, reply, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    input.sessionId,
    input.turnId,
    input.step,
    input.status,
    input.provider,
    input.model,
    input.userPrompt.slice(0, 8000),
    serializeConversation(input.conversation),
    JSON.stringify(input.toolsUsed),
    JSON.stringify(slimDoneTools(input.doneTools)),
    (input.reply || '').slice(0, 4000),
    now,
    now
  );
  return id;
}

export function updateCheckpoint(id: string, patch: Partial<CheckpointSnapshot>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.step !== undefined) {
    fields.push('step = ?');
    values.push(patch.step);
  }
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.model !== undefined) {
    fields.push('model = ?');
    values.push(patch.model);
  }
  if (patch.provider !== undefined) {
    fields.push('provider = ?');
    values.push(patch.provider);
  }
  if (patch.conversation !== undefined) {
    fields.push('conversation = ?');
    values.push(serializeConversation(patch.conversation));
  }
  if (patch.toolsUsed !== undefined) {
    fields.push('tools_used = ?');
    values.push(JSON.stringify(patch.toolsUsed));
  }
  if (patch.doneTools !== undefined) {
    fields.push('done_tools = ?');
    values.push(JSON.stringify(patch.doneTools));
  }
  if (patch.reply !== undefined) {
    fields.push('reply = ?');
    values.push((patch.reply || '').slice(0, 4000));
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  db.prepare(`UPDATE agent_checkpoints SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
}

export function getCheckpoint(id: string): CheckpointRecord | null {
  const row = db.prepare('SELECT * FROM agent_checkpoints WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function latestForSession(sessionId: string): CheckpointRecord | null {
  const row = db
    .prepare('SELECT * FROM agent_checkpoints WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(sessionId) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * 이어서 할 수 있는 턴 목록 — 서버가 멈춰 'interrupted' 로 남은 것만.
 * (완료·실패·중지는 이어서 할 것이 아니다)
 */
export function listResumable(limit = 10): ResumableCheckpoint[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_checkpoints WHERE status = 'interrupted'
       GROUP BY turn_id ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as Row[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    step: row.step,
    provider: row.provider,
    model: row.model,
    userPrompt: row.user_prompt,
    toolsUsed: (() => {
      try {
        return row.tools_used ? (JSON.parse(row.tools_used) as string[]) : [];
      } catch {
        return [];
      }
    })(),
    status: row.status as CheckpointStatus,
    updatedAt: row.updated_at,
  }));
}

export function resumableForSession(sessionId: string): ResumableCheckpoint | null {
  const row = db
    .prepare(
      `SELECT * FROM agent_checkpoints WHERE session_id = ? AND status = 'interrupted'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(sessionId) as Row | undefined;
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    step: row.step,
    provider: row.provider,
    model: row.model,
    userPrompt: row.user_prompt,
    toolsUsed: (() => {
      try {
        return row.tools_used ? (JSON.parse(row.tools_used) as string[]) : [];
      } catch {
        return [];
      }
    })(),
    status: row.status as CheckpointStatus,
    updatedAt: row.updated_at,
  };
}

/**
 * 서버가 (재)시작할 때 부른다. 'running' 으로 남은 체크포인트는 진행 중에 프로세스가
 * 사라졌다는 뜻이므로 'interrupted' 로 바꿔 사용자에게 이어서 하기를 제안한다.
 */
export function markInterruptedOnBoot(): number {
  const result = db
    .prepare("UPDATE agent_checkpoints SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());
  const changed = Number(result.changes || 0);
  if (changed > 0) addLog('warn', `중단된 작업 ${changed}건을 복구 대기로 표시했습니다`);
  return changed;
}

/** 오래된 체크포인트 정리(기본 7일). 완료된 턴은 24시간 뒤 지운다. */
export function prune(keepDays = 7): number {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  const doneCutoff = new Date(Date.now() - 86_400_000).toISOString();
  const old = db
    .prepare("DELETE FROM agent_checkpoints WHERE status IN ('done','failed','cancelled','approval') AND updated_at < ?")
    .run(doneCutoff);
  const stale = db.prepare("DELETE FROM agent_checkpoints WHERE updated_at < ?").run(cutoff);
  return Number(old.changes || 0) + Number(stale.changes || 0);
}
