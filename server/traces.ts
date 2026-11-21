import crypto from 'node:crypto';
import { db, getJson, addLog } from './db';

/**
 * v0.7.0 — 실행 트레이스 · 토큰/비용 관측성(Observability)
 *
 * "이번 답변에 얼마가 들었나"를 볼 수 없으면, 비용이 새는 곳도, 느린 모델도 찾을 수 없다.
 * 턴 하나(agent_traces)와 그 안의 모델 호출 한 번(agent_trace_steps)을 따로 남긴다.
 *
 *   · 턴: 사용자 요청, 프로바이더/모델, 총 입력·출력 토큰, 예상 비용(USD·원), 소요 시간,
 *         사용한 도구, 루프 감지·압축·모델 에스컬레이션 횟수, 상태·오류
 *   · 스텝: 그 스텝의 모델, 입·출력 토큰, 비용, 소요 시간(ms), 도구 목록, 에스컬레이션 여부
 *
 * 토큰은 프로바이더가 돌려주는 usage 를 우선 쓰고, 없으면 글자 수로 추정한다.
 * 단가는 2026-11 시점의 공개 가격을 **추정치**로 넣어 두었고, 설정에서 바꿀 수 있다.
 *   settings: observability.usdKrw = 1380, observability.prices = {"모델": {"in":0.3,"out":2.5}}
 */

export interface ModelPrice {
  /** 백만 입력 토큰당 USD */
  in: number;
  /** 백만 출력 토큰당 USD */
  out: number;
}

