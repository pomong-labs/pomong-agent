import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_NAME, APP_VERSION, CLIENT_DIST, DATA_DIR, HOST, PORT, ensureDataDir, writePrivate } from './config';
import { addLog, db, getJson, getSetting, setJson, setSetting } from './db';
import { hashPassword, readSetupToken, randomToken, signValue, unsignValue, verifyPassword } from './crypto';
import {
  SESSION_COOKIE,
  clearCookie,
  clearLoginAttempts,
  createSession,
  getUser,
  getUserCount,
  loginGuard,
  noteFailedLogin,
  readSession,
  requireAuth,
  setCookie,
} from './auth';
import { currentStats, getHistory, startSampler } from './system';
import {
  MODEL_LABELS,
  PROVIDERS,
  getLastGoodGeminiModel,
  normalizeModel,
  runAgentStep,
  setLastGoodGeminiModel,
  testProvider,
  type AgentMessage,
  type ProviderId,
} from './providers';
import { TOOL_SPECS, runTool, listTaskRows, toTaskView, normalizeDue, normalizePriority, type TaskRow } from './tools';
import { getAgentStatus, setAgentState } from './agent-status';
import * as vault from './vault';

ensureDataDir();

/* ------------------------------------------------------------------ */
/* App state helpers                                                   */
/* ------------------------------------------------------------------ */

const SETUP_COOKIE = 'pa_setup';

function setupDone(): boolean {
  return getSetting('setup.completed') === '1';
}

function setupToken(): string | null {
  return readSetupToken();
}

function ensureSetupToken(): string {
  const existing = readSetupToken();
  if (existing) return existing;
  const token = randomToken(24);
  writePrivate(path.join(DATA_DIR, 'setup-token.txt'), `${token}\n`);
  return token;
}

function setupCookieValid(req: Request): boolean {
  const raw = (req.headers.cookie || '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SETUP_COOKIE}=`));
  if (!raw) return false;
  const value = unsignValue(decodeURIComponent(raw.slice(SETUP_COOKIE.length + 1)));
  if (!value) return false;
  const expected = setupToken();
  if (!expected) return false;
  return value === `setup:${expected}`;
}

function grantSetupCookie(req: Request, res: Response): void {
  const token = setupToken();
  if (!token) return;
  setCookie(req, res, SETUP_COOKIE, signValue(`setup:${token}`), 2 * 60 * 60 * 1000);
}

function requireSetup(req: Request, res: Response, next: () => void): void {
  if (setupDone()) {
    res.status(410).json({ ok: false, code: 'setup_locked', message: '설정이 이미 완료되어 잠겼습니다.' });
    return;
  }
  if (!setupCookieValid(req)) {
    res.status(403).json({ ok: false, code: 'setup_token_required', message: '유효한 설정 토큰이 필요합니다.' });
    return;
  }
  next();
}

export const MASCOTS = [
  { id: 'poding', name: '포딩' },
  { id: 'pimong', name: '피몽' },
  { id: 'lamong', name: '라몽' },
  { id: 'pongi', name: '퐁이' },
  { id: 'mello', name: '멜로' },
  { id: 'minti', name: '민티' },
] as const;
export type MascotId = (typeof MASCOTS)[number]['id'];

const MASCOT_IDS = MASCOTS.map((m) => m.id) as string[];

interface Profile {
  nickname: string;
  theme: 'light' | 'dark';
  language: 'ko' | 'en';
  agentName: string;
  character: MascotId;
}

function profile(): Profile {
  const stored = getJson<Partial<Profile>>('profile', {});
  return {
    nickname: stored.nickname || '',
    theme: stored.theme === 'dark' ? 'dark' : 'light',
    language: stored.language === 'en' ? 'en' : 'ko',
    agentName: stored.agentName || 'Pomong',
    character: MASCOT_IDS.includes(String(stored.character)) ? (stored.character as MascotId) : 'pimong',
  };
}

function normalizeCharacter(value: unknown, fallback: MascotId): MascotId {
  return MASCOT_IDS.includes(String(value)) ? (value as MascotId) : fallback;
}

interface ProviderAccount {
  apiKeyEnc: string;
  connectedAt: string;
}

interface LlmState {
  active: { provider: ProviderId; model: string };
  accounts: Partial<Record<ProviderId, ProviderAccount>>;
}

const DEFAULT_LLM: LlmState = {
  active: { provider: 'gemini', model: PROVIDERS.gemini.defaultModel },
  accounts: {},
};

function llmState(): LlmState {
  const stored = getJson<Partial<LlmState> | null>('llm.state', null);
  const activeProvider: ProviderId =
    stored?.active?.provider && stored.active.provider in PROVIDERS ? stored.active.provider : 'gemini';
  return {
    active: { provider: activeProvider, model: normalizeModel(activeProvider, stored?.active?.model) },
    accounts: stored?.accounts && typeof stored.accounts === 'object' ? stored.accounts : {},
  };
}

function saveLlmState(state: LlmState): void {
  setJson('llm.state', state);
}

/** 구버전(단일 provider + provider.backup.*) 설정을 다중 계정 설정으로 옮긴다. */
function migrateLlmState(): void {
  if (getJson<LlmState | null>('llm.state', null)) return;
  const accounts: Partial<Record<ProviderId, ProviderAccount>> = {};
  const legacy = getJson<{ provider?: ProviderId; model?: string; apiKeyEnc?: string; connectedAt?: string } | null>('provider', null);
  let active: LlmState['active'] = { ...DEFAULT_LLM.active };
  if (legacy?.apiKeyEnc && legacy.provider && legacy.provider in PROVIDERS) {
    accounts[legacy.provider] = { apiKeyEnc: legacy.apiKeyEnc, connectedAt: legacy.connectedAt || new Date().toISOString() };
    active = { provider: legacy.provider, model: normalizeModel(legacy.provider, legacy.model) };
  }
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    if (accounts[id]) continue;
    const backup = getJson<{ apiKeyEnc?: string; connectedAt?: string; model?: string } | null>(`provider.backup.${id}`, null);
    if (backup?.apiKeyEnc) {
      accounts[id] = { apiKeyEnc: backup.apiKeyEnc, connectedAt: backup.connectedAt || new Date().toISOString() };
    }
  }
  saveLlmState({ active, accounts });
  if (Object.keys(accounts).length) addLog('info', '저장된 AI 키를 모델 선택 목록으로 옮겼습니다');
}

