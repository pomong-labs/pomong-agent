import crypto from 'node:crypto';
import { db } from './db';
import { publish } from './events';

/**
 * 채팅 작업 카드 (v0.5.0)
 *
 * 한 번의 채팅 턴에서 AI가 여러 도구를 부르면, 그 턴에 연결된 '작업 카드'를 만들고
 * 각 단계(도구·요약·소요 시간)를 DB에 남기며 SSE(task.update)로 화면에 실시간 전달한다.
 */

export type TaskRunStatus = 'running' | 'done' | 'failed' | 'partial';

export interface TaskStepView {
  id: string;
  seq: number;
  tool: string;
  label: string;
  summary: string | null;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface TaskRunView {
  id: string;
  sessionId: string;
  messageId: number | null;
  title: string;
  status: TaskRunStatus;
  steps: number;
  startedAt: string;
  endedAt: string | null;
  items: TaskStepView[];
}

interface RunRow {
  id: string;
  session_id: string;
  message_id: number | null;
  title: string;
  status: string;
  steps: number;
  started_at: string;
  ended_at: string | null;
}

interface StepRow {
  id: string;
  run_id: string;
  seq: number;
  tool: string;
  label: string;
  summary: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

/** 도구 이름 → 사용자에게 보여 줄 말 */
export const TOOL_LABELS: Record<string, string> = {
  tasks_list: '할 일 확인',
  tasks_add: '할 일 추가',
  tasks_complete: '할 일 완료',
  vault_list: '금고 목록 확인',
  vault_find_for_site: '금고에서 계정 찾기',
  server_stats: '서버 상태 확인',
  weather_get: '날씨 확인',
  time_now: '시간 확인',
  browser_open: '브라우저로 페이지 열기',
  browser_snapshot: '화면 읽기',
  browser_click: '화면 클릭',
  browser_type: '입력',
  browser_extract: '본문 읽기',
  browser_screenshot: '화면 캡처',
  browser_handover: '사용자에게 화면 넘기기',
  browser_fill_vault: '금고 계정 자동 입력',
  browser_close: '브라우저 닫기',
  automation_list: '예약·워치 확인',
  job_create: '예약 만들기',
  watch_create: '워치 만들기',
  memory_save: '기억 저장',
  memory_search: '기억 찾기',
  memory_delete: '기억 삭제',
  chat_notify: '안내 말풍선',
  web_search: '웹 검색',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] || name.replace(/_/g, ' ');
}

/** 기억·브라우저·검색처럼 여러 단계가 필요한 도구인지 (카드 제목 정하기) */
function titleForTools(names: string[]): string {
  const has = (prefix: string) => names.some((n) => n.startsWith(prefix));
  if (has('browser_')) return '브라우저로 작업하는 중';
  if (has('memory_')) return '기억을 정리하는 중';
  if (has('job_') || has('watch_')) return '자동화를 설정하는 중';
  if (has('tasks_')) return '할 일을 정리하는 중';
  if (names.some((n) => n === 'weather_get')) return '날씨를 확인하는 중';
  if (names.some((n) => n === 'server_stats')) return '서버 상태를 확인하는 중';
  return '작업하는 중';
}

export function createRun(sessionId: string, title: string): TaskRunView {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO task_runs(id, session_id, title, status, steps, started_at) VALUES(?,?,?,?,0,?)'
  ).run(id, sessionId, title, 'running', now);
  // 작업 카드는 최근 300개만 보관한다.
  db.prepare(
    'DELETE FROM task_runs WHERE id IN (SELECT id FROM task_runs ORDER BY started_at DESC LIMIT -1 OFFSET 300)'
  ).run();
  const view = getRun(id) as TaskRunView;
  publish({ type: 'task', title: '작업 시작', body: title, data: { run: view } });
  return view;
}

