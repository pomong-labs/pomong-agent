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

export type ProviderId = 'gemini' | 'openai' | 'claude';

export interface Profile {
  nickname: string;
  theme: 'light' | 'dark';
  language: 'ko' | 'en';
  agentName: string;
  character: string;
  /** AI 말투: polite=존댓말, casual=편한 반말 */
  tone: 'polite' | 'casual';
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

export interface ChatMeta {
  type: 'server_stats' | 'tasks' | 'browser' | 'notice';
  stats?: SystemStats;
  tasks?: Task[];
  tools?: string[];
  browserSession?: string | null;
  taskRunId?: string;
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
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  meta: ChatMeta | null;
  createdAt: string;
  model?: string | null;
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
  provider: { provider: ProviderId; label: string; model: string; connectedAt: string } | null;
  providers: ProviderInfo[];
}

export interface ToolCatalogEntry {
  name: string;
  label: string;
  summary: string;
  example: string;
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
  type: 'job' | 'watch' | 'handover' | 'browser' | 'info' | 'chat' | 'chat_message' | 'task';
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
