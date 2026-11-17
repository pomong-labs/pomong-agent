export type ProviderId = 'gemini' | 'openai' | 'claude';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 도구 호출을 주고받는 에이전트 루프용 메시지 (도구 결과 포함) */
export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (type: object) */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Gemini 3.x: functionCall 파트를 되돌려 보낼 때 필요한 서명 */
  signature?: string;
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

/** 모델 선택 바에서 쓰는 짧은 표시 이름 */
export const MODEL_LABELS: Record<string, string> = {
  'gemini-3.8-flash': '3.8 Flash',
  'gemini-3.7-flash': '3.7 Flash',
  'gemini-3.6-flash': '3.6 Flash',
  'gemini-3.5-flash': '3.5 Flash',
  'gemini-3.1-flash-lite': '3.1 Flash Lite',
  'gpt-4o-mini': 'GPT-4o mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4.1-mini': 'GPT-4.1 mini',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-opus-4-1': 'Opus 4.1',
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
  'gemini-flash-lite-latest',
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

/** 마지막으로 응답에 성공한 Gemini 모델 (앱 재시작 후에도 설정에 저장해 재사용) */
let lastGoodGeminiModel: string | null = null;

export function setLastGoodGeminiModel(model: string | null): void {
  lastGoodGeminiModel = model;
}

export function getLastGoodGeminiModel(): string | null {
  return lastGoodGeminiModel;
}

/** 요청 모델 + 폴백 체인 (마지막 성공 모델 우선, 중복 제거) */
function geminiCandidates(model: string): string[] {
  const list = [...(lastGoodGeminiModel ? [lastGoodGeminiModel] : []), model, ...GEMINI_FALLBACK_CHAIN];
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

/** 다른 모델로 넘어가 볼 만한 오류인지 (모델 없음·혼잡·일시 장애·응답 지연) */
function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return [404, 429, 500, 502, 503, 504].includes(err.status);
  }
  // 시간 초과(모델이 응답하지 않고 대기)나 네트워크 순단도 다음 모델로 넘어가 본다.
  const name = err instanceof Error ? err.name : '';
  return name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError';
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
  toolCalls: ToolCall[];
}

type ToolRunMessage = AgentMessage;

function splitSystem(messages: AgentMessage[]): { system: string; turns: ToolRunMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (m as { content: string }).content)
    .join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  return { system, turns };
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

type GeminiPart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
};

async function geminiStep(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools?: ToolSpec[]
): Promise<ChatResult> {
  // Gemini는 같은 역할의 턴이 연달아 오면 합쳐서 보낸다.
  const contents: { role: 'user' | 'model'; parts: GeminiPart[] }[] = [];
  for (const turn of turns) {
    if (turn.role === 'tool') {
      const part: GeminiPart = {
        functionResponse: { name: turn.name, response: { result: turn.content } },
      };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && last.parts.every((p) => p.functionResponse)) {
        last.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }
    if (turn.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (turn.content.trim()) parts.push({ text: turn.content });
      for (const call of turn.toolCalls || []) {
        // Gemini 3.x는 functionCall에 thoughtSignature를 함께 돌려보내야 도구 루프를 이어갈 수 있다.
        const part: GeminiPart = { functionCall: { name: call.name, args: call.args } };
        if (call.signature) part.thoughtSignature = call.signature;
        parts.push(part);
      }
      if (!parts.length) parts.push({ text: '' });
      const last = contents[contents.length - 1];
      if (last && last.role === 'model') last.parts.push(...parts);
      else contents.push({ role: 'model', parts });
      continue;
    }
    const last = contents[contents.length - 1];
    if (last && last.role === 'user' && !last.parts.some((p) => p.functionResponse)) {
      last.parts.push({ text: turn.content });
    } else {
      contents.push({ role: 'user', parts: [{ text: turn.content }] });
    }
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        tools: tools && tools.length
          ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
          : undefined,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1600 },
      }),
      // 모델이 응답하지 않고 매달려 있으면 다음 후보로 빨리 넘어가도록 시도당 시간을 제한한다.
      signal: timeout(25000),
    }
  );
  const body = await res.text();
  if (!res.ok) throw new ProviderError(res.status, errorText(res.status, body));
  const data = JSON.parse(body) as {
    candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  };
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      id: `gemini-${Date.now()}-${i}`,
      name: String(p.functionCall?.name),
      args: (p.functionCall?.args || {}) as Record<string, unknown>,
      signature: p.thoughtSignature,
    }));
  return { text, model: modelName, toolCalls };
}

