import { createMaskerIfEnabled, maskDeep, restoreDeep, type PrivacyMasker } from './privacy-mask';

export type ProviderId = 'gemini' | 'openai' | 'claude' | 'exaone';

/** v0.6.2: EXAONE(K-EXAONE 2.5) — LG AI연구원 무료 API, OpenAI 호환 */
export const EXAONE_MODEL = 'k-exaone_v2.5';
export const EXAONE_ENDPOINT = 'https://api.exaone.ai/v1/chat/completions';

/** 사용자가 고르는 추론 강도(3단계) */
export type ExaoneEffort = 'low' | 'medium' | 'high';
export const EXAONE_EFFORTS: ExaoneEffort[] = ['low', 'medium', 'high'];

/** 저장값 정규화(구버전·잘못된 값 방지) */
export function exaoneEffort(value: unknown, fallback: ExaoneEffort = 'low'): ExaoneEffort {
  const name = String(value || '').trim().toLowerCase();
  return (EXAONE_EFFORTS as string[]).includes(name) ? (name as ExaoneEffort) : fallback;
}

/**
 * 화면의 3단계 → EXAONE API가 받는 값.
 * 공식 문서(2026-11)의 reasoning_effort 는 low / high / max 세 가지뿐이라
 * 보통(medium)은 high, 높음(high)은 max 로 보낸다.
 */
export function exaoneApiEffort(effort: ExaoneEffort | undefined): 'low' | 'high' | 'max' {
  if (effort === 'high') return 'max';
  if (effort === 'medium') return 'high';
  return 'low';
}

/** 프로바이더별 추가 설정(지금은 EXAONE 추론 강도만) */
export interface ProviderOptions {
  reasoningEffort?: ExaoneEffort;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 멀티모달 파트 (v0.5.2 / PDF v0.6.5): 채팅에 첨부한 사진·PDF를 AI가 직접 보게 한다.
 * text = 글, image = base64 사진 한 장, pdf = 글자를 뽑지 못한 스캔본 PDF 원본.
 */
export type AgentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; dataBase64: string }
  | { type: 'pdf'; mime: string; dataBase64: string }
  /** v0.6.18: 음성 메모·녹음 파일(.m4a/.mp3/.wav/.ogg/.webm) — Gemini가 직접 듣는다 */
  | { type: 'audio'; mime: string; dataBase64: string };

/** 도구 호출을 주고받는 에이전트 루프용 메시지 (도구 결과 포함) */
export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; parts?: AgentPart[] }
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
  exaone: {
    label: 'EXAONE',
    defaultModel: EXAONE_MODEL,
    models: [EXAONE_MODEL],
    console: 'https://docs.exaone.ai/ko/docs/overview',
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
  'k-exaone_v2.5': 'K-EXAONE 2.5',
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
  'gemini-2.5-flash',
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
  exaone: {},
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

/**
 * v0.5.4: 모델 호출의 시간 제한 신호에 '사용자 중지(■ 중지)' 신호를 합친다.
 * 사용자가 중지하면 진행 중인 fetch도 즉시 끊긴다.
 */
function withCancel(limit: AbortSignal, signal?: AbortSignal): AbortSignal {
  if (!signal) return limit;
  const anyOf = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === 'function') return anyOf([limit, signal]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (limit.aborted || signal.aborted) abort();
  limit.addEventListener('abort', abort, { once: true });
  signal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function errorText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
      description?: string;
    };
    const msg =
      typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message || '';
    if (msg) return `${status}: ${msg}`;
    // EXAONE은 실패를 {result_code, description} 로 돌려준다.
    if (parsed.description) return `${status}: ${parsed.description}`;
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

    if (provider === 'exaone') {
      // EXAONE은 OpenAI 호환이라 /v1/models 로 키를 먼저 확인하고,
      // 목록 주소가 막혀 있으면(404/405) 짧은 대화 요청으로 확인한다.
      const listRes = await fetch('https://api.exaone.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: timeout(15000),
      });
      const listBody = await listRes.text();
      if (listRes.ok) {
        let models: string[] = [];
        try {
          const data = JSON.parse(listBody) as { data?: { id?: string }[] };
          models = (data.data || []).map((m) => String(m.id || '')).filter(Boolean);
        } catch {
          /* 목록이 비어 있어도 키는 유효하다 */
        }
        return {
          ok: true,
          message: 'EXAONE API 키가 확인되었습니다. (K-EXAONE 2.5 · 무료)',
          models: models.filter((m) => m.includes('exaone')).slice(0, 10),
        };
      }
      if (listRes.status !== 404 && listRes.status !== 405) {
        return { ok: false, message: errorText(listRes.status, listBody) };
      }
      const res = await fetch(EXAONE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: EXAONE_MODEL,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 16,
          reasoning_effort: 'low',
          stream: false,
        }),
        signal: timeout(30000),
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, message: errorText(res.status, body) };
      return { ok: true, message: 'EXAONE API 키가 확인되었습니다. (K-EXAONE 2.5 · 무료)', models: [EXAONE_MODEL] };
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  model: string;
  toolCalls: ToolCall[];
  /**
   * v0.6.2: 모델이 왜 멈췄는지(Gemini finishReason, OpenAI finish_reason, Claude stop_reason).
   * 브라우저 작업 중 빈 응답(MALFORMED_FUNCTION_CALL·빈 STOP)을 알아채 재시도하는 데 쓴다.
   */
  finishReason?: string;
  /** v0.7.0: 프로바이더가 돌려준 실제 토큰 사용량(관측성·비용 계산용) */
  usage?: TokenUsage;
  /** v0.7.0: 실시간 스트리밍으로 답변을 받았는지 */
  streamed?: boolean;
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
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
};