interface ActiveConfig {
  provider: ProviderId;
  model: string;
  apiKeyEnc: string | null;
  connectedAt: string | null;
}

function activeConfig(): ActiveConfig {
  const state = llmState();
  const account = state.accounts[state.active.provider];
  const model = normalizeModel(state.active.provider, state.active.model);
  if (model !== state.active.model) {
    saveLlmState({ ...state, active: { ...state.active, model } });
  }
  return {
    provider: state.active.provider,
    model,
    apiKeyEnc: account?.apiKeyEnc || null,
    connectedAt: account?.connectedAt || null,
  };
}

function aiConfigured(): boolean {
  return Boolean(activeConfig().apiKeyEnc);
}

function providerSummary() {
  const state = llmState();
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
    id,
    label: PROVIDERS[id].label,
    models: PROVIDERS[id].models,
    defaultModel: PROVIDERS[id].defaultModel,
    console: PROVIDERS[id].console,
    connected: Boolean(state.accounts[id]?.apiKeyEnc),
    connectedAt: state.accounts[id]?.connectedAt || null,
    active: state.active.provider === id,
  }));
}

/* ------------------------------------------------------------------ */
/* Express                                                             */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

/* ---------------------------- health ------------------------------ */

app.get('/api/health', (_req, res) => {
  const stats = currentStats();
  res.json({
    ok: true,
    status: stats.status,
    version: APP_VERSION,
    app: APP_NAME,
    setupDone: setupDone(),
    uptimeSec: stats.uptimeSec,
    time: new Date().toISOString(),
  });
});

app.get('/api/version', (_req, res) => {
  res.json({ ok: true, version: APP_VERSION, name: APP_NAME });
});

/* ----------------------------- setup ------------------------------ */

const LOCKED_PAYLOAD = { ok: false, code: 'setup_locked', message: '설정이 이미 완료되어 잠겼습니다.' };

app.get('/api/setup/state', (req, res) => {
  if (setupDone()) {
    res.status(410).json({ ...LOCKED_PAYLOAD, completedAt: getSetting('setup.completedAt') });
    return;
  }
  const token = setupToken();
  // Token is required only when one exists (first boot writes it).
  res.json({
    ok: true,
    needsSetup: true,
    tokenRequired: Boolean(token),
    verified: setupCookieValid(req),
    hasAccount: getUserCount() > 0,
    version: APP_VERSION,
  });
});

