/**
 * 앱 글꼴 선택 (v0.6.4)
 *
 * - 기본: 지금까지 쓰던 Spoqa Han Sans Neo (index.html CDN)
 * - 프리텐다드: Pretendard (jsDelivr 공식 배포 CSS, index.html)
 * - 카카오 큰글씨: Kakao Big Sans (public/fonts/kakao-bigsans 로컬 woff2)
 *
 * 고른 글꼴은 서버 프로필(profile.font)에 저장해 새로고침·다른 기기에서도 유지하고,
 * 첫 페인트 전에 index.html 인라인 스크립트가 localStorage 값으로 먼저 칠해 깜빡임을 막는다.
 */

export type FontId = 'default' | 'pretendard' | 'kakaobigsans';

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
];

export const FONT_STORAGE_KEY = 'pomong.font';

export function normalizeFont(value: unknown, fallback: FontId = 'default'): FontId {
  return value === 'pretendard' || value === 'kakaobigsans' || value === 'default' ? value : fallback;
}

/** 지금 화면에 글꼴을 적용하고, 다음 새로고침 때 바로 쓰도록 저장한다. */
export function applyFont(font: FontId): void {
  if (typeof document === 'undefined') return;
  const id = normalizeFont(font);
  const root = document.documentElement;
  root.dataset.font = id;
  root.classList.toggle('font-pretendard', id === 'pretendard');
  root.classList.toggle('font-kakaobigsans', id === 'kakaobigsans');
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