/** 메시지의 파트를 프로바이더별 형태로 바꾸는 데 쓰는 공통 변환 */
function textOrParts(turn: { content: string; parts?: AgentPart[] }): AgentPart[] {
  if (turn.parts && turn.parts.length) return turn.parts;
  return turn.content ? [{ type: 'text', text: turn.content }] : [];
}

/** Gemini 요청 본문(스트리밍·비스트리밍 공통) */
function geminiBody(
  system: string,
  contents: { role: 'user' | 'model'; parts: GeminiPart[] }[],
  tools?: ToolSpec[]
): Record<string, unknown> {
  return {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    tools: tools && tools.length
      ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
      : undefined,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1600 },
  };
}

/**
 * 대화 → Gemini contents.
 * Gemini는 같은 역할의 턴이 연달아 오면 합쳐서 보낸다.
 */
function geminiContents(turns: ToolRunMessage[]): { role: 'user' | 'model'; parts: GeminiPart[] }[] {
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
    // v0.5.2: 사진(inlineData)이 붙은 사용자 턴은 따로 보낸다.
    const userParts: GeminiPart[] = [];
    for (const part of textOrParts(turn)) {
      if (part.type === 'text') {
        if (part.text) userParts.push({ text: part.text });
      } else {
        userParts.push({ inlineData: { mimeType: part.mime, data: part.dataBase64 } });
      }
    }
    if (!userParts.length) userParts.push({ text: '' });
    const hasImage = userParts.some((p) => p.inlineData);
    const last = contents[contents.length - 1];
    const lastIsPlainTextUser =
      last && last.role === 'user' && last.parts.every((p) => p.text !== undefined);
    if (!hasImage && lastIsPlainTextUser) {
      last.parts.push(...userParts);
    } else {
      contents.push({ role: 'user', parts: userParts });
    }
  }
  return contents;
}

/** Gemini 파트 → 도구 호출 목록 */
function geminiToolCalls(parts: GeminiPart[], prefix: string): ToolCall[] {
  return parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      id: `${prefix}-${Date.now()}-${i}`,
      name: String(p.functionCall?.name),
      args: (p.functionCall?.args || {}) as Record<string, unknown>,
      signature: p.thoughtSignature,
    }));
}

