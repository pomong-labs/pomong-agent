import { runAgentStep, type AgentMessage, type ProviderId, type ToolSpec } from './providers';

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
  /** 이전 대화 (system 제외) */
  history: { role: 'user' | 'assistant'; content: string }[];
  tools: ToolSpec[];
  maxSteps: number;
  /** 이 목록에 있는 도구만 실행한다. null/undefined 면 모두 허용 */
  toolsAllow?: string[] | null;
  /** 잡 실행처럼 무인으로 도는 경우: confirm 등급 도구를 만나면 멈춘다 */
  unattended?: boolean;
  /** 이 시각(epoch ms)을 넘으면 중단 */
  deadline?: number;
  cancelled?: () => boolean;
  onStep?: (info: { index: number; text: string; tools: string[] }) => void;
  onToolResult?: (name: string, content: string) => void;
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
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const conversation: AgentMessage[] = [
    { role: 'system', content: options.system },
    ...options.history.map((m) => ({ role: m.role, content: m.content }) as AgentMessage),
  ];

  let model = options.model;
  let reply = '';
  const used: string[] = [];
  const blocked: string[] = [];
  let steps = 0;
  let needsApproval: string | null = null;

  for (let step = 0; step < Math.max(1, options.maxSteps); step += 1) {
    if (options.cancelled?.()) {
      return { text: reply, model, steps, tools: used, blocked, needsApproval, cancelled: true };
    }
    if (options.deadline && Date.now() > options.deadline) {
      if (!reply.trim()) reply = '시간이 초과되어 작업을 멈췄습니다.';
      break;
    }

    const result = await runAgentStep(options.provider, options.apiKey, model, conversation, options.tools, step === 0);
    model = result.model;
    steps += 1;

    if (!result.toolCalls.length) {
      reply = result.text;
      break;
    }

    conversation.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
    if (result.text.trim()) reply = result.text;
    options.onStep?.({ index: step, text: result.text, tools: result.toolCalls.map((c) => c.name) });

    for (const call of result.toolCalls) {
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
      const output = await runTool(call.name, call.args);
      used.push(call.name);
      options.onToolResult?.(call.name, output.content);
      conversation.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output.content });
    }

    if (needsApproval) break;
  }

  return { text: reply, model, steps, tools: used, blocked, needsApproval, cancelled: false };
}

/**
 * 무인 실행(예약 잡)에서 사람 승인이 필요한 도구인지 판단한다.
 * 결제·게시·삭제·전송처럼 되돌릴 수 없는 행동은 잡에서 자동 실행하지 않는다(승인 대기로 끝냄).
 */
export async function needsHumanApproval(name: string, args: Record<string, unknown>): Promise<boolean> {
  if (name.startsWith('browser_')) {
    const { evaluateBrowserAction } = await import('./policy');
    const verdict = evaluateBrowserAction(name, args);
    return verdict.confirm;
  }
  return false;
}
