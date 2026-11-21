import { higherTierModel, runAgentStep, type AgentMessage, type AgentPart, type ProviderId, type ProviderOptions, type ToolSpec } from './providers';
import type { ToolResult } from './tools';
import { EXTERNAL_TOOLS, guardExternalText } from './guardrails';

/**
 * 에이전트 도구 루프 (Phase 1 구조 그대로).
 * 채팅 응답과 예약 실행(잡)이 같은 루프를 쓰도록 한곳에 모았다.
 */

export interface AgentLoopOptions {
  provider: ProviderId;
  apiKey: string;
  model: string;
  /** 시스템 프롬프트 (호출자가 만든다) */
  system: string;
  /** 이전 대화 (system 제외) — parts에 사진이 붙을 수 있다(v0.5.2) */
  history: { role: 'user' | 'assistant'; content: string; parts?: AgentPart[] }[];
  /** 채팅 세션 id — 로그인 카드처럼 화면에 붙는 도구가 쓴다 */
  sessionId?: string;
  tools: ToolSpec[];
  maxSteps: number;
  /** 이 목록에 있는 도구만 실행한다. null/undefined 면 모두 허용 */
  toolsAllow?: string[] | null;
  /** 잡 실행처럼 무인으로 도는 경우: confirm 등급 도구를 만나면 멈춘다 */
  unattended?: boolean;
  /** v0.6.18: 외부 글에서 인젝션·피싱 의심을 걷어냈을 때 알림 */
  onGuardrail?: (name: string, warning: string, findings: { kind: string; label: string }[]) => void;
  /** 이 시각(epoch ms)을 넘으면 중단 */
  deadline?: number;
  cancelled?: () => boolean;
  /** v0.5.4: 사용자가 '■ 중지'를 누르면 전달되는 신호(진행 중인 모델 호출도 끊는다) */
  signal?: AbortSignal;
  onStep?: (info: { index: number; text: string; tools: string[] }) => void;
  /** v0.5.3: flags에는 '금고 계정 없음'같은 서버 판단용 신호가 들어온다. */
  onToolResult?: (name: string, content: string, flags?: ToolResult['flags']) => void;
  /** v0.6.1: 이번 턴 사용자의 실제 요청 문장(전송·답장을 직접 부탁했는지 판단) */
  userRequest?: string;
  /** 도구 실행 직전/직후 (작업 카드 단계 기록용) */
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, content: string, durationMs: number, ok: boolean) => void;
  /** chat_notify: 작업 중간에 사용자에게 먼저 보여 줄 말풍선 */
  onNotify?: (text: string) => void | Promise<void>;
  /** v0.6.2: 프로바이더별 추가 설정(EXAONE 추론 강도 등) */
  providerOptions?: ProviderOptions;
  /**
   * v0.6.18: 되돌리기 어려운 도구(도커 상태 변경)를 실행하기 직전에 호출된다.
   * 승인 카드를 만들었으면 그 id를 돌려주고, 이 턴은 실행하지 않고 멈춘다.
   */
  requestApproval?: (info: {
    name: string;
    args: Record<string, unknown>;
    title: string;
    detail: string;
    reason: string;
  }) => Promise<{ id: string } | null>;
}

export interface AgentLoopResult {
  text: string;
  model: string;
  steps: number;
  tools: string[];
  /** 잡에서 허용되지 않아 실행하지 못한 도구 */
  blocked: string[];
  /** 사람 승인이 필요해 멈춘 도구 (있으면 status=approval_needed) */
  needsApproval: string | null;
  cancelled: boolean;
  /** v0.5.3: 빈 응답을 실제 진행 상황 문장으로 바뀔 때 쓴다. */
  lastTool: { name: string; content: string } | null;
  /** 실패한 도구의 오류 문구 */
  lastError: string | null;
  /** 사용자에게 화면을 넘겼는지(browser_handover 성공) */
  handover: boolean;
  /** v0.6.2: 빈 응답·잘못된 함수 호출로 모델을 다시 불러본 횟수 */
  emptyRetries: number;
  /** v0.6.2: 경량 모델에서 상위 모델로 올렸다면 그 모델 이름 */
  escalatedTo: string | null;
  /** v0.6.18: 승인 카드를 띄우고 멈췄다면 그 카드 정보 */
  approval: { id: string; title: string; detail: string } | null;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const conversation: AgentMessage[] = [
    { role: 'system', content: options.system },
    ...options.history.map(
      (m) =>
        (m.role === 'user'
          ? ({ role: 'user', content: m.content, parts: m.parts } as AgentMessage)
          : ({ role: 'assistant', content: m.content } as AgentMessage))
    ),
  ];

