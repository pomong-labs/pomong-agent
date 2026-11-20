import { PROVIDERS, type ProviderId } from './providers';

/**
 * v0.6.3 — 작업별 모델 자동 라우팅
 *
 * 사용자는 작업 유형마다 "채팅 모델 그대로(inherit)" 또는 특정 AI를 지정할 수 있다.
 * 지정한 AI가 연결돼 있으면, 그 작업이 감지됐을 때만 그 AI로 답한다.
 * 지정이 없으면 지금 채팅방에서 고른 모델을 그대로 쓴다(기존 동작).
 */

export type TaskKind = 'chat' | 'browser' | 'vision' | 'writing';

/** inherit = 채팅 모델 그대로 */
export type RouteChoice = 'inherit' | ProviderId;

export interface RoutingSettings {
  chat: RouteChoice;
  browser: RouteChoice;
  vision: RouteChoice;
  writing: RouteChoice;
}

export const TASK_KINDS: TaskKind[] = ['chat', 'browser', 'vision', 'writing'];

export const TASK_KIND_META: Record<TaskKind, { label: string; hint: string }> = {
  chat: { label: '일반 대화', hint: '짧은 질문·잡담' },
  browser: { label: '브라우저 · 로그인 · 작업', hint: '사이트 열기, 로그인, 클릭·입력' },
  vision: { label: '사진 · 파일 분석', hint: '사진을 보고 답하기, 파일 읽기' },
  writing: { label: '요약 · 글쓰기 · 자동화', hint: '요약, 초안, 예약 실행' },
};

export const DEFAULT_ROUTING: RoutingSettings = {
  chat: 'inherit',
  browser: 'inherit',
  vision: 'inherit',
  writing: 'inherit',
};

export function isRouteChoice(value: unknown): value is RouteChoice {
  return value === 'inherit' || (typeof value === 'string' && value in PROVIDERS);
}

export function normalizeRouting(value: unknown): RoutingSettings {
  const raw = (value || {}) as Record<string, unknown>;
  return {
    chat: isRouteChoice(raw.chat) ? raw.chat : 'inherit',
    browser: isRouteChoice(raw.browser) ? raw.browser : 'inherit',
    vision: isRouteChoice(raw.vision) ? raw.vision : 'inherit',
    writing: isRouteChoice(raw.writing) ? raw.writing : 'inherit',
  };
}

/** 사진을 볼 수 있는(AI가 이미지 입력을 받는) 프로바이더 */
export const MULTIMODAL_PROVIDERS: ProviderId[] = ['gemini', 'openai', 'claude'];

export function supportsImages(provider: ProviderId): boolean {
  return MULTIMODAL_PROVIDERS.includes(provider);
}

/* ------------------------------------------------------------------ */
/* 의도 감지                                                            */
/* ------------------------------------------------------------------ */

const BROWSER_RE =
  /(브라우저|사이트|홈페이지|웹페이지|로그인|로그아웃|클릭|입력창|장바구니|주문|결제|예매|예약\s*(해|하|좌석|하려)|접속|열어\s*(줘|봐|서)|검색해서|재고|배송\s*(조회|상태)|가입|회원가입|업로드|다운로드|크롤링|스크래핑|깃허브|github|쿠팡|네이버\s*쇼핑|인스타|유튜브|트위터|디스코드)/i;

const MAIL_RE = /(메일|이메일|메일함|받은\s*편지|보낸\s*편지|지메일|gmail|네이버\s*메일|inbox)/i;

const WRITING_RE =
  /(요약|정리해|정리\s*해|써\s*줘|써줘|작성|번역|다듬|문장|보고서|기획서|블로그|카피|초안|자동화|예약\s*(실행|작업|만들)|매일|매주|매시간|알림\s*만들)/i;

/**
 * 사용자가 이번 턴에 시킨 일이 어떤 종류인지 판단한다.
 * - 사진이 붙어 있으면 vision
 * - 브라우저 조작 지시가 있으면 browser
 * - 메일·요약·글쓰기·자동화 지시가 있으면 writing
 * - 그 밖은 chat
 */