export function getRun(id: string): TaskRunView | null {
  const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!row) return null;
  const steps = db.prepare('SELECT * FROM task_run_steps WHERE run_id = ? ORDER BY seq ASC').all(id) as StepRow[];
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id === null ? null : Number(row.message_id),
    title: row.title,
    status: row.status as TaskRunStatus,
    steps: Number(row.steps) || steps.length,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    items: steps.map((s) => ({
      id: s.id,
      seq: Number(s.seq),
      tool: s.tool,
      label: s.label,
      summary: s.summary,
      status: s.status as TaskStepView['status'],
      startedAt: s.started_at,
      endedAt: s.ended_at,
      durationMs: s.duration_ms === null ? null : Number(s.duration_ms),
    })),
  };
}

export function addStep(runId: string, tool: string): string {
  const id = crypto.randomUUID();
  const next = db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM task_run_steps WHERE run_id = ?').get(runId) as { n: number };
  const seq = Number(next.n) + 1;
  db.prepare(
    'INSERT INTO task_run_steps(id, run_id, seq, tool, label, status, started_at) VALUES(?,?,?,?,?,?,?)'
  ).run(id, runId, seq, tool, toolLabel(tool), 'running', new Date().toISOString());
  db.prepare('UPDATE task_runs SET steps = ? WHERE id = ?').run(seq, runId);
  emit(runId);
  return id;
}

export function finishStep(
  runId: string,
  stepId: string,
  patch: { summary?: string; status?: 'done' | 'failed' }
): void {
  const started = db.prepare('SELECT started_at FROM task_run_steps WHERE id = ?').get(stepId) as
    | { started_at: string }
    | undefined;
  const now = new Date();
  const duration = started ? Math.max(0, now.getTime() - new Date(started.started_at).getTime()) : null;
  db.prepare('UPDATE task_run_steps SET status = ?, summary = ?, ended_at = ?, duration_ms = ? WHERE id = ?').run(
    patch.status || 'done',
    patch.summary ? patch.summary.slice(0, 240) : null,
    now.toISOString(),
    duration,
    stepId
  );
  emit(runId);
}

/** 카드 제목은 첫 도구가 정해질 때 한 번 바꾼다. */
export function retitleRun(runId: string, tool: string): void {
  const row = db.prepare('SELECT title FROM task_runs WHERE id = ?').get(runId) as { title: string } | undefined;
  if (!row || row.title !== '작업하는 중') return;
  const title = titleForTools([tool]);
  if (title === row.title) return;
  db.prepare('UPDATE task_runs SET title = ? WHERE id = ?').run(title, runId);
}

export function finishRun(runId: string, status: TaskRunStatus, messageId?: number): TaskRunView | null {
  db.prepare('UPDATE task_runs SET status = ?, ended_at = ?, message_id = COALESCE(?, message_id) WHERE id = ?').run(
    status,
    new Date().toISOString(),
    messageId === undefined ? null : messageId,
    runId
  );
  const view = getRun(runId);
  if (view) publish({ type: 'task', title: status === 'done' ? '작업 완료' : '작업 종료', body: view.title, data: { run: view } });
  return view;
}

function emit(runId: string): void {
  const view = getRun(runId);
  if (view) publish({ type: 'task', title: view.title, body: '', data: { run: view } });
}

/** 화면이 처음 열릴 때 지난 작업 카드를 메시지와 함께 보여 주기 위한 목록 */
export function listRuns(sessionId: string, limit = 40): TaskRunView[] {
  const rows = db
    .prepare('SELECT id FROM task_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(sessionId, limit) as { id: string }[];
  return rows.map((r) => getRun(r.id)).filter((r): r is TaskRunView => Boolean(r));
}

/** 내용을 한 줄 요약으로 (도구 결과를 카드에 그대로 싣지 않는다) */
export function summarizeResult(content: string): string {
  const clean = String(content || '')
    .replace(/<untrusted>|<\/untrusted>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const first = clean.split(/(?<=[.!?。])\s/)[0] || clean;
  return first.slice(0, 90);
}