  let model = options.model;
  let reply = '';
  const used: string[] = [];
  const blocked: string[] = [];
  let steps = 0;
  let needsApproval: string | null = null;
  let lastTool: { name: string; content: string } | null = null;
  let lastError: string | null = null;
  let handover = false;
  /** v0.6.1: "시스템상 제한이라 못 한다"며 포기한 답변을 한 번만 되돌린다 */
  let nudges = 0;
  /** v0.6.2: 브라우저 작업 중 빈 응답·잘못된 함수 호출로 다시 시도한 횟수 */
  let emptyRetries = 0;
  let escalatedTo: string | null = null;
  /** v0.6.18: 사용자 승인을 기다리는 카드 */
  let approval: { id: string; title: string; detail: string } | null = null;
  const stopped = (): boolean => Boolean(options.signal?.aborted) || Boolean(options.cancelled?.());

  const done = (extra: Partial<AgentLoopResult> = {}): AgentLoopResult => ({
    text: reply,
    model,
    steps,
    tools: used,
    blocked,
    needsApproval,
    cancelled: false,
    lastTool,
    lastError,
    handover,
    emptyRetries,
    escalatedTo,
    approval,
    ...extra,
  });

  for (let step = 0; step < Math.max(1, options.maxSteps); step += 1) {
    if (stopped()) {
      return done({ cancelled: true });
    }
    if (options.deadline && Date.now() > options.deadline) {
      if (!reply.trim()) reply = '시간이 초과되어 작업을 멈췄습니다.';
      break;
    }

    // v0.5.2: 모델 혼잡(503·high demand)은 어느 단계에서든 대체 모델로 재시도한다.
    let result;
    try {
      result = await runAgentStep(
        options.provider,
        options.apiKey,
        model,
        conversation,
        options.tools,
        true,
        options.signal,
        options.providerOptions
      );
    } catch (err) {
      // 사용자가 중지했거나 응답 대기가 끊긴 경우는 오류가 아니라 '중지'로 끝낸다.
      if (stopped()) return done({ cancelled: true });
      throw err;
    }
    model = result.model;
    steps += 1;

    if (!result.toolCalls.length) {
      /**
       * v0.6.2: 브라우저 작업 도중 모델이 `toolCalls: []` + 빈 텍스트로 멈추거나
       * Gemini가 MALFORMED_FUNCTION_CALL 로 끊기면, 루프를 그대로 끝내지 않고
       * 경량 모델이면 상위 모델로 올려 이어서 실행하게 한다.
       * (2026-11-20 크몽 메시지함: 3.1-flash-lite가 방 클릭 뒤 빈 응답으로 종료)
       */
      const empty = isEmptyOrMalformedReply(result);
      const plan = planEmptyRecovery({
        empty: empty.empty,
        malformed: empty.malformed,
        browserUsed: used.some((name) => name.startsWith('browser_')),
        retriesUsed: emptyRetries,
        handover,
        stopped: stopped(),
      });
      if (plan.retry) {
        emptyRetries += 1;
        reply = '';
        const escalated = higherTierModel(options.provider, model);
        if (escalated && escalated !== model) {
          model = escalated;
          escalatedTo = escalated;
        }
        conversation.push({
          role: 'system',
          content: EMPTY_RETRY_NUDGE + (empty.malformed ? EMPTY_RETRY_NUDGE_MALFORMED : ''),
        });
        continue;
      }
      reply = result.text;
      /**
       * v0.6.1: 사용자가 전송·답장·댓글을 직접 부탁했는데, 브라우저를 몇 단계만 만져 보고
       * "시스템상 제한이 있어 어렵습니다 / 직접 복사해서 보내세요"로 끝내는 경우
       * (IMG_3605 · 3.1 Flash Lite) — 한 번만 같은 조건으로 다시 시켜 끝까지 하게 한다.
       */
      const gaveUp = /(시스템\s*상?\s*(제한|오류|문제)|권한이\s*없|보안\s*정책상|불가능|어렵습니다|어려워요|할\s*수\s*없|직접\s*(복사|입력|붙여)|복사해서\s*(보내|전송|붙)|대신\s*직접)/.test(
        reply
      );
      const typedAlready = used.some((name) => name === 'browser_type' || name === 'browser_fill_vault');
      if (
        gaveUp &&
        nudges < 1 &&
        !handover &&
        !options.cancelled?.() &&
        used.some((name) => name.startsWith('browser_')) &&
        !typedAlready
      ) {
        const { userRequestedPublish } = await import('./policy');
        const explicitSend = userRequestedPublish(options.userRequest || '');
        if (explicitSend) {
          nudges += 1;
          reply = '';
          conversation.push({
            role: 'system',
            content: '[서버 점검] 사용자가 이번 요청에서 메시지·답장 전송을 직접 부탁했습니다. "시스템상 제한", "직접 복사해서 보내세요" 같은 말로 끝내지 말고 지금 바로 이어서 실행하세요: browser_snapshot으로 현재 화면 확인 → 대화방·문의 열기(browser_click) → 입력창에 browser_type(답장 내용) → 전송 버튼 browser_click 또는 browser_type(pressEnter: true). 결제만 하지 말고, 보내기까지 끝낸 뒤 결과를 알려 주세요.',
          });
          continue;
        }
      }
      break;
    }

    conversation.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
    if (result.text.trim()) reply = result.text;
    options.onStep?.({ index: step, text: result.text, tools: result.toolCalls.map((c) => c.name) });

    for (const call of result.toolCalls) {
      if (stopped()) return done({ cancelled: true });
      if (options.toolsAllow && options.toolsAllow.length && !options.toolsAllow.includes(call.name)) {
        blocked.push(call.name);
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: `이 작업에서는 '${call.name}' 도구를 쓸 수 없습니다. 다른 방법을 찾거나, 됐다면 결과를 정리해 알려 주세요.`,
        });
        continue;
      }
      if (call.name === 'chat_notify') {
        const text = String(call.args?.text || '').trim();
        if (text) {
          options.onToolStart?.('chat_notify', call.args);
          try {
            await options.onNotify?.(text);
            options.onToolEnd?.('chat_notify', text, 0, true);
          } catch {
            options.onToolEnd?.('chat_notify', text, 0, false);
          }
        }
        used.push('chat_notify');
        conversation.push({ role: 'tool', toolCallId: call.id, name: 'chat_notify', content: `사용자에게 "${text}" 안내를 보냈습니다.` });
        continue;
      }
      /**
       * v0.6.18: 민감한 도구는 실행 전에 멈추고 승인 카드를 띄운다.
       * (도커 stop/restart/start/pause/unpause — 되돌리기 어려운 상태 변경)
       */
      if (options.requestApproval) {
        const { sensitiveToolCall } = await import('./approvals');
        const risk = sensitiveToolCall(call.name, call.args);
        if (risk) {
          const card = await options.requestApproval({ name: call.name, args: call.args, ...risk });
          if (card) {
            approval = { id: card.id, title: risk.title, detail: risk.detail };
            needsApproval = call.name;
            conversation.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: '이 작업은 사용자 승인 카드가 떠 있어 아직 실행하지 않았습니다. 사용자가 승인하면 이어서 실행됩니다.',
            });
            break;
          }
        }
      }
      if (options.unattended && (await needsHumanApproval(call.name, call.args))) {
        needsApproval = call.name;
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: '이 단계는 사람의 승인이 필요해 실행하지 않았습니다.',
        });
        break;
      }
      const { runTool } = await import('./tools');
      const startedAt = Date.now();
      options.onToolStart?.(call.name, call.args);
      let output: ToolResult;
      try {
        output = await runTool(call.name, call.args, { session: options.sessionId, userRequest: options.userRequest });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        options.onToolEnd?.(call.name, message, Date.now() - startedAt, false);
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: `도구 실행 중 오류가 났습니다: ${message}`,
        });
        continue;
      }
      /**
       * v0.6.18: 바깥에서 온 글(웹페이지·메일·첨부)은 모델에 넣기 전에 가드레일을 거친다.
       * 안에 섞인 지시문은 가리고, 피싱 의심 링크는 표시한다.
       */
      if (EXTERNAL_TOOLS.has(call.name)) {
        const guarded = guardExternalText(output.content, call.name.startsWith('browser_') ? '웹페이지' : undefined);
        if (guarded.findings.length) {
          output = { ...output, content: guarded.text };
          options.onGuardrail?.(call.name, guarded.warning, guarded.findings);
        }
      }
      used.push(call.name);
      lastTool = { name: call.name, content: output.content };
      if (call.name === 'browser_handover') handover = true;
      options.onToolEnd?.(call.name, output.content, Date.now() - startedAt, true);
      options.onToolResult?.(call.name, output.content, output.flags);
      conversation.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output.content });
    }

    if (needsApproval) break;
  }

  return done();
}