export function detectTaskKind(prompt: string, options: { hasImage?: boolean } = {}): TaskKind {
  if (options.hasImage) return 'vision';
  const text = String(prompt || '');
  if (BROWSER_RE.test(text)) return 'browser';
  if (MAIL_RE.test(text)) return 'writing';
  if (WRITING_RE.test(text)) return 'writing';
  return 'chat';
}

export interface RouteInput {
  taskKind: TaskKind;
  routing: RoutingSettings;
  /** 지금 채팅방에서 고른 프로바이더·모델 */
  active: { provider: ProviderId; model: string };
  /** 키가 연결된 프로바이더 */
  connected: Partial<Record<ProviderId, boolean>>;
}

export interface RouteResult {
  provider: ProviderId;
  model: string;
  /** 왜 이 모델로 갔는지(로그·화면 표시용) */
  reason: 'inherit' | 'task_route' | 'vision_fallback';
  taskKind: TaskKind;
}

/**
 * 작업 유형에 맞는 프로바이더·모델을 고른다.
 * - 지정한 AI가 연결돼 있지 않으면 조용히 채팅 모델을 쓴다(대화가 끊기지 않게).
 * - 사진 작업인데 지금 모델이 사진을 못 보면(EXAONE) 볼 수 있는 AI로 보낸다.
 */
export function resolveRoute(input: RouteInput): RouteResult {
  const choice = input.routing[input.taskKind];
  const active = input.active;
  if (choice && choice !== 'inherit' && choice !== active.provider && input.connected[choice]) {
    return {
      provider: choice,
      model: PROVIDERS[choice].defaultModel,
      reason: 'task_route',
      taskKind: input.taskKind,
    };
  }
  if (input.taskKind === 'vision' && !supportsImages(active.provider)) {
    const fallback = MULTIMODAL_PROVIDERS.find((id) => input.connected[id]);
    if (fallback) {
      return {
        provider: fallback,
        model: PROVIDERS[fallback].defaultModel,
        reason: 'vision_fallback',
        taskKind: input.taskKind,
      };
    }
  }
  return { provider: active.provider, model: active.model, reason: 'inherit', taskKind: input.taskKind };
}

/* ------------------------------------------------------------------ */
/* EXAONE 무료 키 만료                                                  */
/* ------------------------------------------------------------------ */

/** EXAONE 무료 키 유효기간(일) — 문서 기준 30일 */
export const EXAONE_KEY_LIFETIME_DAYS = 30;
/** 만료 며칠 전부터 미리 알릴지 (D-3) */
export const EXAONE_WARN_DAYS = 3;

export interface KeyExpiryStatus {
  /** 키를 등록한 시각(없으면 null) */
  updatedAt: string | null;
  /** 남은 일수(만료일 - 오늘). 지났으면 음수 */
  daysLeft: number | null;
  /** 화면에 보여줄 표기: D-29 / D-3 / 만료됨 / '' */
  label: string;
  /** 곧 만료(D-3 이내) — 알림 대상 */
  warn: boolean;
  expired: boolean;
}

/** 남은 일수 계산(시각 경계는 하루 단위로 센다) */
export function exaoneKeyStatus(updatedAt: string | null | undefined, now: Date = new Date()): KeyExpiryStatus {
  if (!updatedAt) return { updatedAt: null, daysLeft: null, label: '', warn: false, expired: false };
  const start = new Date(updatedAt);
  if (Number.isNaN(start.getTime())) return { updatedAt: null, daysLeft: null, label: '', warn: false, expired: false };
  const dayMs = 24 * 60 * 60 * 1000;
  const elapsed = Math.floor((now.getTime() - start.getTime()) / dayMs);
  const daysLeft = EXAONE_KEY_LIFETIME_DAYS - elapsed;
  if (daysLeft < 0) return { updatedAt, daysLeft, label: '만료됨', warn: true, expired: true };
  return {
    updatedAt,
    daysLeft,
    label: `D-${daysLeft}`,
    warn: daysLeft <= EXAONE_WARN_DAYS,
    expired: false,
  };
}