/* ------------------------------------------------------------------ */
/* OpenAI                                                              */
/* ------------------------------------------------------------------ */

type OpenAiMessage = Record<string, unknown>;

async function openAiStep(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools?: ToolSpec[]
): Promise<ChatResult> {
  const messages: OpenAiMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const turn of turns) {
    if (turn.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: turn.toolCallId, content: turn.content });
    } else if (turn.role === 'assistant') {
      const msg: OpenAiMessage = { role: 'assistant', content: turn.content || null };
      if (turn.toolCalls?.length) {
        msg.tool_calls = turn.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      }
      messages.push(msg);
    } else {
      messages.push({ role: 'user', content: turn.content });
    }
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelName,
      messages,
      temperature: 0.7,
      max_tokens: 1600,
      tools: tools && tools.length
        ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
        : undefined,
    }),
    signal: timeout(60000),
  });
  const body = await res.text();
  if (!res.ok) throw new ProviderError(res.status, errorText(res.status, body));
  const data = JSON.parse(body) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    }[];
  };
  const message = data.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (message?.tool_calls || []).map((c, i) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    return { id: c.id || `openai-${Date.now()}-${i}`, name: c.function.name, args };
  });
  return { text: (message?.content || '').trim(), model: modelName, toolCalls };
}

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

type ClaudeContent = Record<string, unknown>;

async function claudeStep(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools?: ToolSpec[]
): Promise<ChatResult> {
  const messages: { role: 'user' | 'assistant'; content: ClaudeContent[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: ClaudeContent[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const turn of turns) {
    if (turn.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: turn.toolCallId, content: turn.content }]);
    } else if (turn.role === 'assistant') {
      const blocks: ClaudeContent[] = [];
      if (turn.content.trim()) blocks.push({ type: 'text', text: turn.content });
      for (const call of turn.toolCalls || []) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      if (!blocks.length) blocks.push({ type: 'text', text: '(계속)' });
      push('assistant', blocks);
    } else {
      push('user', [{ type: 'text', text: turn.content }]);
    }
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 1600,
      temperature: 0.7,
      system: system || undefined,
      messages,
      tools: tools && tools.length
        ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
        : undefined,
    }),
    signal: timeout(60000),
  });
  const body = await res.text();
  if (!res.ok) throw new ProviderError(res.status, errorText(res.status, body));
  const data = JSON.parse(body) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
  };
  const blocks = data.content || [];
  const text = blocks
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('')
    .trim();
  const toolCalls: ToolCall[] = blocks
    .filter((c) => c.type === 'tool_use' && c.name)
    .map((c, i) => ({ id: c.id || `claude-${Date.now()}-${i}`, name: String(c.name), args: c.input || {} }));
  return { text, model: modelName, toolCalls };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

export async function runAgentStep(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: AgentMessage[],
  tools?: ToolSpec[],
  allowFallback = false
): Promise<ChatResult> {
  const modelName = normalizeModel(provider, model);
  const { system, turns } = splitSystem(messages);

  if (provider === 'gemini') {
    const candidates = allowFallback ? geminiCandidates(modelName) : [modelName];
    const startedAt = Date.now();
    let lastError: unknown = null;
    const passes = allowFallback ? 2 : 1;
    // 혼잡(503)은 몇 초 뒤 풀리는 경우가 많아, 모두 실패하면 짧게 쉬었다가 한 번 더 시도한다.
    for (let pass = 0; pass < passes; pass += 1) {
      if (pass > 0) await new Promise((resolve) => setTimeout(resolve, 800));
      for (const candidate of candidates) {
        if (lastError && Date.now() - startedAt > 75000) break; // 전체 예산을 넘기면 여기서 멈춘다
        try {
          const result = await geminiStep(candidate, apiKey, system, turns, tools);
          lastGoodGeminiModel = result.model;
          return result;
        } catch (err) {
          lastError = err;
          if (!allowFallback || !isRetryableError(err)) throw err;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Gemini 응답을 받지 못했습니다.');
  }

  if (provider === 'openai') return openAiStep(modelName, apiKey, system, turns, tools);
  return claudeStep(modelName, apiKey, system, turns, tools);
}

export async function runChat(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): Promise<ChatResult> {
  return runAgentStep(provider, apiKey, model, messages as AgentMessage[], undefined, true);
}
