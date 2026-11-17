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
  type: 'server_stats' | 'tasks';
  stats?: SystemStats;
  tasks?: Task[];
  tools?: string[];
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
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
  count: number;
  autoLockMinutes: number;
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
