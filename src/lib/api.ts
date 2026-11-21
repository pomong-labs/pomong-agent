export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError('서버 응답을 읽지 못했습니다.', 'bad_response', res.status);
  }
  if (!res.ok) {
    const payload = (data ?? {}) as { message?: string; code?: string };
    throw new ApiError(payload.message || `요청 실패 (${res.status})`, payload.code || 'error', res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ */
/* Shared types                                                        */
/* ------------------------------------------------------------------ */

export type ProviderId = 'gemini' | 'openai' | 'claude' | 'exaone';

/** v0.6.2: EXAONE 추론 강도 */
export type ExaoneEffort = 'low' | 'medium' | 'high';

/** AI 성격·말투 프리셋 (v0.5.6) */
export type PersonaId = 'default' | 'calm' | 'bright' | 'concise' | 'witty' | 'custom';

import type { FontId } from './font';

export type { FontId };
export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentMode = 'character' | 'purple' | 'custom';

export interface Profile {
  nickname: string;
  /** 라이트 / 다크 / 기기 설정 따름 */
  theme: ThemeMode;
  /** 포인트 컬러: 캐릭터 맞춤 / 기본 퍼플 / 직접 고르기 */
  accentMode: AccentMode;
  accentColor: string;
  language: 'ko' | 'en';
  agentName: string;
  character: string;
  /** AI 말투: polite=존댓말, casual=편한 반말 */
  tone: 'polite' | 'casual';
  /** AI 성격·말투 프리셋 */
  persona: PersonaId;
  /** persona='custom'일 때 직접 쓴 한 줄 성격 */
  personaCustom: string;
  /** v0.6.4: 앱 글꼴 (기본 · 프리텐다드 · 카카오 큰글씨) */
  font: FontId;
  /** v0.6.18: 글씨 굵게(볼드체) */
  bold?: boolean;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  ramMB: number;
  status: string;
}

export interface SystemStats {
  cpu: number;
  ram: number;
  disk: number;
  cores: number;
  cpuModel: string;
  cpuMhz: number;
  ramUsedGB: number;
  ramTotalGB: number;
  diskUsedGB: number;
  diskTotalGB: number;
  load1: number;
  load5: number;
  load15: number;
  uptimeSec: number;
  hostname: string;
  osName: string;
  status: 'healthy' | 'warning' | 'critical';
  processes: ProcessInfo[];
  logs: { id: number; level: string; message: string; at: string }[];
  sampledAt: string;
}

export type TaskPriority = 'high' | 'normal' | 'low';

export interface Task {
  id: string;
  title: string;
  done: boolean;
  due: string | null;
  priority: TaskPriority;
  notes: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface TaskCounts {
  all: number;
  open: number;
  done: number;
  high: number;
}

/** v0.6.16: D-Day 카운터 */
export interface DDay {
  id: string;
  title: string;
  targetDate: string;
  nextDate: string;
  repeatYearly: boolean;
  notes: string | null;
  days: number;
  label: string;
  dateLabel: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface ChatMeta {
  type: 'server_stats' | 'tasks' | 'browser' | 'notice' | 'mail';
  stats?: SystemStats;
  tasks?: Task[];
  tools?: string[];
  browserSession?: string | null;
  taskRunId?: string;
  /** v0.6.3: 메일 발송 확인 카드 */
  mailDraft?: MailDraftCard;
  /** v0.5.2: 예약·워치 결과가 채팅방에 선톡으로 올 때 */
  automation?: 'job' | 'watch' | 'parcel';
  badge?: string;
  jobId?: string | null;
  runId?: string | null;
  watcherId?: string | null;
  eventId?: string | null;
}

/** v0.5.2: 채팅에 붙은 사진·파일 */
export interface ChatAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'text' | 'pdf' | 'other';
  url: string;
  downloadUrl: string;
  messageId: number | null;
  createdAt: string;
}

export interface TaskStep {
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

export interface TaskRun {
  id: string;
  sessionId: string;
  messageId: number | null;
  title: string;
  status: 'running' | 'done' | 'failed' | 'partial';
  steps: number;
  startedAt: string;
  endedAt: string | null;
  items: TaskStep[];
}

export interface MemoryItem {
  id: string;
  category: string;
  content: string;
  importance: number;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  /** v0.7.1: 이 기억을 대신하는 최신 기억(있으면 '이전 버전') */
  supersededBy?: string | null;
  /** v0.7.1: 중요 고정 */
  pinned?: boolean;
  /** v0.7.1: 검색·그래프용 키워드 */
  tags?: string[];
}

export interface MemoryCategory {
  id: string;
  label: string;
}

export interface ServiceEntry {
  id: string;
  name: string;
  category: 'dev' | 'shopping' | 'life' | 'social';
  match: string[];
  loginUrl: string;
  tint: string;
  color: string;
  emoji: string;
  examples: string[];
  note?: string;
  connected: boolean;
  via: ('vault' | 'session')[];
}

export interface PushStatus {
  ok: true;
  enabled: boolean;
  subscriptions: number;
  error: string | null;
  foreground?: boolean;
  /** v0.5.2: VAPID 발신자 주소(문제 진단용) */
  subject?: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  meta: ChatMeta | null;
  attachments?: ChatAttachment[];
  createdAt: string;
  model?: string | null;
  /** v0.6.3: 답장(인용)한 원본 메시지 */
  replyTo?: { id: number; role: string; content: string; createdAt: string } | null;
  /** v0.6.15: 말풍선 아래에 보이는 이모지 리액션(최대 3개) */
  reactions?: string[];
}

/** v0.6.3: 답장할 때 입력창 위에 보여 주는 인용 정보 */
export interface ReplyTarget {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* v0.7.0: 하네스 관측성 · 중단 복구                                     */
/* ------------------------------------------------------------------ */

/** 이번 턴의 토큰·비용·루프 감지 정보(채팅 응답에 함께 온다) */
export interface ChatTurnObservability {
  traceId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costKrw: number;
  durationMs: number;
  loopBreaks: number;
  compactions: number;
  streamed: boolean;
}

/** 실행 트레이스 한 건(관제실 카드) */
export interface AgentTrace {
  id: string;
  sessionId: string;
  turnId: string;
  userPrompt: string;
  provider: string;
  model: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'approval';
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

export interface AgentTraceSummary {
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
}

/** 중단된 턴(이어서 하기 제안) */
export interface ResumableCheckpoint {
  id: string;
  sessionId: string;
  turnId: string;
  step: number;
  provider: string;
  model: string;
  userPrompt: string;
  toolsUsed: string[];
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'approval' | 'interrupted';
  updatedAt: string;
}

/** v0.6.3: 메일 발송 확인 카드 내용(답변 meta.mailDraft) */
export interface MailDraftCard {
  id: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  accountEmail: string;
}

export interface VaultItem {
  id: string;
  title: string;
  type: 'apikey' | 'login' | 'memo';
  masked: string;
  usernameMasked: string | null;
  hint: string;
  notes: string;
  isDefault: boolean;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
  count: number;
  autoLockMinutes: number;
}

/** v0.6.18: 금고 카드의 원격 브라우저 로그인 세션 상태 */
export interface VaultSessionStatus {
  itemId: string;
  host: string | null;
  status: 'logged_in' | 'needs_check' | 'not_logged_in' | 'unknown';
  expiresAt: string | null;
}

/** v0.6.18: 되돌리기 어려운 도구 실행 전 승인 카드 */
export interface ApprovalRequest {
  id: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  title: string;
  detail: string;
  reason: string;
  status: 'pending' | 'approved' | 'cancelled' | 'expired' | 'failed';
  result: string | null;
  createdAt: string;
}

/** 채팅 인라인 로그인 카드 (v0.5.1) — 비밀번호는 서버가 내려보내지 않는다. */
export interface LoginRequest {
  id: string;
  sessionId: string;
  service: string;
  loginUrl: string;
  siteHost: string | null;
  note: string | null;
  status: 'pending' | 'submitted' | 'cancelled';
  vaultId: string | null;
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 금고 PIN 입력 카드 (v0.5.4) — PIN은 서버로만 가고 어디에도 저장되지 않는다. */
export interface VaultUnlockRequest {
  id: string;
  sessionId: string;
  service: string | null;
  loginUrl: string | null;
  vaultId: string | null;
  intent: string | null;
  note: string | null;
  status: 'pending' | 'unlocked' | 'cancelled';
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 다중 대화방 (v0.5.4) */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  isDefault: boolean;
}

export interface MeResponse {
  ok: true;
  user: { username: string };
  profile: Profile;
  setupDone: boolean;
  aiConfigured: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  models: string[];
  defaultModel: string;
  console: string;
  connected: boolean;
  connectedAt: string | null;
  active: boolean;
  /** v0.6.2: EXAONE 추론 강도(다른 프로바이더는 null) */
  reasoningEffort?: ExaoneEffort | null;
  /** v0.6.3: 키를 마지막으로 넣은 시각 */
  keyUpdatedAt?: string | null;
  /** v0.6.3: EXAONE 무료 키 30일 만료 표시 */
  keyExpiry?: KeyExpiry | null;
}

export interface KeyExpiry {
  updatedAt: string | null;
  daysLeft: number | null;
  label: string;
  warn: boolean;
  expired: boolean;
}

/** v0.6.3: 작업별 모델 자동 라우팅 */
export type TaskKind = 'chat' | 'browser' | 'vision' | 'writing';
export type RouteChoice = 'inherit' | ProviderId;
export interface RoutingSettings {
  chat: RouteChoice;
  browser: RouteChoice;
  vision: RouteChoice;
  writing: RouteChoice;
}

/** v0.6.3: 이메일(IMAP/SMTP) 계정 */
export interface MailAccount {
  id: string;
  provider: 'naver' | 'gmail' | 'custom';
  label: string;
  email: string;
  senderName: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  createdAt: string;
  lastTestAt: string | null;
  lastError: string | null;
}

export interface MailPreset {
  id: string;
  label: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  help: string;
}

export interface ModelsResponse {
  ok: true;
  active: { provider: ProviderId; model: string };
  providers: ProviderInfo[];
  labels: Record<string, string>;
  lastGoodGeminiModel: string | null;
}

export interface MascotInfo {
  id: string;
  name: string;
}

export interface SettingsResponse {
  ok: true;
  profile: Profile;
  version: string;
  mascots: MascotInfo[];
  active: { provider: ProviderId; model: string };
  provider: { provider: ProviderId; label: string; model: string; connectedAt: string; reasoningEffort?: ExaoneEffort } | null;
  providers: ProviderInfo[];
  /** v0.6.2: EXAONE 추론 강도 선택지 */
  exaone?: { efforts: ExaoneEffort[]; expiry?: KeyExpiry };
  /** v0.6.3: 작업별 모델 라우팅 */
  routing?: RoutingSettings;
  routingOptions?: { kind: TaskKind; label: string; hint: string }[];
  /** v0.6.3: 이메일 계정 */
  mail?: { accounts: MailAccount[]; presets: MailPreset[] };
  /** v0.6.18: 개인정보 자동 마스킹 */
  privacy?: { maskExternal: boolean };
}

export interface ToolCatalogEntry {
  name: string;
  label: string;
  summary: string;
  example: string;
}

/** v0.6.6: 도구(스킬) 관리자 — 그룹별 내장 도구 */
export type ToolGroupId =
  | 'core'
  | 'browser'
  | 'mail'
  | 'web'
  | 'memory'
  | 'files'
  | 'automation'
  | 'server'
  | 'weather'
  | 'vault';

export interface ToolGroupEntry {
  id: ToolGroupId;
  label: string;
  desc: string;
  emoji: string;
  tools: { name: string; label: string; summary: string; example: string }[];
}

export interface ToolPrefs {
  disabledGroups: ToolGroupId[];
  disabledTools: string[];
}

/** 사용자가 직접 만든 지침 도구 */
export interface CustomSkill {
  id: string;
  name: string;
  keywords: string[];
  instructions: string;
  alwaysApply: boolean;
  enabled: boolean;
  /** v0.7.1: 'prompt'(글로 쓰기) | 'workflow'(단계별 조립) */
  mode: 'prompt' | 'workflow';
  /** v0.7.1: 단계별 워크플로우의 단계들 */
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

/** v0.7.1: 단계별 워크플로우 */
export type WorkflowStepKind = 'tool' | 'ai' | 'action';

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  label: string;
  tool?: string;
  args?: Record<string, string>;
  prompt?: string;
  action?: 'notify' | 'todo';
  text?: string;
  continueOnError?: boolean;
}

export interface WorkflowStepResult {
  index: number;
  id: string;
  kind: WorkflowStepKind;
  label: string;
  status: 'ok' | 'failed' | 'skipped';
  output: string;
  durationMs: number;
  error?: string;
}

export interface WorkflowRun {
  ok: boolean;
  steps: WorkflowStepResult[];
  output: string;
  totalMs: number;
  error?: string;
}

/** 워크플로우 빌더가 쓰는 도구 목록(인자 이름·설명 포함) */
export interface WorkflowToolParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
  options?: string[];
}

export interface WorkflowTool {
  name: string;
  label: string;
  summary: string;
  params: WorkflowToolParam[];
}

/** 워크플로우 예시 템플릿 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  summary: string;
  keywords: string[];
  sampleInput: string;
  steps: WorkflowStep[];
}

/** v0.7.1: 개인 지식 그래프 */
export interface MemoryGraphNode {
  id: string;
  kind: 'me' | 'category' | 'memory';
  label: string;
  category?: string;
  content?: string;
  importance?: number;
  pinned?: boolean;
  count?: number;
  updatedAt?: string;
}

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'contains' | 'similar' | 'link';
  weight: number;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  counts: { memories: number; categories: number; links: number; superseded: number };
}

export interface SkillTemplate {
  id: string;
  name: string;
  summary: string;
  keywords: string[];
  instructions: string;
}

/* ------------------------------------------------------------------ */
/* Phase 2 — 자동화(예약·워치) · 자율 브라우저                       */
/* ------------------------------------------------------------------ */

export type JobRunStatus = 'running' | 'ok' | 'failed' | 'skipped_overlap' | 'missed' | 'approval_needed';

export interface JobRun {
  id: string;
  jobId: string;
  status: JobRunStatus;
  trigger: string;
  startedAt: string;
  endedAt: string | null;
  steps: number;
  result: string | null;
  error: string | null;
}

export interface AutomationJob {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  toolsAllow: string[] | null;
  maxSteps: number;
  notify: string[];
  enabled: boolean;
  nextRunAt: string | null;
  nextRuns: string[];
  scheduleLabel: string;
  lastRunAt: string | null;
  lastStatus: JobRunStatus | null;
  createdAt: string;
  running: boolean;
  lastRun?: JobRun | null;
}

export type WatchMode = 'selector' | 'text' | 'json' | 'regex' | 'price' | 'rss' | 'github' | 'ping';

export interface WatchEvent {
  id: string;
  watcherId: string;
  kind: 'changed' | 'failed' | 'recovered' | 'first';
  diffSummary: string | null;
  beforeText: string | null;
  afterText: string | null;
  url: string | null;
  createdAt: string;
  notifiedAt: string | null;
}

export interface Watcher {
  id: string;
  name: string;
  url: string;
  mode: WatchMode;
  target: string | null;
  intervalMin: number;
  quietHours: string | null;
  enabled: boolean;
  lastHash: string | null;
  lastValue: string | null;
  lastChecked: string | null;
  lastStatus: string | null;
  failCount: number;
  nextCheckAt: string | null;
  createdAt: string;
  lastEvent?: WatchEvent | null;
}

export interface BrowserSession {
  id: string;
  status: string;
  controlOwner: 'agent' | 'user';
  handoverReason: string | null;
  handoverLabel: string | null;
  controlDetail: string | null;
  leaseExpiresAt: string | null;
  url: string | null;
  title: string | null;
  actions: number;
  createdAt: string;
  lastUsedAt: string;
  alive: boolean;
  /** v0.7.1: 2단계 인증·캡차 등 추가 인증 대기 중 */
  awaitingVerification?: boolean;
  verificationLabel?: string | null;
}

export interface BrowserAction {
  id: string;
  actor: string;
  tool: string;
  args: string;
  result: string;
  url: string | null;
  at: string;
}

export interface AppEvent {
  id: number;
  type: 'job' | 'watch' | 'handover' | 'browser' | 'info' | 'chat' | 'chat_message' | 'chat_reaction' | 'task';
  title: string;
  body: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface PolicyEntry {
  pattern: string;
  level: 'allow' | 'confirm' | 'block' | 'handover';
  note: string | null;
}

/** 받은 파일 · 결과물 (v0.5.5) — 채팅 첨부·브라우저 저장·AI 결과물 */
export interface FileItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'text' | 'pdf' | 'other';
  source: 'chat' | 'browser' | 'agent';
  previewUrl: string;
  downloadUrl: string;
  createdAt: string;
  sessionId: string | null;
  exists: boolean;
}