async function geminiStep(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools?: ToolSpec[],
  signal?: AbortSignal
): Promise<ChatResult> {
  const contents = geminiContents(turns);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody(system, contents, tools)),
      // 모델이 응답하지 않고 매달려 있으면 다음 후보로 빨리 넘어가도록 시도당 시간을 제한한다.
      signal: withCancel(timeout(25000), signal),
    }
  );
  const body = await res.text();
  if (!res.ok) throw new ProviderError(res.status, errorText(res.status, body));
  const data = JSON.parse(body) as {
    candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
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
  return {
    text,
    model: modelName,
    toolCalls,
    finishReason: data.candidates?.[0]?.finishReason,
    usage: geminiUsage(data.usageMetadata),
  };
}

/** v0.7.0: Gemini usageMetadata → 공통 토큰 사용량 */
function geminiUsage(
  meta: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined
): TokenUsage | undefined {
  if (!meta) return undefined;
  const inputTokens = Number(meta.promptTokenCount || 0);
  const outputTokens = Number(meta.candidatesTokenCount || 0);
  if (!inputTokens && !outputTokens) return undefined;
  return { inputTokens, outputTokens };
}

/* ------------------------------------------------------------------ */
/* OpenAI                                                              */
/* ------------------------------------------------------------------ */

type OpenAiMessage = Record<string, unknown>;

/**
 * OpenAI 규격(chat/completions) 메시지 목록을 만든다.
 * v0.6.2: EXAONE도 같은 규격이라 함께 쓴다(사진만 지원하지 않는다).
 */