/** 기본 추정 단가(USD / 1M tokens). 설정 observability.prices 로 덮어쓸 수 있다. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'gemini-3.8-flash': { in: 0.3, out: 2.5 },
  'gemini-3.7-flash': { in: 0.3, out: 2.5 },
  'gemini-3.6-flash': { in: 0.3, out: 2.5 },
  'gemini-3.5-flash': { in: 0.3, out: 2.5 },
  'gemini-3.1-flash-lite': { in: 0.1, out: 0.4 },
  'gemini-flash-lite-latest': { in: 0.1, out: 0.4 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'k-exaone_v2.5': { in: 0, out: 0 },
};

export const DEFAULT_USD_KRW = 1380;

export function usdKrwRate(): number {
  const value = Number(getJson<unknown>('observability.usdKrw', DEFAULT_USD_KRW));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_USD_KRW;
}

export function priceFor(model: string): ModelPrice {
  const overrides = getJson<Record<string, ModelPrice>>('observability.prices', {});
  const name = String(model || '').trim();
  const custom = overrides[name];
  if (custom && Number.isFinite(custom.in) && Number.isFinite(custom.out)) return custom;
  if (DEFAULT_PRICES[name]) return DEFAULT_PRICES[name];
  // 계열 이름으로 근사(예: gemini-3.9-flash, claude-sonnet-4-6)
  const family = Object.keys(DEFAULT_PRICES).find((key) => name.startsWith(key.split('-').slice(0, 2).join('-')));
  if (family) return DEFAULT_PRICES[family];
  if (/lite|mini|haiku|flash/i.test(name)) return { in: 0.3, out: 1.2 };
  return { in: 1, out: 3 };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): { usd: number; krw: number } {
  const price = priceFor(model);
  const usd = (Math.max(0, inputTokens) * price.in + Math.max(0, outputTokens) * price.out) / 1_000_000;
  const rounded = Math.round(usd * 1_000_000) / 1_000_000;
  return { usd: rounded, krw: Math.round(rounded * usdKrwRate() * 100) / 100 };
}

export type TraceStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'approval';

export interface TraceView {
  id: string;
  sessionId: string;
  turnId: string;
  userPrompt: string;
  provider: string;
  model: string;
  status: TraceStatus;
  steps: number;
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costKrw: number;
  durationMs: number;
  escalated: boolean;
  loopBreaks: number;
  compacted: number;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface TraceStepView {
  id: string;
  traceId: string;
  seq: number;
  kind: 'model' | 'tool';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  tools: string[];
  escalated: boolean;
  error: string | null;
  createdAt: string;
}

export interface TraceStart {
  sessionId: string;
  turnId: string;
  userPrompt: string;
  provider: string;
  model: string;
  trigger?: string;
}

interface TraceRow {
  id: string;
  session_id: string;
  turn_id: string;
  user_prompt: string;
  provider: string;
  model: string;
  status: string;
  steps: number;
  tools: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_krw: number;
  duration_ms: number;
  escalated: number;
  loop_breaks: number;
  compacted: number;
  error: string | null;
  created_at: string;
  ended_at: string | null;
}

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function rowToView(row: TraceRow): TraceView {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    userPrompt: row.user_prompt,
    provider: row.provider,
    model: row.model,
    status: row.status as TraceStatus,
    steps: row.steps,
    tools: parseStringList(row.tools),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    costKrw: row.cost_krw,
    durationMs: row.duration_ms,
    escalated: Boolean(row.escalated),
    loopBreaks: row.loop_breaks,
    compacted: row.compacted,
    error: row.error,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

export function startTrace(input: TraceStart): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_traces(id, session_id, turn_id, user_prompt, provider, model, status, steps, tools,
       input_tokens, output_tokens, cost_usd, cost_krw, duration_ms, escalated, loop_breaks, compacted, error, created_at, ended_at)
     VALUES(?,?,?,?,?,?, 'running', 0, '[]', 0, 0, 0, 0, 0, 0, 0, 0, NULL, ?, NULL)`
  ).run(id, input.sessionId, input.turnId, input.userPrompt.slice(0, 8000), input.provider, input.model, now);
  return id;
}

export interface TraceStepInput {
  traceId: string;
  seq: number;
  kind?: 'model' | 'tool';
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  tools?: string[];
  escalated?: boolean;
  error?: string | null;
}

/** 스텝 하나를 남기고, 턴 합계(토큰·비용·시간·도구)를 갱신한다. */
export function recordTraceStep(input: TraceStepInput): void {
  const model = String(input.model || '');
  const inputTokens = Math.max(0, Math.round(input.inputTokens || 0));
  const outputTokens = Math.max(0, Math.round(input.outputTokens || 0));
  const { usd } = estimateCost(model, inputTokens, outputTokens);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_trace_steps(id, trace_id, seq, kind, provider, model, input_tokens, output_tokens, cost_usd, duration_ms, tools, escalated, error, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    crypto.randomUUID(),
    input.traceId,
    input.seq,
    input.kind || 'model',
    String(input.provider || ''),
    model,
    inputTokens,
    outputTokens,
    usd,
    Math.max(0, Math.round(input.durationMs || 0)),
    JSON.stringify(input.tools || []),
    input.escalated ? 1 : 0,
    input.error ? input.error.slice(0, 500) : null,
    now
  );

  const trace = db.prepare('SELECT model, tools, input_tokens, output_tokens, duration_ms FROM agent_traces WHERE id = ?').get(input.traceId) as
    | { model: string; tools: string | null; input_tokens: number; output_tokens: number; duration_ms: number }
    | undefined;
  if (!trace) return;
  const tools = parseStringList(trace.tools);
  for (const name of input.tools || []) if (!tools.includes(name)) tools.push(name);
  const totalIn = trace.input_tokens + inputTokens;
  const totalOut = trace.output_tokens + outputTokens;
  const turnModel = trace.model || model;
  const cost = estimateCost(turnModel, totalIn, totalOut);
  db.prepare(
    `UPDATE agent_traces SET steps = steps + 1, tools = ?, input_tokens = ?, output_tokens = ?,
       cost_usd = ?, cost_krw = ?, duration_ms = ?, escalated = MAX(escalated, ?) WHERE id = ?`
  ).run(
    JSON.stringify(tools),
    totalIn,
    totalOut,
    cost.usd,
    cost.krw,
    trace.duration_ms + Math.max(0, Math.round(input.durationMs || 0)),
    input.escalated ? 1 : 0,
    input.traceId
  );
}

/** 턴을 마무리한다. duration 은 모델 시간 합계가 아니라 실제 경과 시간을 따로 넘긴다. */
export function finishTrace(
  id: string,
  patch: {
    status: TraceStatus;
    model?: string;
    durationMs?: number;
    loopBreaks?: number;
    compacted?: number;
    escalated?: boolean;
    error?: string | null;
    tools?: string[];
  }
): void {
  const current = db.prepare('SELECT model, duration_ms FROM agent_traces WHERE id = ?').get(id) as
    | { model: string; duration_ms: number }
    | undefined;
  if (!current) return;
  db.prepare(
    `UPDATE agent_traces SET status = ?, model = ?, duration_ms = ?, loop_breaks = ?, compacted = ?,
       escalated = MAX(escalated, ?), error = ?, ended_at = ? WHERE id = ?`
  ).run(
    patch.status,
    patch.model || current.model,
    Math.max(0, Math.round(patch.durationMs ?? current.duration_ms)),
    Math.max(0, patch.loopBreaks || 0),
    Math.max(0, patch.compacted || 0),
    patch.escalated ? 1 : 0,
    patch.error ? patch.error.slice(0, 500) : null,
    new Date().toISOString(),
    id
  );
}