/** v0.6.2: 빈 응답·잘못된 함수 호출을 몇 번까지 다시 시도할지 */
export const MAX_EMPTY_RETRIES = 2;

/** v0.6.2: 빈 응답으로 브라우저 작업이 끊겼을 때 모델에게 다시 넣는 지시 */
export const EMPTY_RETRY_NUDGE =
  '[서버 점검] 작업이 아직 끝나지 않았습니다. 현재 열린 화면을 browser_snapshot으로 확인하고 요청된 입력(browser_type)·전송(browser_click)까지 끝까지 완료하세요.';
export const EMPTY_RETRY_NUDGE_MALFORMED =
  ' (모델이 잘못된 함수 호출 형식을 보내 응답이 끊겼습니다. 도구 인자를 JSON 스키마에 맞게 다시 보내세요.)';

/**
 * 브라우저 작업 중 빈 응답이 났을 때 다시 시도할지 판단한다(v0.6.2).
 * 브라우저를 만진 뒤에만 재시도하고, 이미 화면을 사용자에게 넘겼거나
 * 재시도 한도를 다 썼거나 사용자가 중지했으면 멈춘다.
 */
export function planEmptyRecovery(input: {
  empty: boolean;
  malformed: boolean;
  browserUsed: boolean;
  retriesUsed: number;
  handover: boolean;
  stopped: boolean;
}): { retry: boolean; reason: 'empty' | 'malformed' | null } {
  const reason: 'empty' | 'malformed' | null = input.malformed ? 'malformed' : input.empty ? 'empty' : null;
  if (!reason) return { retry: false, reason: null };
  if (!input.browserUsed) return { retry: false, reason: null };
  if (input.retriesUsed >= MAX_EMPTY_RETRIES) return { retry: false, reason: null };
  if (input.handover || input.stopped) return { retry: false, reason: null };
  return { retry: true, reason };
}

