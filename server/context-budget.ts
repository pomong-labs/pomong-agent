import type { AgentMessage } from './providers';

/**
 * v0.7.0 — 컨텍스트 자동 압축 & 토큰 예산 관리
 *
 * 에이전트 루프는 한 턴에서 최대 20스텝을 돈다. 브라우저 스냅샷·메일 본문·검색 결과 같은
 * 도구 출력이 스텝마다 대화에 쌓이면, 몇 스텝 만에 입력 토큰이 모델 한도에 가까워진다.
 * 그러면 ① 응답이 느려지고 ② 한도 초과로 호출이 통째로 실패하고 ③ 비용이 치솟는다.
 *
 * 이 모듈은 두 단계로 막는다.
 *   1) **축약(Squeeze)** — 오래된 스텝의 대용량 도구 결과를 앞부분만 남기고 잘라낸다.
 *      최근 결과(기본 3개)는 모델이 지금 쓰는 값이라 건드리지 않는다.
 *   2) **압축(Compaction)** — 그래도 예산을 넘으면, 오래된 대화 묶음을 하나의 시스템
 *      메시지(대화 요약)로 접어 넣는다. 사용자 턴 단위로 잘라서 잘려나간 도구 호출과
 *      그 결과가 짝이 맞지 않는 일(프로바이더 400 오류)이 없게 한다.
 *
 * 요약은 추가 모델 호출 없이 결정적으로 만든다(지연·비용 0). 원문의 앞부분을 그대로
 * 쓰는 추출 요약이라, 모델이 "무슨 일을 했는지"는 유지된다.
 */

/** 기본 토큰 예산(대화 전체). 넘으면 압축을 시작한다. */
export const DEFAULT_CONTEXT_BUDGET = 52_000;

/** 예산 대비 이 비율을 넘으면 압축한다. */
export const COMPACT_THRESHOLD = 0.82;

/** 오래된 도구 결과 하나가 남길 최대 글자 수 */
export const OLD_TOOL_RESULT_LIMIT = 1_600;

/** 아무리 최근이라도 이 길이를 넘는 도구 결과는 잘라 둔다(폭주 방지) */
export const HARD_TOOL_RESULT_LIMIT = 24_000;

/** 최근 도구 결과 몇 개는 원문 그대로 둘지 */
export const KEEP_RECENT_TOOL_RESULTS = 3;

/** 압축할 때 끝부분에 그대로 남길 메시지 수 */
export const KEEP_TAIL_MESSAGES = 8;

/**
 * 글자 수 기반 토큰 추정.
 * 한글·한자·가나는 글자당 1토큰에 가깝고, 라틴 문자·숫자·공백은 4글자에 1토큰 정도다.
 * 정확한 토크나이저는 프로바이더마다 달라, 예산 판단용으로는 이 근사치를 쓴다.
 * (실제 사용량은 프로바이더가 돌려주는 usage 값을 우선한다 — traces.ts)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
      (code >= 0x1100 && code <= 0x11ff) || // 한글 자모
      (code >= 0x3130 && code <= 0x318f) || // 한글 호환 자모
      (code >= 0x3040 && code <= 0x30ff) || // 가나
      (code >= 0x4e00 && code <= 0x9fff) // 한자
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

export function estimateMessageTokens(message: AgentMessage): number {
  let total = estimateTokens(message.content || '') + 4;
  if (message.role === 'user' && message.parts?.length) {
    for (const part of message.parts) {
      if (part.type === 'text') total += estimateTokens(part.text);
      // 사진·PDF·오디오는 프로바이더가 정해진 토큰을 매긴다(대략치).
      else if (part.type === 'image') total += 800;
      else if (part.type === 'pdf') total += 2_000;
      else total += 1_200;
    }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    for (const call of message.toolCalls) total += estimateTokens(JSON.stringify(call.args || {})) + 12;
  }
  return total;
}

export function estimateConversationTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

export interface ContextReport {
  /** 관리 전 토큰 추정 */
  before: number;
  /** 관리 후 토큰 추정 */
  after: number;
  budget: number;
  /** 예산 대비 사용률(0~1+) */
  ratio: number;
  /** 잘라낸 도구 결과 수 */
  trimmed: number;
  /** 잘라내며 아낀 토큰 */
  trimmedTokens: number;
  /** 압축이 일어났는지 */
  compacted: boolean;
  /** 압축으로 접어 넣은 메시지 수 */
  foldedMessages: number;
  /** 압축 요약 토큰 */
  summaryTokens: number;
}

/** 도구 결과를 앞부분만 남긴다. */
export function squeezeLabel(original: number, kept: number): string {
  return `\n\n…[v0.7.0 컨텍스트 축약] 원문 ${original.toLocaleString('en-US')}자 중 앞 ${kept.toLocaleString('en-US')}자만 남겼습니다. 필요한 부분이 잘렸다면 같은 도구를 조건을 바꿔 다시 호출하세요.`;
}

export function squeezeToolResult(content: string, limit: number): string {
  if (content.length <= limit) return content;
  return content.slice(0, limit) + squeezeLabel(content.length, limit);
}

/**
 * 1단계: 오래된 도구 결과 축약.
 * 대화를 뒤에서부터 세어 최근 도구 결과 KEEP_RECENT_TOOL_RESULTS 개는 그대로 둔다.
 * (지금 모델이 보고 판단하는 값이라 잘라 버리면 작업이 흔들린다)
 */