export function recentTraces(limit = 20, sessionId?: string): TraceView[] {
  const rows = sessionId
    ? (db
        .prepare('SELECT * FROM agent_traces WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(sessionId, limit) as TraceRow[])
    : (db.prepare('SELECT * FROM agent_traces ORDER BY created_at DESC LIMIT ?').all(limit) as TraceRow[]);
  return rows.map(rowToView);
}

export function traceById(id: string): TraceView | null {
  const row = db.prepare('SELECT * FROM agent_traces WHERE id = ?').get(id) as TraceRow | undefined;
  return row ? rowToView(row) : null;
}

export function traceSteps(traceId: string): TraceStepView[] {
  const rows = db
    .prepare('SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY seq ASC, created_at ASC')
    .all(traceId) as {
    id: string;
    trace_id: string;
    seq: number;
    kind: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    duration_ms: number;
    tools: string | null;
    escalated: number;
    error: string | null;
    created_at: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
    seq: row.seq,
    kind: row.kind === 'tool' ? 'tool' : 'model',
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    tools: parseStringList(row.tools),
    escalated: Boolean(row.escalated),
    error: row.error,
    createdAt: row.created_at,
  }));
}

export interface TraceSummary {
  days: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costKrw: number;
  avgDurationMs: number;
  failureRate: number;
  byModel: { model: string; provider: string; turns: number; inputTokens: number; outputTokens: number; costUsd: number }[];
  byDay: { day: string; turns: number; inputTokens: number; outputTokens: number; costUsd: number }[];
  usdKrw: number;
  prices: Record<string, ModelPrice>;
}

/** 최근 n일 합계 — 관제실 카드에 쓴다. */
export function traceSummary(days = 7): TraceSummary {
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  const rows = db.prepare('SELECT * FROM agent_traces WHERE created_at >= ?').all(since) as TraceRow[];
  const turns = rows.length;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let duration = 0;
  let failures = 0;
  const models = new Map<string, { model: string; provider: string; turns: number; inputTokens: number; outputTokens: number; costUsd: number }>();
  const dayMap = new Map<string, { day: string; turns: number; inputTokens: number; outputTokens: number; costUsd: number }>();
  for (const row of rows) {
    inputTokens += row.input_tokens;
    outputTokens += row.output_tokens;
    costUsd += row.cost_usd;
    duration += row.duration_ms;
    if (row.status === 'failed') failures += 1;
    const key = `${row.provider}:${row.model}`;
    const entry = models.get(key) || { model: row.model, provider: row.provider, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    entry.turns += 1;
    entry.inputTokens += row.input_tokens;
    entry.outputTokens += row.output_tokens;
    entry.costUsd += row.cost_usd;
    models.set(key, entry);
    const day = row.created_at.slice(0, 10);
    const dayEntry = dayMap.get(day) || { day, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    dayEntry.turns += 1;
    dayEntry.inputTokens += row.input_tokens;
    dayEntry.outputTokens += row.output_tokens;
    dayEntry.costUsd += row.cost_usd;
    dayMap.set(day, dayEntry);
  }
  const rate = usdKrwRate();
  return {
    days,
    turns,
    inputTokens,
    outputTokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    costKrw: Math.round(costUsd * rate * 100) / 100,
    avgDurationMs: turns ? Math.round(duration / turns) : 0,
    failureRate: turns ? Math.round((failures / turns) * 1000) / 10 : 0,
    byModel: [...models.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8),
    byDay: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    usdKrw: rate,
    prices: DEFAULT_PRICES,
  };
}

/** 오래된 트레이스 정리(기본 30일). */
export function prune(days = 30): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const steps = db
    .prepare('DELETE FROM agent_trace_steps WHERE trace_id IN (SELECT id FROM agent_traces WHERE created_at < ?)')
    .run(cutoff);
  const traces = db.prepare('DELETE FROM agent_traces WHERE created_at < ?').run(cutoff);
  const removed = Number(steps.changes || 0) + Number(traces.changes || 0);
  if (removed) addLog('info', `오래된 실행 트레이스 ${removed}건을 정리했습니다`);
  return removed;
}