function openAiMessages(turns: ToolRunMessage[], imageSupport: boolean): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  for (const turn of turns) {
    if (turn.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: turn.toolCallId, content: turn.content });
    } else if (turn.role === 'user' && turn.parts?.some((p) => p.type !== 'text')) {
      const parts = textOrParts(turn);
      // v0.6.5: 사진은 image_url(base64)로, 스캔본 PDF는 이 규격에 파일 입력이 없어 본문 텍스트로 대신한다.
      const texts: string[] = [];
      const media: Record<string, unknown>[] = [];
      const notes: string[] = [];
      for (const part of parts) {
        if (part.type === 'text') {
          if (part.text) texts.push(part.text);
          continue;
        }
        if (part.type === 'image') {
          if (imageSupport) {
            media.push({ type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.dataBase64}` } });
          } else {
            notes.push(
              '[첨부 사진] 이 모델은 사진을 볼 수 없습니다. 사진을 봐야 하는 작업이면 Gemini처럼 사진을 보는 모델로 바꿔 달라고 사용자에게 안내하세요.'
            );
          }
          continue;
        }
        if (part.type === 'audio') {
          notes.push(
            '[첨부 오디오] 이 모델은 음성을 직접 듣지 못합니다. 받아쓰기·요약이 필요하면 Gemini로 바꾸라고 사용자에게 안내하세요.'
          );
          continue;
        }
        // pdf — 글자를 뽑지 못한 스캔본의 원본. 본문 텍스트는 이미 텍스트 파트에 들어 있다.
        notes.push(
          '[첨부 PDF] 이 모델은 PDF 원본 페이지를 직접 볼 수 없습니다. 위 [첨부] 블록의 본문 텍스트로 답하고, 원본 그림을 봐야 한다면 Gemini처럼 PDF를 보는 모델로 바꾸라고 사용자에게 안내하세요.'
        );
      }
      const text = [...texts, ...notes].filter(Boolean).join('\n\n');
      const imageContent = media.length ? [{ type: 'text', text }, ...media] : text;
      messages.push({ role: 'user', content: imageContent });
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
  return messages;
}

async function openAiStep(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools?: ToolSpec[],
  signal?: AbortSignal
): Promise<ChatResult> {
  const messages: OpenAiMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...openAiMessages(turns, true));

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
    signal: withCancel(timeout(60000), signal),
  });
  const body = await res.text();
  if (!res.ok) throw new ProviderError(res.status, errorText(res.status, body));
  const data = JSON.parse(body) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
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
  return {
    text: (message?.content || '').trim(),
    model: modelName,
    toolCalls,
    finishReason: data.choices?.[0]?.finish_reason,
    usage: openAiUsage(data.usage),
  };
}

/** v0.7.0: OpenAI 규격 usage → 공통 토큰 사용량 (EXAONE도 같은 모양) */
function openAiUsage(usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = Number(usage.prompt_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || 0);
  if (!inputTokens && !outputTokens) return undefined;
  return { inputTokens, outputTokens };
}

/* ------------------------------------------------------------------ */
/* EXAONE (K-EXAONE 2.5 · LG AI연구원 무료 API, OpenAI 호환)             */
/* ------------------------------------------------------------------ */

async function exaoneStep(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools?: ToolSpec[],
  options?: ProviderOptions,
  signal?: AbortSignal
): Promise<ChatResult> {
  const messages: OpenAiMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  // K-EXAONE 2.5는 텍스트 전용이다(사진은 안내 문구로 대체).
  messages.push(...openAiMessages(turns, false));

  const effort = exaoneEffort(options?.reasoningEffort);
  const res = await fetch(EXAONE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelName || EXAONE_MODEL,
      messages,
      // 문서 권장값(일반·에이전트 공통): temperature 1.0, top_p 0.95,
      // 이전 턴의 추론을 유지하는 preserve_thinking.
      temperature: 1.0,
      top_p: 0.95,
      // max_tokens 에는 추론 토큰이 포함되므로 넉넉히 준다.
      max_tokens: 4096,
      reasoning_effort: exaoneApiEffort(effort),
      chat_template_kwargs: { preserve_thinking: true },
      stream: false,
      tools: tools && tools.length
        ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
        : undefined,
    }),
    // 추론 모델이라 답이 늦을 수 있다(높음은 더 오래).
    signal: withCancel(timeout(effort === 'high' ? 120_000 : 90_000), signal),
  });
  const body = await res.text();
  if (!res.ok) throw new ProviderError(res.status, errorText(res.status, body));
  const data = JSON.parse(body) as {
    choices?: {
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  const message = choice?.message;
  // reasoning_content(내부 추론)는 사용자에게 보여 주지 않는다 — 최종 답변(content)만 쓴다.
  const text = String(message?.content || '').replace(/^\s+/, '').trim();
  const toolCalls: ToolCall[] = (message?.tool_calls || [])
    .filter((c) => c?.function?.name)
    .map((c, i) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function?.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      return { id: c.id || `exaone-${Date.now()}-${i}`, name: String(c.function?.name), args };
    });
  return {
    text,
    model: modelName || EXAONE_MODEL,
    toolCalls,
    finishReason: choice?.finish_reason,
    usage: openAiUsage(data.usage),
  };
}

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

type ClaudeContent = Record<string, unknown>;

/** 대화 → Claude messages (스트리밍·비스트리밍 공통) */
function claudeMessages(turns: ToolRunMessage[]): { role: 'user' | 'assistant'; content: ClaudeContent[] }[] {
  const messages: { role: 'user' | 'assistant'; content: ClaudeContent[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: ClaudeContent[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const turn of turns) {
    if (turn.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: turn.toolCallId, content: turn.content }]);
    } else if (turn.role === 'user' && turn.parts?.some((p) => p.type !== 'text')) {
      // v0.5.2: 사진은 base64 image 블록으로 넘긴다.
      // v0.6.5: 스캔본 PDF는 document 블록으로 넘겨 페이지를 직접 읽게 한다.
      push(
        'user',
        textOrParts(turn).map((part) => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          if (part.type === 'pdf') {
            return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.dataBase64 } };
          }
          if (part.type === 'audio') {
            return { type: 'text', text: '[첨부 오디오] 이 모델은 음성을 직접 듣지 못합니다. 필요하면 Gemini로 바꾸라고 사용자에게 안내하세요.' };
          }
          return { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.dataBase64 } };
        })
      );
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
  return messages;
}

async function claudeStep(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools?: ToolSpec[]
  , signal?: AbortSignal
): Promise<ChatResult> {
  const messages = claudeMessages(turns);

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
    signal: withCancel(timeout(60000), signal),
  });
  const body = await res.text();
  if (!res.ok) throw new ProviderError(res.status, errorText(res.status, body));
  const data = JSON.parse(body) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
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
  return {
    text,
    model: modelName,
    toolCalls,
    finishReason: data.stop_reason,
    usage: data.usage
      ? { inputTokens: Number(data.usage.input_tokens || 0), outputTokens: Number(data.usage.output_tokens || 0) }
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Streaming (v0.7.0)                                                  */
/* ------------------------------------------------------------------ */

/** 스트리밍 중 클라이언트에 조각을 흘려보내는 통로 */
export interface StreamHooks {
  /** 답변 텍스트 조각(이미 개인정보 자리표시자가 원래 값으로 되돌아간 상태) */
  onDelta?: (text: string) => void;
  /** 같은 스텝에서 첫 시도를 버리고 다시 시작할 때(부분 텍스트가 중복되지 않게 화면을 비운다) */
  onReset?: () => void;
}

/**
 * SSE 본문을 읽어 `data:` 페이로드만 넘긴다.
 * 프로바이더마다 이벤트 모양은 달라도 전송 형식은 같다(data: JSON 한 줄 + 빈 줄).
 */
async function readSse(res: Response, onData: (payload: string) => void): Promise<void> {
  const feed = (chunk: string): void => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      onData(payload);
    }
  };
  if (!res.body) {
    feed(await res.text());
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      feed(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) feed(buffer);
}

type TextSink = (text: string) => void;

/** Gemini 스트리밍 한 번 */
async function geminiStreamAttempt(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools: ToolSpec[] | undefined,
  signal: AbortSignal | undefined,
  onText: TextSink
): Promise<ChatResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(geminiBody(system, geminiContents(turns), tools)),
      signal: withCancel(timeout(90000), signal),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(res.status, errorText(res.status, body));
  }
  let text = '';
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;
  const parts: GeminiPart[] = [];
  await readSse(res, (payload) => {
    let data: {
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    try {
      data = JSON.parse(payload) as typeof data;
    } catch {
      return;
    }
    const candidate = data.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      if (typeof part.text === 'string' && part.text) {
        text += part.text;
        onText(part.text);
      }
      if (part.functionCall?.name || part.thoughtSignature) parts.push(part);
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    const meta = geminiUsage(data.usageMetadata);
    if (meta) usage = meta;
  });
  return {
    text: text.trim(),
    model: modelName,
    toolCalls: geminiToolCalls(parts, 'gemini'),
    finishReason,
    usage,
    streamed: true,
  };
}

/** OpenAI 규격(OpenAI·EXAONE) 스트리밍 한 번 */
async function openAiStreamAttempt(
  endpoint: string,
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools: ToolSpec[] | undefined,
  signal: AbortSignal | undefined,
  onText: TextSink,
  extra: Record<string, unknown>,
  timeoutMs: number,
  idPrefix: string
): Promise<ChatResult> {
  const messages: OpenAiMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...openAiMessages(turns, idPrefix === 'openai'));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: modelName,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      tools: tools && tools.length
        ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
        : undefined,
      ...extra,
    }),
    signal: withCancel(timeout(timeoutMs), signal),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(res.status, errorText(res.status, body));
  }
  let text = '';
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;
  const calls: { id: string; name: string; args: string }[] = [];
  await readSse(res, (payload) => {
    let data: {
      choices?: {
        delta?: {
          content?: string | null;
          tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string | null;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    try {
      data = JSON.parse(payload) as typeof data;
    } catch {
      return;
    }
    const choice = data.choices?.[0];
    const piece = choice?.delta?.content;
    if (typeof piece === 'string' && piece) {
      text += piece;
      onText(piece);
    }
    for (const call of choice?.delta?.tool_calls || []) {
      const index = typeof call.index === 'number' ? call.index : calls.length;
      if (!calls[index]) calls[index] = { id: '', name: '', args: '' };
      if (call.id) calls[index].id = call.id;
      if (call.function?.name) calls[index].name += call.function.name;
      if (call.function?.arguments) calls[index].args += call.function.arguments;
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (data.usage) usage = openAiUsage(data.usage) || usage;
  });
  const toolCalls: ToolCall[] = calls
    .filter((call) => call && call.name)
    .map((call, index) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.args || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      return { id: call.id || `${idPrefix}-${Date.now()}-${index}`, name: call.name, args };
    });
  return { text: text.trim(), model: modelName, toolCalls, finishReason, usage, streamed: true };
}

/** Claude 스트리밍 한 번 */
async function claudeStreamAttempt(
  modelName: string,
  apiKey: string,
  system: string,
  turns: ToolRunMessage[],
  tools: ToolSpec[] | undefined,
  signal: AbortSignal | undefined,
  onText: TextSink
): Promise<ChatResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 1600,
      temperature: 0.7,
      system: system || undefined,
      messages: claudeMessages(turns),
      stream: true,
      tools: tools && tools.length
        ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
        : undefined,
    }),
    signal: withCancel(timeout(90000), signal),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(res.status, errorText(res.status, body));
  }
  let text = '';
  let finishReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  await readSse(res, (payload) => {
    let data: {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      data = JSON.parse(payload) as typeof data;
    } catch {
      return;
    }
    if (data.type === 'message_start') {
      inputTokens = Number(data.message?.usage?.input_tokens || 0);
      outputTokens = Number(data.message?.usage?.output_tokens || 0);
      return;
    }
    if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      blocks.set(Number(data.index || 0), {
        id: String(data.content_block.id || ''),
        name: String(data.content_block.name || ''),
        json: '',
      });
      return;
    }
    if (data.type === 'content_block_delta') {
      if (data.delta?.type === 'text_delta' && data.delta.text) {
        text += data.delta.text;
        onText(data.delta.text);
      } else if (data.delta?.type === 'input_json_delta' && data.delta.partial_json) {
        const block = blocks.get(Number(data.index || 0));
        if (block) block.json += data.delta.partial_json;
      }
      return;
    }
    if (data.type === 'message_delta') {
      if (data.delta?.stop_reason) finishReason = data.delta.stop_reason;
      if (data.usage) {
        inputTokens = Number(data.usage.input_tokens || inputTokens);
        outputTokens = Number(data.usage.output_tokens || outputTokens);
      }
    }
  });
  const toolCalls: ToolCall[] = [...blocks.values()]
    .filter((block) => block.name)
    .map((block, index) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(block.json || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      return { id: block.id || `claude-${Date.now()}-${index}`, name: block.name, args };
    });
  return {
    text: text.trim(),
    model: modelName,
    toolCalls,
    finishReason,
    usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
    streamed: true,
  };
}

/**
 * 스트리밍 시도 자체를 못 하거나(400·404) 끊기면 비스트리밍으로 폴백한다.
 * 이미 화면에 조각을 보냈다면 onReset 으로 비운 뒤 다시 시작한다(글자 중복 방지).
 */
function makeTextSink(hooks: StreamHooks, beforeRestart: () => void): { sink: TextSink; sent: () => boolean; reset: () => void } {
  let sentAny = false;
  return {
    sink: (text: string) => {
      if (!text) return;
      sentAny = true;
      hooks.onDelta?.(text);
    },
    sent: () => sentAny,
    reset: () => {
      sentAny = false;
      beforeRestart();
    },
  };
}

interface StreamRunOptions {
  allowFallback?: boolean;
  signal?: AbortSignal;
  providerOptions?: ProviderOptions;
}

async function streamAgentStepRaw(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: AgentMessage[],
  tools: ToolSpec[] | undefined,
  hooks: StreamHooks,
  options: StreamRunOptions
): Promise<ChatResult> {
  const modelName = normalizeModel(provider, model);
  const { system, turns } = splitSystem(messages);
  const allowFallback = options.allowFallback !== false;

  const attempt = async (candidate: string): Promise<ChatResult> => {
    const handle = makeTextSink(hooks, () => hooks.onReset?.());
    try {
      if (provider === 'gemini') {
        return await geminiStreamAttempt(candidate, apiKey, system, turns, tools, options.signal, handle.sink);
      }
      if (provider === 'openai') {
        return await openAiStreamAttempt(
          'https://api.openai.com/v1/chat/completions',
          candidate,
          apiKey,
          system,
          turns,
          tools,
          options.signal,
          handle.sink,
          { temperature: 0.7, max_tokens: 1600 },
          90000,
          'openai'
        );
      }
      if (provider === 'exaone') {
        const effort = exaoneEffort(options.providerOptions?.reasoningEffort);
        return await openAiStreamAttempt(
          EXAONE_ENDPOINT,
          candidate || EXAONE_MODEL,
          apiKey,
          system,
          turns,
          tools,
          options.signal,
          handle.sink,
          {
            temperature: 1.0,
            top_p: 0.95,
            max_tokens: 4096,
            reasoning_effort: exaoneApiEffort(effort),
            chat_template_kwargs: { preserve_thinking: true },
          },
          effort === 'high' ? 150000 : 120000,
          'exaone'
        );
      }
      return await claudeStreamAttempt(candidate, apiKey, system, turns, tools, options.signal, handle.sink);
    } catch (err) {
      // 조각을 이미 보냈다면 화면을 비우고, 다음 시도(폴백)가 처음부터 다시 그리게 한다.
      if (handle.sent()) handle.reset();
      throw err;
    }
  };

  /** 스트리밍이 불가능하거나(400·404) 스트림이 깨지면 비스트리밍 결과를 그대로 흘려보낸다. */
  const fallbackToBuffered = async (): Promise<ChatResult> => {
    const result = await runAgentStepRaw(
      provider,
      apiKey,
      modelName,
      messages,
      tools,
      allowFallback,
      options.signal,
      options.providerOptions
    );
    if (result.text && hooks.onDelta) hooks.onDelta(result.text);
    return { ...result, streamed: false };
  };

  if (provider === 'gemini') {
    const candidates = allowFallback ? geminiCandidates(modelName) : [modelName];
    const startedAt = Date.now();
    let lastError: unknown = null;
    for (const candidate of candidates) {
      if (lastError && Date.now() - startedAt > 75000) break;
      try {
        const result = await attempt(candidate);
        lastGoodGeminiModel = result.model;
        return result;
      } catch (err) {
        lastError = err;
        if (!allowFallback || !isRetryableError(err)) break;
      }
    }
    /**
     * 스트리밍이 어떤 이유로든 끝내 실패하면(프로바이더가 스트림을 안 열어 주거나, 중간에 끊기거나)
     * 답변을 잃지 않도록 비스트리밍 호출로 한 번 더 간다. 이미 보낸 조각은 위에서 화면을 비웠다.
     */
    return fallbackToBuffered();
  }

  const attempts = allowFallback ? 2 : 1;
  for (let index = 0; index < attempts; index += 1) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      return await attempt(modelName);
    } catch (err) {
      if (!allowFallback || !isRetryableError(err)) break;
    }
  }
  return fallbackToBuffered();
}

/**
 * v0.7.0: 스트리밍 에이전트 스텝.
 * 호출부(agent-loop)는 이 함수만 부르면 ① 개인정보 마스킹 ② 프로바이더별 스트리밍
 * ③ 실패 시 비스트리밍 폴백 ④ 조각 되돌리기(마스킹 복원) 를 모두 처리해 준다.
 */
export async function runAgentStepStreaming(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: AgentMessage[],
  tools: ToolSpec[] | undefined,
  hooks: StreamHooks,
  options: StreamRunOptions = {}
): Promise<ChatResult> {
  const masker = createMaskerIfEnabled();
  const outgoing = masker ? messages.map((message) => maskAgentMessage(message, masker)) : messages;
  if (!masker) {
    return streamAgentStepRaw(provider, apiKey, model, outgoing, tools, hooks, options);
  }
  /**
   * 마스킹 자리표시자(`[전화번호 1]`)가 조각 경계에서 잘리면 복원이 안 된다.
   * 그래서 아직 닫히지 않은 `[` 뒤쪽은 잠깐 붙잡아 두었다가 다음 조각과 합쳐 내보낸다.
   */
  let raw = '';
  let sent = 0;
  const flush = (final: boolean): void => {
    let end = raw.length;
    if (!final) {
      const open = raw.lastIndexOf('[');
      if (open >= 0) {
        const tail = raw.slice(open);
        if (!tail.includes(']') && tail.length < 60) end = open;
      }
    }
    if (end <= sent) return;
    const piece = raw.slice(sent, end);
    sent = end;
    if (piece) hooks.onDelta?.(masker.restore(piece));
  };
  const forward: StreamHooks = {
    onDelta: (text: string) => {
      raw += text;
      flush(false);
    },
    onReset: () => {
      raw = '';
      sent = 0;
      hooks.onReset?.();
    },
  };
  const result = await streamAgentStepRaw(provider, apiKey, model, outgoing, tools, forward, options);
  flush(true);
  return { ...result, text: masker.restore(result.text), toolCalls: result.toolCalls.map((call) => ({ ...call, args: restoreDeep(call.args, masker) })) };
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
  allowFallback = false,
  signal?: AbortSignal,
  providerOptions?: ProviderOptions
): Promise<ChatResult> {
  /**
   * v0.6.18: 외부 AI로 나가기 직전에 개인정보를 가린다(설정에서 끌 수 있다).
   * 대화 전체를 한 번에 훑어 번호를 매기므로, 다음 단계에서 다시 마스킹해도 같은 값은 같은 번호다.
   */
  const masker = createMaskerIfEnabled();
  const outgoing = masker ? messages.map((message) => maskAgentMessage(message, masker)) : messages;
  const result = await runAgentStepRaw(provider, apiKey, model, outgoing, tools, allowFallback, signal, providerOptions);
  if (!masker) return result;
  return restoreChatResult(result, masker);
}

function maskAgentMessage(message: AgentMessage, masker: PrivacyMasker): AgentMessage {
  if (message.role === 'user') {
    return {
      ...message,
      content: masker.mask(message.content),
      parts: message.parts?.map((part) => (part.type === 'text' ? { ...part, text: masker.mask(part.text) } : part)),
    };
  }
  if (message.role === 'assistant') {
    return {
      ...message,
      content: masker.mask(message.content),
      toolCalls: message.toolCalls?.map((call) => ({ ...call, args: maskDeep(call.args, masker) })),
    };
  }
  if (message.role === 'tool') return { ...message, content: masker.mask(message.content) };
  return { ...message, content: masker.mask(message.content) };
}

function restoreChatResult(result: ChatResult, masker: PrivacyMasker): ChatResult {
  return {
    ...result,
    text: masker.restore(result.text),
    toolCalls: result.toolCalls.map((call) => ({ ...call, args: restoreDeep(call.args, masker) })),
  };
}

async function runAgentStepRaw(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: AgentMessage[],
  tools?: ToolSpec[],
  allowFallback = false,
  signal?: AbortSignal,
  providerOptions?: ProviderOptions
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
          const result = await geminiStep(candidate, apiKey, system, turns, tools, signal);
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

  // v0.5.2: OpenAI·Claude·EXAONE도 혼잡(429/5xx)·응답 지연이면 같은 모델로 한 번 더 시도한다.
  // (사용자에게 503이 그대로 노출되지 않게 하는 것이 목적 — 모델은 바꾸지 않는다)
  const attempts = allowFallback ? 2 : 1;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      if (provider === 'openai') return await openAiStep(modelName, apiKey, system, turns, tools, signal);
      if (provider === 'exaone') return await exaoneStep(modelName, apiKey, system, turns, tools, providerOptions, signal);
      return await claudeStep(modelName, apiKey, system, turns, tools, signal);
    } catch (err) {
      lastError = err;
      if (!allowFallback || !isRetryableError(err)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('AI 응답을 받지 못했습니다.');
}

export async function runChat(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): Promise<ChatResult> {
  return runAgentStep(provider, apiKey, model, messages as AgentMessage[], undefined, true);
}

/**
 * v0.6.2: 브라우저 작업 중 모델이 빈 응답으로 멈췄을 때 올려 볼 상위 모델.
 *
 * 크몽 메시지함 작업에서 `gemini-3.1-flash-lite` 가 도구 호출 없이 빈 답을 돌려줘
 * 루프가 그대로 끝나던 문제를 막기 위해, 경량(lite) 모델이면 같은 계열의 상위 플래시
 * 모델로 올린다. 이미 상위 모델이면 null(같은 모델로 한 번 더 시도).
 */
export function higherTierModel(provider: ProviderId, model: string): string | null {
  if (provider !== 'gemini') return null;
  const name = normalizeModel(provider, model);
  if (!/lite/i.test(name)) return null;
  const target = PROVIDERS.gemini.models.find((m) => !/lite/i.test(m));
  return target && target !== name ? target : 'gemini-3.8-flash';
}