app.post('/api/setup/verify-token', (req, res) => {
  if (setupDone()) {
    res.status(410).json(LOCKED_PAYLOAD);
    return;
  }
  const submitted = String((req.body as { token?: string })?.token || '').trim();
  const expected = setupToken();
  if (!expected) {
    grantSetupCookie(req, res);
    res.json({ ok: true, verified: true });
    return;
  }
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    addLog('warn', '설정 토큰 검증 실패');
    res.status(403).json({ ok: false, code: 'invalid_token', message: '설정 토큰이 올바르지 않습니다. 서버 로그의 URL을 확인해 주세요.' });
    return;
  }
  grantSetupCookie(req, res);
  addLog('info', '설정 토큰이 확인되었습니다');
  res.json({ ok: true, verified: true });
});

app.post('/api/setup/account', requireSetup, (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || username.trim().length < 2) {
    res.status(400).json({ ok: false, code: 'invalid_username', message: '아이디는 2자 이상이어야 합니다.' });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ ok: false, code: 'weak_password', message: '비밀번호는 8자 이상이어야 합니다.' });
    return;
  }
  const existing = getUserCount();
  const now = new Date().toISOString();
  if (existing === 0) {
    db.prepare('INSERT INTO users(username, password_hash, created_at) VALUES(?,?,?)').run(
      username.trim(),
      hashPassword(password),
      now
    );
  } else {
    const row = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number };
    db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?').run(
      username.trim(),
      hashPassword(password),
      row.id
    );
  }
  addLog('success', '관리자 계정이 생성되었습니다');
  res.json({ ok: true });
});

app.post('/api/setup/provider', requireSetup, async (req, res) => {
  const body = req.body as { provider?: ProviderId; apiKey?: string; model?: string; skip?: boolean };
  if (body.skip) {
    res.json({ ok: true, skipped: true });
    return;
  }
  const provider = body.provider;
  const apiKey = (body.apiKey || '').trim();
  if (!provider || !(provider in PROVIDERS)) {
    res.status(400).json({ ok: false, code: 'invalid_provider', message: 'AI Provider를 선택해 주세요.' });
    return;
  }
  if (!apiKey) {
    res.status(400).json({ ok: false, code: 'missing_key', message: 'API 키를 입력해 주세요.' });
    return;
  }
  const result = await testProvider(provider, apiKey);
  if (!result.ok) {
    res.status(400).json({ ok: false, code: 'provider_test_failed', message: result.message });
    return;
  }
  const { encrypt, serverKey } = await import('./crypto');
  const state = llmState();
  const model = normalizeModel(provider, body.model);
  saveLlmState({
    active: { provider, model },
    accounts: {
      ...state.accounts,
      [provider]: { apiKeyEnc: encrypt(apiKey, serverKey()), connectedAt: new Date().toISOString() },
    },
  });
  addLog('success', `${PROVIDERS[provider].label} 연결 완료`);
  res.json({ ok: true, message: result.message, models: result.models, model });
});

app.post('/api/setup/preferences', requireSetup, (req, res) => {
  const body = req.body as Partial<Profile>;
  const current = profile();
  setJson('profile', {
    ...current,
    nickname: (body.nickname ?? current.nickname).slice(0, 40),
    theme: body.theme === 'dark' ? 'dark' : 'light',
    language: body.language === 'en' ? 'en' : 'ko',
    agentName: (body.agentName ?? current.agentName).slice(0, 24) || 'Pomong',
    character: normalizeCharacter(body.character, current.character),
  });
  res.json({ ok: true });
});

app.post('/api/setup/complete', requireSetup, (req, res) => {
  if (getUserCount() === 0) {
    res.status(400).json({ ok: false, code: 'no_account', message: '관리자 계정을 먼저 만들어 주세요.' });
    return;
  }
  setSetting('setup.completed', '1');
  setSetting('setup.completedAt', new Date().toISOString());
  try {
    fs.rmSync(path.join(DATA_DIR, 'setup-token.txt'));
  } catch {
    /* already gone */
  }
  clearCookie(req, res, SETUP_COOKIE);
  const row = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get() as { id: number; username: string };
  createSession(req, res, { id: row.id, username: row.username });
  addLog('success', '초기 설정이 완료되었습니다');
  res.json({ ok: true });
});

/* ------------------------------ auth ------------------------------ */

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const guard = loginGuard(ip);
  if (!guard.allowed) {
    res.status(429).json({ ok: false, code: 'too_many_attempts', message: `시도가 너무 많습니다. ${guard.retryAfterSec}초 후 다시 시도해 주세요.` });
    return;
  }
  const { username, password } = req.body as { username?: string; password?: string };
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(String(username || '').trim()) as
    | { id: number; username: string; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(String(password || ''), row.password_hash)) {
    noteFailedLogin(ip);
    addLog('warn', '로그인 실패');
    res.status(401).json({ ok: false, code: 'invalid_credentials', message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    return;
  }
  clearLoginAttempts(ip);
  createSession(req, res, { id: row.id, username: row.username });
  addLog('info', '관리자 로그인');
  res.json({ ok: true, user: { username: row.username } });
});