export function squeezeConversation(
  messages: AgentMessage[],
  options: { keepRecent?: number; limit?: number } = {}
): { messages: AgentMessage[]; trimmed: number; savedTokens: number } {
  const keepRecent = options.keepRecent ?? KEEP_RECENT_TOOL_RESULTS;
  const limit = options.limit ?? OLD_TOOL_RESULT_LIMIT;
  const toolIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'tool') toolIndexes.push(index);
  });
  const keepFrom = toolIndexes.length - keepRecent;
  const protectedIndexes = new Set(toolIndexes.slice(Math.max(0, keepFrom)));
  let trimmed = 0;
  let savedTokens = 0;
  const next = messages.map((message, index) => {
    if (message.role !== 'tool') return message;
    const isRecent = protectedIndexes.has(index);
    const cap = isRecent ? HARD_TOOL_RESULT_LIMIT : limit;
    if (message.content.length <= cap) return message;
    const shortened = squeezeToolResult(message.content, cap);
    trimmed += 1;
    savedTokens += estimateTokens(message.content) - estimateTokens(shortened);
    return { ...message, content: shortened };
  });
  return { messages: trimmed ? next : messages, trimmed, savedTokens };
}

/** 압축 요약 한 줄로 만드는 데 쓰는 길이 */
const DIGEST_HEAD = 220;

function digestLine(message: AgentMessage): string | null {
  const head = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > DIGEST_HEAD ? `${flat.slice(0, DIGEST_HEAD)}…` : flat;
  };
  if (message.role === 'user') return `- 사용자: ${head(message.content)}`;
  if (message.role === 'assistant') {
    const tools = (message.toolCalls || []).map((call) => call.name);
    const said = head(message.content);
    if (tools.length && said) return `- 비서: ${said} (도구 ${tools.join(', ')} 호출)`;
    if (tools.length) return `- 비서: 도구 ${tools.join(', ')} 호출`;
    return said ? `- 비서: ${said}` : null;
  }
  if (message.role === 'tool') {
    return `- 도구 결과 ${message.name}: ${head(message.content)}`;
  }
  return null;
}

/**
 * 2단계: 오래된 대화 압축.
 *
 * 자르는 지점은 **사용자 메시지 앞**으로 잡는다. 그래야 잘린 구간이 도구 호출과 그 결과의
 * 한가운데를 끊지 않는다(프로바이더가 "tool_call_id 를 찾을 수 없다"며 400 을 주는 문제 방지).
 */
export function compactConversation(
  messages: AgentMessage[],
  options: { keepTail?: number } = {}
): { messages: AgentMessage[]; compacted: boolean; folded: number; summaryTokens: number } {
  const keepTail = options.keepTail ?? KEEP_TAIL_MESSAGES;
  if (messages.length <= keepTail + 2) {
    return { messages, compacted: false, folded: 0, summaryTokens: 0 };
  }
  // 0번은 시스템 프롬프트다. 그 뒤에서 사용자 메시지 위치를 찾는다.
  const start = messages[0]?.role === 'system' ? 1 : 0;
  const first = messages[start];
  if (!first || first.role !== 'user') {
    return { messages, compacted: false, folded: 0, summaryTokens: 0 };
  }
  // 끝에서 keepTail 개를 남기되, 그 시작은 사용자 메시지여야 한다.
  let cut = Math.max(start + 1, messages.length - keepTail);
  while (cut < messages.length && messages[cut].role !== 'user') cut += 1;
  if (cut >= messages.length) return { messages, compacted: false, folded: 0, summaryTokens: 0 };
  const foldedMessages = messages.slice(start, cut);
  const lines = foldedMessages.map(digestLine).filter((line): line is string => Boolean(line));
  if (!lines.length) return { messages, compacted: false, folded: 0, summaryTokens: 0 };
  const summaryText = [
    `[v0.7.0 자동 압축] 대화가 길어져 앞선 ${foldedMessages.length}개 메시지를 아래처럼 요약해 두었습니다.`,
    '같은 작업의 이전 진행 상황이니 이어서 판단하세요. 더 자세한 내용이 필요하면 도구로 다시 확인하세요.',
    ...lines.slice(-60),
  ].join('\n');
  const summary: AgentMessage = { role: 'system', content: summaryText };
  const next = [...messages.slice(0, start), summary, ...messages.slice(cut)];
  return {
    messages: next,
    compacted: true,
    folded: foldedMessages.length,
    summaryTokens: estimateTokens(summaryText),
  };
}

/**
 * 매 스텝 직전에 부른다. 예산 안이면 도구 결과만 가볍게 축약하고,
 * 예산의 COMPACT_THRESHOLD 를 넘으면 압축까지 한다.
 */
export function manageContext(
  messages: AgentMessage[],
  options: { budget?: number; compactAt?: number; force?: boolean } = {}
): { messages: AgentMessage[]; report: ContextReport } {
  const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET;
  const compactAt = options.compactAt ?? COMPACT_THRESHOLD;
  const before = estimateConversationTokens(messages);

  const squeezed = squeezeConversation(messages);
  let next = squeezed.messages;
  let compacted = false;
  let folded = 0;
  let summaryTokens = 0;

  const afterSqueeze = estimateConversationTokens(next);
  if (options.force || afterSqueeze > budget * compactAt) {
    const result = compactConversation(next);
    next = result.messages;
    compacted = result.compacted;
    folded = result.folded;
    summaryTokens = result.summaryTokens;
  }

  const after = estimateConversationTokens(next);
  return {
    messages: next,
    report: {
      before,
      after,
      budget,
      ratio: budget > 0 ? after / budget : 0,
      trimmed: squeezed.trimmed,
      trimmedTokens: squeezed.savedTokens,
      compacted,
      foldedMessages: folded,
      summaryTokens,
    },
  };
}
