/**
 * v0.7.1 — 브라우저 화면을 돌려받은 뒤 대화 자동 재개 판단
 *
 * 사용자가 '브라우저 화면 보기'에서 2단계 인증·캡차를 마치고 [인증 완료 · 이어서 진행]을 누르면
 * 그 대화의 에이전트 턴을 서버가 스스로 이어서 실행한다. 사용자가 채팅에 "다 됐어"를
 * 치지 않아도 되지만, 같은 버튼을 두 번 누르거나 요청이 겹치면 턴이 두 번 돌 수 있다.
 * 그래서 판단을 순수 함수로 떼어 두고 여기서 한 번만 결정한다(테스트 가능).
 */

/** 같은 대화에서 이 시간(20초) 안에 다시 요청되면 무시한다. */
export const HANDOVER_RESUME_COOLDOWN_MS = 20_000;

export interface HandoverResumeInput {
  /** 화면을 넘긴 대화방 id (없으면 자동 재개할 대상이 없다) */
  convId: string | null;
  /** 지금 시각(epoch ms) */
  now: number;
  /** 같은 대화의 직전 자동 재개 시각(없으면 null) */
  previousAt: number | null;
  /** 그 대화에서 이미 턴이 돌고 있는지 */
  busy: boolean;
  /** 그 대화에 이어 갈 대화 기록이 있는지 */
  hasHistory: boolean;
  cooldownMs?: number;
}

export type HandoverResumeReason = 'no_conversation' | 'duplicate' | 'busy' | 'empty';

export function handoverResumeDecision(input: HandoverResumeInput): { started: boolean; reason?: HandoverResumeReason } {
  if (!input.convId) return { started: false, reason: 'no_conversation' };
  const cooldown = input.cooldownMs ?? HANDOVER_RESUME_COOLDOWN_MS;
  if (input.previousAt && input.now - input.previousAt < cooldown) return { started: false, reason: 'duplicate' };
  if (input.busy) return { started: false, reason: 'busy' };
  if (!input.hasHistory) return { started: false, reason: 'empty' };
  return { started: true };
}

/**
 * 모델에게 넣을 시스템 트리거 문장.
 * 인증이 아직 남아 있으면 넘기기를 다시 안내하고, 끝났으면 '처음부터'가 아니라
 * '직전에 하던 다음 단계부터' 이어서 하도록 분명히 적는다.
 */
export function handoverResumeTrigger(input: {
  stillVerifying: boolean;
  label?: string | null;
  url?: string | null;
  title?: string | null;
}): string {
  const where = input.url
    ? `현재 브라우저는 ${input.url}${input.title ? ` (${input.title})` : ''} 입니다.`
    : '현재 브라우저 화면은 browser_snapshot으로 확인할 수 있습니다.';
  if (input.stillVerifying) {
    return (
      `[시스템] 사용자가 화면을 돌려주었지만 아직 ${input.label || '추가 인증'} 화면이 남아 있을 수 있습니다. ${where} ` +
      'browser_snapshot으로 지금 상태를 확인하고, 인증이 남아 있으면 browser_handover로 다시 넘기며 한 줄로 안내하세요. ' +
      '이미 끝났다면 직전에 요청받은 작업을 이어서 진행하세요. vault_request_login(로그인 카드)은 다시 띄우지 마세요.'
    );
  }
  return (
    `[시스템] 사용자가 브라우저 화면에서 인증을 마치고 화면을 돌려주었습니다. ${where} ` +
    'browser_snapshot으로 추가 인증 화면을 벗어났는지 확인하고, 직전에 요청받은 작업을 처음부터 다시 시작하지 말고 ' +
    '그 다음 단계부터 바로 이어서 진행하세요. vault_request_login(로그인 카드)은 다시 띄우지 마세요. ' +
    '끝나면 무엇이 되었는지 한두 줄로 알려 주세요.'
  );
}