app.post('/api/auth/logout', (req, res) => {
  clearCookie(req, res, SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ ok: false, code: 'unauthorized', needsSetup: !setupDone() });
    return;
  }
  res.json({ ok: true, user: { username: session.username }, profile: profile(), setupDone: setupDone(), aiConfigured: aiConfigured() });
});

/* ----------------------------- monitor ---------------------------- */

app.get('/api/monitor/stats', requireAuth, (_req, res) => {
  res.json({ ok: true, stats: currentStats(), history: getHistory() });
});

/* ------------------------------ chat ------------------------------ */

function serverContextForPrompt(): string {
  const s = currentStats();
  const tasks = listTaskRows(30)
    .filter((t) => !t.done)
    .slice(0, 12)
    .map((t) => `- [할 일] ${t.title}${t.due ? ` (마감 ${t.due})` : ''}${t.priority !== 'normal' ? ` [우선순위 ${t.priority}]` : ''}`);
  const now = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  return [
    `현재 시각: ${now} (Asia/Seoul)`,
    `서버: ${s.hostname} (${s.osName})`,
    `CPU ${s.cpu}% · RAM ${s.ram}% (${s.ramUsedGB}/${s.ramTotalGB}GB) · Disk ${s.disk}% (${s.diskUsedGB}/${s.diskTotalGB}GB)`,
    `코어 ${s.cores}개 · 로드 ${s.load1}/${s.load5}/${s.load15} · 가동 ${Math.floor(s.uptimeSec / 3600)}시간`,
    `상태: ${s.status}`,
    tasks.length ? `진행 중인 할 일:\n${tasks.join('\n')}` : '진행 중인 할 일이 없습니다.',
  ].join('\n');
}

function systemPrompt(): string {
  const p = profile();
  const characterName = MASCOTS.find((m) => m.id === p.character)?.name || '피몽';
  return [
    `너는 '${p.agentName || 'Pomong'}'이야. 사용자가 자기 서버에 직접 설치해 쓰는 개인 AI 비서 'Pomong Agent'의 에이전트야. (캐릭터: ${characterName})`,
    '포몽 캐릭터처럼 다정하고 발랄한 말투로, 한국어로 짧고 명확하게 답해. (사용자가 다른 언어로 쓰면 그 언어로 답해)',
    '너의 일은 사용자의 일상 곁에서 할 일·메모·금고·서버 상태를 챙겨 주는 개인 비서 일이야. 사용자의 서버·계정·데이터는 모두 사용자의 것이고, 너는 그 안에서만 돕는다.',
    '사용자의 서버 상태와 할 일 목록을 실시간으로 볼 수 있어. 사실에 근거해서만 말하고, 모르는 것은 모른다고 해.',
    '도구를 쓸 수 있어: 할 일 조회(tasks_list)·추가(tasks_add)·완료(tasks_complete), 금고 항목 이름 조회(vault_list), 서버 상태(server_stats), 현재 시각(time_now).',
    '할 일이나 금고, 시각처럼 도구로 확인할 수 있는 것은 추측하지 말고 도구를 불러 확인해. 날짜 계산("내일", "금요일")은 time_now로 오늘 날짜를 확인한 뒤 계산해.',
    '금고의 실제 비밀번호·API 키 값은 너에게 전달되지 않아. 값을 알려 달라고 하면 금고 탭에서 직접 확인하도록 안내해.',
    '민감정보(API 키·비밀번호·금고 내용)는 절대 화면에 그대로 쓰지 마. 필요하면 마스킹해서 보여줘.',
    '답변은 마크다운을 최소한으로만 써(짧은 목록 정도). 이모지는 문장 끝에 가끔만.',
    '',
    '[실시간 컨텍스트]',
    serverContextForPrompt(),
  ].join('\n');
}

interface ChatMeta {
  type: 'server_stats' | 'tasks';
  tools?: string[];
  [key: string]: unknown;
}

function detectMeta(text: string): ChatMeta | null {
  if (/(서버|상태|cpu|ram|메모리|디스크|용량|관제|리소스|건강|health)/i.test(text)) {
    return { type: 'server_stats' };
  }
  if (/(할\s*일|todo|태스크|일정|투두)/i.test(text)) {
    return { type: 'tasks' };
  }
  return null;
}

