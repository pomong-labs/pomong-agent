import type { PersonaId } from './api';

/**
 * AI 성격·말투 프리셋 (v0.5.6)
 *
 * 설정 화면에서 고른 성격은 서버 `profile.persona`로 저장되고,
 * 채팅 시스템 프롬프트에 그대로 들어간다. 여기 예시는 저장 전에
 * "이 성격으로 말하면 이렇게 답해요"를 보여 주기 위한 미리보기다.
 */
export interface PersonaOption {
  id: PersonaId;
  label: string;
  hint: string;
  emoji: string;
  /** 실제 프롬프트에 들어가는 성격 설명 (짧게 보여 준다) */
  summary: string;
}

export const PERSONA_OPTIONS: PersonaOption[] = [
  {
    id: 'default',
    label: '포몽',
    hint: '다정하고 발랄',
    emoji: '🫧',
    summary: '포몽 캐릭터처럼 다정하고 발랄하게, 필요한 건 꼼꼼히 챙깁니다.',
  },
  {
    id: 'calm',
    label: '차분한 비서',
    hint: '낮고 안정적인 어조',
    emoji: '🗂️',
    summary: '감탄·농담 없이 담담하게, 결론과 근거를 차분히 정리해 전합니다.',
  },
  {
    id: 'bright',
    label: '밝고 친근한 파트너',
    hint: '활기찬 응원',
    emoji: '☀️',
    summary: '밝은 에너지로 먼저 반기고, 짧게 응원하며 기분 좋게 도와줍니다.',
  },
  {
    id: 'concise',
    label: '간결한 핵심 요약형',
    hint: '한 줄·불릿 중심',
    emoji: '⚡',
    summary: '군더더기 없이 핵심만. 결론 → 근거 순서의 짧은 불릿으로 답합니다.',
  },
  {
    id: 'witty',
    label: '유쾌하고 재치 있는 동료',
    hint: '가벼운 농담',
    emoji: '🎈',
    summary: '한 줄 농담을 곁들이되, 필요한 정보는 정확하게 챙겨 줍니다.',
  },
  {
    id: 'custom',
    label: '직접 입력',
    hint: '한 줄로 성격 지정',
    emoji: '✍️',
    summary: '원하는 성격을 한 줄로 적으면 그대로 반영합니다.',
  },
];

export const DEFAULT_PERSONA_EXAMPLE: Record<string, { polite: string; casual: string }> = {
  default: {
    polite:
      '서울은 지금 흐리고 3도예요. 오후에 비 소식이 있으니 우산을 챙기시는 게 좋겠어요. 제가 알림을 맞춰 둘까요?',
    casual: '서울은 지금 흐리고 3도야. 오후에 비 온대, 우산 챙겨! 알림 맞춰 줄까?',
  },
  calm: {
    polite: '확인했습니다. 서울 현재 3도, 오후 강수 가능성이 있습니다. 우산을 챙기시기를 권합니다.',
    casual: '확인했어. 서울 지금 3도, 오후에 비 올 가능성 있어. 우산 챙기는 게 좋겠어.',
  },
  bright: {
    polite: '홍길동님, 좋은 아침이에요! ☀️ 서울은 3도에 흐린 하늘이에요. 오후엔 비가 온다니 우산 챙겨요!',
    casual: '홍길동아 좋은 아침! ☀️ 서울 3도에 흐려. 오후에 비 온다니까 우산 꼭 챙겨!',
  },
  concise: {
    polite: '서울 · 3도 · 흐림\n오후 비 가능성 → 우산 필요',
    casual: '서울 · 3도 · 흐림\n오후 비 → 우산 챙겨',
  },
  witty: {
    polite: '3도에 오후 비라니, 오늘 우산은 필수템이에요. 안 챙기면 머리부터 젖습니다 🎈',
    casual: '3도에 오후 비라니, 오늘 우산은 필수템이야. 안 챙기면 머리부터 젖는다? 🎈',
  },
  custom: {
    polite: '“말은 짧게, 챙길 건 다 챙기는” 성격이면 이렇게 답해요. 서울 3도, 오후 비 소식이에요. 우산 챙기시고, 필요하시면 제가 알림도 맞춰 둘게요.',
    casual: '“말은 짧게, 챙길 건 다 챙기는” 성격이면 이렇게 답해. 서울 3도, 오후 비 소식이야. 우산 챙기고, 알림도 맞춰 줄까?',
  },
};

/** 설정 화면 미리보기 문구 */
export function personaExample(
  id: PersonaId,
  options: { callName: string; agentName: string; polite: boolean; custom?: string }
): string {
  const agent = options.agentName || 'Pomong';
  const call = options.callName;
  const base = DEFAULT_PERSONA_EXAMPLE[id] || DEFAULT_PERSONA_EXAMPLE.default;
  let line = options.polite ? base.polite : base.casual;
  if (id === 'custom' && options.custom?.trim()) {
    // 직접 입력한 성격을 미리보기에 그대로 보여 준다.
    line = options.polite
      ? `“${options.custom.trim()}” 성격으로 답한다면 — ${line}`
      : `“${options.custom.trim()}” 성격이라면 — ${line}`;
  }
  const prefix = options.polite ? `${agent}: ` : `${agent}: `;
  return `${call}: 오늘 날씨 어때?\n${prefix}${line}`;
}