/**
 * 모델이 도구 호출 없이 끝났을 때, 이것이 '빈 응답'인지 '잘못된 함수 호출'인지 판단한다.
 * (v0.6.2 — 브라우저 작업이 중간에 끊기는 원인을 구분해 재시도 조건으로 쓴다)
 */
export function isEmptyOrMalformedReply(result: { text: string; toolCalls: unknown[]; finishReason?: string }): {
  empty: boolean;
  malformed: boolean;
} {
  const reason = String(result.finishReason || '').toUpperCase();
  const malformed = /MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|MALFORMED/.test(reason);
  const empty = !result.toolCalls.length && String(result.text || '').trim() === '';
  return { empty, malformed };
}

/**
 * 모델이 빈 텍스트를 돌려줬을 때, 지금까지의 실제 상태를 알리는 문장 (v0.5.3).
 * 예전에는 "확인했어요. 더 도와드릴 일이 있을까요?"라는, 실제 진행과 무관한 문구가 나갔다.
 */
export function buildEmptyReply(
  result: AgentLoopResult,
  context: { browserUsed?: boolean; loginCardService?: string | null } = {}
): string {
  const reason = (result.lastError || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  if (context.loginCardService) {
    return `${context.loginCardService} 로그인 카드가 위에 떴어요. 카드에 계정 정보를 입력해 주시면 이어서 로그인할게요!`;
  }
  if (result.handover) {
    return '로그인·인증 화면에서 멈췄어요. 브라우저 화면에서 직접 마무리해 주시면 그다음부터 제가 이어서 할게요.';
  }
  if (result.blocked.length) {
    return `${result.blocked[0]} 작업은 허용되지 않아 진행하지 못했어요. 다른 방법으로 도와드릴까요?`;
  }
  if (context.browserUsed) {
    const tail = reason ? ` (${reason})` : '';
    const retried = result.escalatedTo
      ? ` ${result.escalatedTo} 모델로 올려 ${result.emptyRetries}번 더 시도했지만 끝까지 가지 못했어요.`
      : result.emptyRetries
        ? ` ${result.emptyRetries}번 더 시도했지만 끝까지 가지 못했어요.`
        : '';
    return `브라우저 작업 중 다음 단계로 넘어가지 못했어요${tail}.${retried} 브라우저 탭의 화면 보기로 현재 상태를 확인해 보시겠어요?`;
  }
  if (result.tools.length) {
    const tail = reason ? ` (${reason})` : '';
    return `요청하신 작업을 끝까지 마치지 못했어요${tail}. 다시 한 번 시도해 볼까요?`;
  }
  return '요청을 이해하지 못했어요. 조금 더 구체적으로 말씀해 주시겠어요?';
}

/**
 * 무인 실행(예약 잡)에서 사람 승인이 필요한 도구인지 판단한다.
 * 결제·게시·삭제·전송처럼 되돌릴 수 없는 행동은 잡에서 자동 실행하지 않는다(승인 대기로 끝냄).
 */
export async function needsHumanApproval(name: string, args: Record<string, unknown>): Promise<boolean> {
  // 무인 실행에서 금고 비밀번호를 꺼내 로그인하는 것은 사람 확인 없이 하지 않는다.
  if (name === 'browser_fill_vault') return true;
  // 로그인 카드를 띄우는 것도 채팅 화면의 사용자에게 묻는 일이라 무인 실행에서는 멈춘다.
  if (name === 'vault_request_login') return true;
  if (name.startsWith('browser_')) {
    const { evaluateBrowserAction } = await import('./policy');
    const verdict = evaluateBrowserAction(name, args);
    return verdict.confirm;
  }
  return false;
}