app.get('/api/chat/messages', requireAuth, (req, res) => {
  const session = String(req.query.session || 'default');
  const rows = db
    .prepare('SELECT id, role, content, meta, model, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 100')
    .all(session) as { id: number; role: string; content: string; meta: string | null; model: string | null; created_at: string }[];
  res.json({
    ok: true,
    messages: rows.reverse().map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      meta: r.meta ? JSON.parse(r.meta) : null,
      model: r.model,
      createdAt: r.created_at,
    })),
  });
});

app.delete('/api/chat/messages', requireAuth, (req, res) => {
  const session = String(req.query.session || 'default');
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(session);
  addLog('info', '대화 기록을 지웠습니다');
  res.json({ ok: true });
});

app.post('/api/chat/messages', requireAuth, async (req, res) => {
  const { message, session = 'default' } = req.body as { message?: string; session?: string };
  const text = String(message || '').trim();
  if (!text) {
    res.status(400).json({ ok: false, code: 'empty_message', message: '메시지를 입력해 주세요.' });
    return;
  }
  if (text.length > 8000) {
    res.status(400).json({ ok: false, code: 'too_long', message: '메시지가 너무 깁니다.' });
    return;
  }
  const config = activeConfig();
  if (!config.apiKeyEnc) {
    res.status(409).json({
      ok: false,
      code: 'no_provider',
      message: `${PROVIDERS[config.provider].label} 키가 아직 연결되지 않았습니다. 설정에서 API 키를 연결하거나 입력창 위에서 다른 모델을 선택해 주세요.`,
    });
    return;
  }

  const now = new Date().toISOString();
  db.prepare('INSERT INTO messages(session_id, role, content, meta, created_at) VALUES(?,?,?,?,?)').run(
    session,
    'user',
    text,
    null,
    now
  );

  const history = db
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 20')
    .all(session) as { role: string; content: string }[];
  const conversation: AgentMessage[] = [
    { role: 'system', content: systemPrompt() },
    ...history
      .reverse()
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }) as AgentMessage),
  ];

  setAgentState('thinking', `${PROVIDERS[config.provider].label} ${config.model}`);

  try {
    const { decrypt, serverKey } = await import('./crypto');
    const apiKey = decrypt(config.apiKeyEnc, serverKey());
    let model = config.model;
    let reply = '';
    let usedMeta: 'tasks' | 'server_stats' | null = null;
    const usedTools: string[] = [];
    const MAX_STEPS = 4;

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const result = await runAgentStep(config.provider, apiKey, model, conversation, TOOL_SPECS, step === 0);
      model = result.model;
      if (!result.toolCalls.length) {
        reply = result.text;
        break;
      }
      conversation.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
      reply = result.text;
      setAgentState('working', result.toolCalls.map((c) => c.name).join(', '));
      for (const call of result.toolCalls) {
        const output = await runTool(call.name, call.args);
        usedTools.push(call.name);
        if (output.meta) usedMeta = output.meta;
        conversation.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output.content });
        addLog('info', `도구 실행 · ${call.name}`);
      }
      setAgentState('thinking', `${PROVIDERS[config.provider].label} ${model}`);
    }

    if (!reply.trim()) reply = '확인했어요. 더 도와드릴 일이 있을까요?';

    setAgentState('responding', `${PROVIDERS[config.provider].label} ${model}`);
    let meta: ChatMeta | null = usedMeta ? { type: usedMeta, tools: usedTools } : detectMeta(text);
    if (meta && usedTools.length) meta.tools = usedTools;
    const payload = meta ? JSON.stringify(meta) : null;
    const info = db
      .prepare('INSERT INTO messages(session_id, role, content, meta, model, created_at) VALUES(?,?,?,?,?,?)')
      .run(session, 'assistant', reply, payload, `${config.provider}:${model}`, new Date().toISOString());
    // 실제로 응답한 모델을 기억해 두면 다음 대화부터는 그 모델로 바로 시도한다.
    if (config.provider === 'gemini') {
      const good = getLastGoodGeminiModel();
      if (good && getJson<string | null>('gemini.lastGoodModel', null) !== good) {
        setJson('gemini.lastGoodModel', good);
        if (good !== model) addLog('info', `${model} 대신 ${good} 모델로 응답했습니다`);
      }
    }
    addLog('info', `AI 응답 · ${PROVIDERS[config.provider].label} (${model})`);
    const stats = currentStats();
    const tasks = listTaskRows(12).map(toTaskView);
    setAgentState('idle');
    res.json({
      ok: true,
      message: {
        id: Number(info.lastInsertRowid),
        role: 'assistant',
        content: reply,
        meta: meta ? { ...meta, stats, tasks } : null,
        model: `${config.provider}:${model}`,
        createdAt: new Date().toISOString(),
      },
      model,
      provider: config.provider,
      tools: usedTools,
    });
  } catch (err) {
    const message2 = err instanceof Error ? err.message : String(err);
    addLog('error', `AI 호출 실패: ${message2.slice(0, 120)}`);
    setAgentState('error', message2.slice(0, 160));
    res.status(502).json({ ok: false, code: 'provider_error', message: `AI 응답을 받지 못했습니다. (${message2.slice(0, 200)})` });
  }
});

