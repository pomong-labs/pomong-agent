/**
 * 앱 글꼴 선택 (v0.6.4 → v0.6.18)
 *
 * - 기본: 지금까지 쓰던 Spoqa Han Sans Neo (index.html CDN)
 * - 프리텐다드: Pretendard (jsDelivr 공식 배포 CSS, index.html)
 * - 카카오 큰글씨: Kakao Big Sans (public/fonts/kakao-bigsans 로컬 woff2)
 * - 페이퍼로지: Paperlogy (OFL · public/fonts/paperlogy 로컬 woff2)
 * - 나눔스퀘어 라운드: NanumSquareRound (OFL · public/fonts/nanumsquareround 로컬 woff2)
 *
 * 고른 글꼴은 서버 프로필(profile.font)에 저장해 새로고침·다른 기기에서도 유지하고,
 * 첫 페인트 전에 index.html 인라인 스크립트가 localStorage 값으로 먼저 칠해 깜빡임을 막는다.
 */

export type FontId = 'default' | 'pretendard' | 'kakaobigsans' | 'paperlogy' | 'nanumsquareround';

export const FONT_OPTIONS: { id: FontId; label: string; hint: string; sample: string; family: string }[] = [
  {
    id: 'default',
    label: '기본 폰트',
    hint: 'Spoqa Han Sans Neo',
    sample: '가나다 ABC 123',
    family: "'Spoqa Han Sans Neo', 'Apple SD Gothic Neo', system-ui, sans-serif",
  },
  {
    id: 'pretendard',
    label: '프리텐다드',
    hint: 'Pretendard',
    sample: '가나다 ABC 123',
    family: "'Pretendard Variable', Pretendard, 'Apple SD Gothic Neo', system-ui, sans-serif",
  },
  {
    id: 'kakaobigsans',
    label: '카카오 큰글씨',
    hint: 'Kakao Big Sans',
    sample: '가나다 ABC 123',
    family: "'Kakao Big Sans', 'Apple SD Gothic Neo', system-ui, sans-serif",
  },
  {
    id: 'paperlogy',
    label: '페이퍼로지',
    hint: 'Paperlogy · OFL',
    sample: '가나다 ABC 123',
    family: "'Paperlogy', 'Apple SD Gothic Neo', system-ui, sans-serif",
  },
  {
    id: 'nanumsquareround',
    label: '나눔스퀘어 라운드',
    hint: 'NanumSquareRound · OFL',
    sample: '가나다 ABC 123',
    family: "'NanumSquareRound', 'Apple SD Gothic Neo', system-ui, sans-serif",
  },
];

export const FONT_STORAGE_KEY = 'pomong.font';
/** v0.6.18: 볼드체 토글도 첫 페인트 전에 바로 적용하려고 함께 저장한다. */
export const BOLD_STORAGE_KEY = 'pomong.bold';

const FONT_IDS: FontId[] = ['default', 'pretendard', 'kakaobigsans', 'paperlogy', 'nanumsquareround'];

export function normalizeFont(value: unknown, fallback: FontId = 'default'): FontId {
  return FONT_IDS.includes(value as FontId) ? (value as FontId) : fallback;
}

function fontClass(id: FontId): string {
  if (id === 'pretendard') return 'font-pretendard';
  if (id === 'kakaobigsans') return 'font-kakaobigsans';
  if (id === 'paperlogy') return 'font-paperlogy';
  if (id === 'nanumsquareround') return 'font-nanumsquareround';
  return '';
}

/** 지금 화면에 글꼴을 적용하고, 다음 새로고침 때 바로 쓰도록 저장한다. */
export function applyFont(font: FontId): void {
  if (typeof document === 'undefined') return;
  const id = normalizeFont(font);
  const root = document.documentElement;
  root.dataset.font = id;
  for (const known of FONT_IDS) {
    const cls = fontClass(known);
    if (cls) root.classList.toggle(cls, known === id);
  }
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, id);
  } catch {
    /* 저장이 막혀 있어도 화면 적용은 계속한다 */
  }
}

export function readStoredFont(): FontId {
  try {
    return normalizeFont(window.localStorage.getItem(FONT_STORAGE_KEY), 'default');
  } catch {
    return 'default';
  }
}

/** v0.6.18: 글씨 굵게(볼드체) — html.pa-bold 로 앱 전체 기본 굵기를 한 단계 올린다. */
export function applyBold(bold: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('pa-bold', Boolean(bold));
  root.dataset.bold = bold ? 'on' : 'off';
  try {
    window.localStorage.setItem(BOLD_STORAGE_KEY, bold ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function readStoredBold(): boolean {
  try {
    return window.localStorage.getItem(BOLD_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
