export type ProviderId = 'gemini' | 'openai' | 'claude';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const PROVIDERS: Record<ProviderId, { label: string; defaultModel: string; models: string[]; console: string }> = {
  gemini: {
    label: 'Gemini',
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
    console: 'https://aistudio.google.com/apikey',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    console: 'https://platform.openai.com/api-keys',
  },
  claude: {
    label: 'Claude',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
    console: 'https://console.anthropic.com/settings/keys',
  },
};

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  models?: string[];
}

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Gemini 모델 자동 폴백 순서.
 * 구글이 구형 모델을 신규 사용자에게 닫으면(404) 또는 혼잡(503/429)이면 다음 모델로 넘어간다.
 */
export const GEMINI_FALLBACK_CHAIN: string[] = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

/** 지원이 종료된 구형 모델 → 현재 모델 매핑 (저장된 설정 자동 마이그레이션용) */
const LEGACY_MODEL_MAP: Record<ProviderId, Record<string, string>> = {
  gemini: {
    'gemini-2.5-flash': 'gemini-3.8-flash',
    'gemini-2.5-pro': 'gemini-3.8-flash',
    'gemini-2.0-flash': 'gemini-3.8-flash',
    'gemini-1.5-flash': 'gemini-3.8-flash',
    'gemini-1.5-pro': 'gemini-3.8-flash',
  },
  openai: {},
  claude: {},
};

/** 저장된 모델 이름을 현재 사용 가능한 모델로 정규화한다. */
export function normalizeModel(provider: ProviderId, model: string | undefined | null): string {
  const fallback = PROVIDERS[provider].defaultModel;
  const name = (model || '').trim();
  if (!name) return fallback;
  return LEGACY_MODEL_MAP[provider][name] || name;
}

/** 요청 모델 + 폴백 체인 (중복 제거) */
function geminiCandidates(model: string): string[] {
  const list = [model, ...GEMINI_FALLBACK_CHAIN];
  return list.filter((m, i) => m && list.indexOf(m) === i);
}

export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** 다른 모델로 넘어가 볼 만한 오류인지 (모델 없음·혼잡·일시 장애) */
function isRetryable(status: number): boolean {
  return status === 404 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function errorText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const msg =
      typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message || '';
    if (msg) return `${status}: ${msg}`;
  } catch {
    /* not json */
  }
  return `${status}: ${body.slice(0, 200)}`;
}

export async function testProvider(provider: ProviderId, apiKey: string): Promise<ProviderTestResult> {
  try {
    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
        signal: timeout(15000),
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, message: errorText(res.status, body) };
      const data = JSON.parse(body) as { models?: { name: string }[] };
      const models = (data.models || []).map((m) => m.name.replace(/^models\//, '')).filter((n) => n.startsWith('gemini'));
      return { ok: true, message: 'Gemini API 키가 확인되었습니다.', models: models.slice(0, 20) };
    }

    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: timeout(15000),
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, message: errorText(res.status, body) };
      const data = JSON.parse(body) as { data?: { id: string }[] };
      const models = (data.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id));
      return { ok: true, message: 'OpenAI API 키가 확인되었습니다.', models: models.slice(0, 20) };
    }

    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      signal: timeout(15000),
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, message: errorText(res.status, body) };
    const data = JSON.parse(body) as { data?: { id: string }[] };
    const models = (data.data || []).map((m) => m.id);
    return { ok: true, message: 'Claude API 키가 확인되었습니다.', models: models.slice(0, 20) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `연결 실패: ${message}` };
  }
}

export interface ChatResult {
  text: string;
  model: string;
}

async function geminiChat(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ChatMessage[]
): Promise<ChatResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: turns.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { temperature: 0.7, maxOutputTokens: 1600 },
      }),
      signal: timeout(60000),
    }
  );
  const body = await res.text();
  if (!res.ok) throw new ProviderError(res.status, errorText(res.status, body));
  const data = JSON.parse(body) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return { text: text || '(빈 응답)', model: modelName };
}

export async function runChat(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): Promise<ChatResult> {
  const modelName = normalizeModel(provider, model);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');

  if (provider === 'gemini') {
    // 신규 사용자에게 닫힌 모델(404)이나 일시적 혼잡(503)이면 다음 모델로 자동 폴백한다.
    let lastError: unknown = null;
    for (const candidate of geminiCandidates(modelName)) {
      try {
        return await geminiChat(candidate, apiKey, system, turns);
      } catch (err) {
        lastError = err;
        if (!(err instanceof ProviderError) || !isRetryable(err.status)) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Gemini 응답을 받지 못했습니다.');
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'system', content: system }, ...turns].filter((m) => m.content),
        temperature: 0.7,
        max_tokens: 1600,
      }),
      signal: timeout(60000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(errorText(res.status, body));
    const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
    return { text: (data.choices?.[0]?.message?.content || '(빈 응답)').trim(), model: modelName };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 1600,
      temperature: 0.7,
      system: system || undefined,
      messages: turns.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    }),
    signal: timeout(60000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(errorText(res.status, body));
  const data = JSON.parse(body) as { content?: { type: string; text?: string }[] };
  const text = (data.content || []).map((c) => (c.type === 'text' ? c.text || '' : '')).join('').trim();
  return { text: text || '(빈 응답)', model: modelName };
}