/* ---------------------------- agent state -------------------------- */

app.get('/api/agent/status', requireAuth, (_req, res) => {
  const p = profile();
  res.json({
    ok: true,
    ...getAgentStatus(),
    agentName: p.agentName,
    character: p.character,
    model: activeConfig().model,
    provider: activeConfig().provider,
  });
});

/* ------------------------------ vault ----------------------------- */

app.get('/api/vault/status', requireAuth, (_req, res) => {
  res.json({ ok: true, ...vault.vaultMeta() });
});

app.post('/api/vault/init', requireAuth, (req, res) => {
  const { pin } = req.body as { pin?: string };
  try {
    vault.initVault(String(pin || ''));
    res.json({ ok: true, ...vault.vaultMeta() });
  } catch (err) {
    res.status(400).json({ ok: false, code: 'vault_init_failed', message: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/vault/unlock', requireAuth, (req, res) => {
  const { pin } = req.body as { pin?: string };
  if (!vault.unlockVault(String(pin || ''))) {
    res.status(401).json({ ok: false, code: 'invalid_pin', message: 'PIN이 올바르지 않습니다.' });
    return;
  }
  res.json({ ok: true, ...vault.vaultMeta() });
});

app.post('/api/vault/lock', requireAuth, (_req, res) => {
  vault.lockVault();
  res.json({ ok: true, ...vault.vaultMeta() });
});

app.get('/api/vault/items', requireAuth, (req, res) => {
  try {
    const items = vault.listItems(String(req.query.q || ''));
    res.json({ ok: true, items, ...vault.vaultMeta() });
  } catch (err) {
    res.status(423).json({ ok: false, code: 'vault_locked', message: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/vault/items', requireAuth, (req, res) => {
  const body = req.body as { title?: string; type?: vault.VaultType; secret?: string; notes?: string; username?: string };
  if (!body.title || !body.secret || !body.type) {
    res.status(400).json({ ok: false, code: 'invalid_item', message: '제목·종류·내용을 모두 입력해 주세요.' });
    return;
  }
  try {
    const id = vault.createItem({
      title: String(body.title).slice(0, 80),
      type: body.type,
      secret: String(body.secret),
      notes: body.notes ? String(body.notes).slice(0, 2000) : undefined,
      username: body.username ? String(body.username).slice(0, 120) : undefined,
    });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(423).json({ ok: false, code: 'vault_locked', message: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/vault/items/:id', requireAuth, (req, res) => {
  try {
    vault.updateItem(req.params.id, req.body as Record<string, never>);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, code: 'vault_update_failed', message: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/vault/items/:id', requireAuth, (req, res) => {
  try {
    vault.deleteItem(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, code: 'vault_delete_failed', message: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/vault/items/:id/reveal', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, ...vault.revealItem(req.params.id) });
  } catch (err) {
    res.status(423).json({ ok: false, code: 'vault_locked', message: err instanceof Error ? err.message : String(err) });
  }
});

/* ------------------------------ tasks ----------------------------- */

app.get('/api/tasks', requireAuth, (req, res) => {
  const rows = listTaskRows(500);
  const tasks = rows.map(toTaskView);
  res.json({
    ok: true,
    tasks,
    counts: {
      all: tasks.length,
      open: tasks.filter((t) => !t.done).length,
      done: tasks.filter((t) => t.done).length,
      high: tasks.filter((t) => !t.done && t.priority === 'high').length,
    },
  });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const { title, due, priority, notes } = req.body as { title?: string; due?: string; priority?: string; notes?: string };
  if (!title?.trim()) {
    res.status(400).json({ ok: false, code: 'invalid_title', message: '할 일 내용을 입력해 주세요.' });
    return;
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO tasks(id, title, done, due, priority, notes, created_at, updated_at) VALUES(?,?,0,?,?,?,?,?)').run(
    id,
    title.trim().slice(0, 160),
    normalizeDue(due),
    normalizePriority(priority),
    notes ? String(notes).slice(0, 800) : null,
    now,
    now
  );
  const row = db.prepare('SELECT id, title, done, due, priority, notes, created_at, updated_at FROM tasks WHERE id = ?').get(id) as TaskRow;
  res.json({ ok: true, id, task: toTaskView(row) });
});

app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const { done, title, due, priority, notes } = req.body as {
    done?: boolean;
    title?: string;
    due?: string | null;
    priority?: string;
    notes?: string | null;
  };
  const row = db.prepare('SELECT id, title, done, due, priority, notes, created_at, updated_at FROM tasks WHERE id = ?').get(req.params.id) as
    | TaskRow
    | undefined;
  if (!row) {
    res.status(404).json({ ok: false, code: 'not_found', message: '할 일을 찾을 수 없습니다.' });
    return;
  }
  const nextDue = due === undefined ? row.due : normalizeDue(due);
  db.prepare('UPDATE tasks SET done = ?, title = ?, due = ?, priority = ?, notes = ?, updated_at = ? WHERE id = ?').run(
    done === undefined ? row.done : done ? 1 : 0,
    title ? title.slice(0, 160) : row.title,
    nextDue,
    priority === undefined ? normalizePriority(row.priority) : normalizePriority(priority),
    notes === undefined ? row.notes : notes ? String(notes).slice(0, 800) : null,
    new Date().toISOString(),
    row.id
  );
  const updated = db.prepare('SELECT id, title, done, due, priority, notes, created_at, updated_at FROM tasks WHERE id = ?').get(row.id) as TaskRow;
  res.json({ ok: true, task: toTaskView(updated) });
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ----------------------------- settings --------------------------- */

app.get('/api/settings', requireAuth, (_req, res) => {
  const config = activeConfig();
  res.json({
    ok: true,
    profile: profile(),
    version: APP_VERSION,
    mascots: MASCOTS,
    active: { provider: config.provider, model: config.model },
    provider: config.apiKeyEnc
      ? {
          provider: config.provider,
          label: PROVIDERS[config.provider].label,
          model: config.model,
          connectedAt: config.connectedAt,
        }
      : null,
    providers: providerSummary(),
  });
});

app.put('/api/settings/profile', requireAuth, (req, res) => {
  const body = req.body as Partial<Profile>;
  const current = profile();
  setJson('profile', {
    ...current,
    nickname: (body.nickname ?? current.nickname).slice(0, 40),
    theme: body.theme === 'dark' ? 'dark' : 'light',
    language: body.language === 'en' ? 'en' : 'ko',
    agentName: (body.agentName ?? current.agentName).slice(0, 24) || 'Pomong',
    character: normalizeCharacter(body.character, current.character),
  });
  res.json({ ok: true, profile: profile() });
});

/* --------------------------- models ------------------------------- */

app.get('/api/models', requireAuth, (_req, res) => {
  const state = llmState();
  res.json({
    ok: true,
    active: { provider: state.active.provider, model: normalizeModel(state.active.provider, state.active.model) },
    providers: providerSummary(),
    labels: MODEL_LABELS,
    lastGoodGeminiModel: getJson<string | null>('gemini.lastGoodModel', null),
  });
});

app.post('/api/models/select', requireAuth, (req, res) => {
  const { provider, model } = req.body as { provider?: ProviderId; model?: string };
  if (!provider || !(provider in PROVIDERS)) {
    res.status(400).json({ ok: false, code: 'invalid_provider', message: 'AI 서비스를 선택해 주세요.' });
    return;
  }
  const state = llmState();
  if (!state.accounts[provider]?.apiKeyEnc) {
    res.status(409).json({
      ok: false,
      code: 'provider_not_connected',
      message: `${PROVIDERS[provider].label} 키가 아직 없습니다. 설정에서 키를 연결하면 바로 쓸 수 있어요.`,
      consoleUrl: PROVIDERS[provider].console,
    });
    return;
  }
  const requested = normalizeModel(provider, model || state.active.model);
  if (!PROVIDERS[provider].models.includes(requested)) {
    res.status(400).json({ ok: false, code: 'invalid_model', message: `${PROVIDERS[provider].label}에서 지원하지 않는 모델입니다.` });
    return;
  }
  saveLlmState({ ...state, active: { provider, model: requested } });
  addLog('info', `모델 변경 · ${PROVIDERS[provider].label} ${requested}`);
  res.json({ ok: true, active: { provider, model: requested } });
});

app.post('/api/settings/api-key', requireAuth, async (req, res) => {
  const { provider, apiKey, model } = req.body as { provider?: ProviderId; apiKey?: string; model?: string };
  if (!provider || !(provider in PROVIDERS) || !apiKey?.trim()) {
    res.status(400).json({ ok: false, code: 'invalid_request', message: 'Provider와 API 키를 확인해 주세요.' });
    return;
  }
  const result = await testProvider(provider, apiKey.trim());
  if (!result.ok) {
    res.status(400).json({ ok: false, code: 'provider_test_failed', message: result.message });
    return;
  }
  const { encrypt, serverKey } = await import('./crypto');
  const state = llmState();
  const nextModel = normalizeModel(provider, model || (state.active.provider === provider ? state.active.model : ''));
  saveLlmState({
    active: { provider, model: nextModel },
    accounts: {
      ...state.accounts,
      [provider]: { apiKeyEnc: encrypt(apiKey.trim(), serverKey()), connectedAt: new Date().toISOString() },
    },
  });
  addLog('success', `${PROVIDERS[provider].label} 키를 저장했습니다`);
  res.json({ ok: true, message: result.message, model: nextModel });
});

/* ------------------------------ static ---------------------------- */

function serveSetupLocked(res: Response): void {
  res.status(410).type('html').send(`<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>설정이 완료되었습니다 · ${APP_NAME}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBFBFD;color:#2A2A35;
       font-family:"Spoqa Han Sans Neo","Apple SD Gothic Neo",system-ui,-apple-system,sans-serif}
  .card{background:#fff;border-radius:28px;padding:48px 40px;max-width:420px;text-align:center;
        box-shadow:0 18px 60px rgba(124,99,246,.12)}
  .badge{display:inline-flex;align-items:center;gap:8px;background:#F4F0FF;color:#7C63F6;font-weight:600;
         border-radius:999px;padding:8px 16px;font-size:14px}
  h1{font-size:24px;margin:20px 0 10px}
  p{color:#8A8A9A;line-height:1.6;font-size:15px;margin:0 0 24px}
  a{display:inline-block;background:linear-gradient(135deg,#A18BFF,#8B72F8);color:#fff;text-decoration:none;
    padding:14px 28px;border-radius:16px;font-weight:600}
</style></head><body><div class="card">
<div class="badge">410 · Setup Locked</div>
<h1>설정이 이미 완료되었어요</h1>
<p>보안을 위해 /setup 경로는 잠겼습니다.<br/>이미 만든 관리자 계정으로 로그인해 주세요.</p>
<a href="/login">로그인 화면으로</a>
</div></body></html>`);
}

app.use('/setup', (req, res) => {
  if (setupDone()) {
    serveSetupLocked(res);
    return;
  }
  sendIndex(res);
});

function sendIndex(res: Response): void {
  const file = path.join(CLIENT_DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.status(503).type('text').send('UI is not built. Run `npm run build` first.');
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
}

app.use(
  express.static(CLIENT_DIST, {
    index: false,
    setHeaders: (res, filePath) => {
      if (/\.(js|css|woff2?|png|jpg|svg|webp|ico)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ ok: false, code: 'not_found' });
    return;
  }
  if (req.path === '/setup' && setupDone()) {
    serveSetupLocked(res);
    return;
  }
  if (!fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    next();
    return;
  }
  sendIndex(res);
});

/* ------------------------------ boot ------------------------------ */

const token = setupDone() ? null : ensureSetupToken();

// 저장된 AI 설정을 현재 모델로 정리한다 (구형 모델 → 최신 모델 자동 마이그레이션).
migrateLlmState();
activeConfig();
// 지난번에 실제로 응답한 Gemini 모델을 기억해 두고 우선 시도한다.
setLastGoodGeminiModel(getJson<string | null>('gemini.lastGoodModel', null));

app.listen(PORT, HOST, () => {
  startSampler(3000);
  addLog('success', `Pomong Agent v${APP_VERSION} 가동`);
  const pub = `${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log('');
  console.log('  🫧  Pomong Agent v' + APP_VERSION);
  console.log(`  →  http://${pub}/`);
  if (token) {
    console.log('');
    console.log('  초기 설정을 위해 아래 1회용 주소를 브라우저에서 여세요 (설정 완료 후 잠깁니다):');
    console.log(`  →  http://${pub}/setup?token=${token}`);
    console.log('');
  } else {
    console.log('  초기 설정이 이미 완료되었습니다. 관리자 계정으로 로그인하세요.');
  }
});
