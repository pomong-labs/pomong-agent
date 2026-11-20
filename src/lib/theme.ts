/**
 * 테마 엔진 (v0.5.6)
 *
 * - 테마 모드: 라이트 / 다크 / 기기 설정 따름(system)
 * - 포인트 컬러: 캐릭터 맞춤 · 기본 퍼플 · 직접 고르기
 *
 * 색은 CSS 변수(--accent 등)로만 흘려보내고, 실제 유틸리티 클래스는
 * `src/theme.generated.css`(scripts/theme-css.mjs가 생성)가 변수를 바라보게 바꾼다.
 * 그래서 화면 어디에서든 포인트 컬러가 한 번에 어울리게 바뀐다.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentMode = 'character' | 'purple' | 'custom';

export interface ThemeSettings {
  theme: ThemeMode;
  /** 캐릭터 맞춤 / 기본 퍼플 / 직접 고르기 */
  accentMode: AccentMode;
  /** 직접 고르기에서 사용자가 고른 색 (#RRGGBB) */
  accentColor: string;
  /** 선택한 마스코트 id (캐릭터 맞춤 모드에서 쓴다) */
  character: string;
}

export const SYSTEM_ACCENT = '#8B72F8';
export const PURPLE_ACCENT = '#8B72F8';

/** 마스코트 6종의 포인트 컬러 (브랜드 시트 기준) */
export const CHARACTER_ACCENTS: Record<string, { name: string; color: string; hint: string }> = {
  poding: { name: '포딩', color: '#E7A93F', hint: '버터 옐로' },
  pimong: { name: '피몽', color: '#E96C99', hint: '소프트 핑크' },
  lamong: { name: '라몽', color: '#9B7BF0', hint: '라벤더 퍼플' },
  pongi: { name: '퐁이', color: '#4EA8DE', hint: '스카이 블루' },
  mello: { name: '멜로', color: '#F0925A', hint: '피치 오렌지' },
  minti: { name: '민티', color: '#35B98A', hint: '민트 그린' },
};

export const ACCENT_CHOICES = [
  { color: '#8B72F8', name: '포몽 퍼플' },
  { color: '#4A90E2', name: '블루' },
  { color: '#E96C99', name: '핑크' },
  { color: '#35B98A', name: '그린' },
  { color: '#F0925A', name: '오렌지' },
  { color: '#8E8A9E', name: '차콜 그레이' },
];

/* ------------------------------------------------------------------ */
/* 색 계산                                                              */
/* ------------------------------------------------------------------ */

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeHex(input: string, fallback = PURPLE_ACCENT): string {
  const value = String(input || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toUpperCase();
  }
  return fallback;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = normalizeHex(hex);
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** 두 색을 섞는다. t=0이면 a, t=1이면 b */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t);
  return rgbToHex(ca.r + (cb.r - ca.r) * k, ca.g + (cb.g - ca.g) * k, ca.b + (cb.b - ca.b) * k);
}

export function darken(hex: string, amount: number): string {
  return mix(hex, '#000000', amount);
}

export function lighten(hex: string, amount: number): string {
  return mix(hex, '#FFFFFF', amount);
}

/** WCAG 상대 휘도 */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const high = Math.max(la, lb);
  const low = Math.min(la, lb);
  return (high + 0.05) / (low + 0.05);
}

/** 배경 위에서 읽히도록 색을 어둡게(또는 밝게) 밀어 넣는다. */
function ensureContrast(color: string, against: string, ratio = 4.5, direction: 'darken' | 'lighten' = 'darken'): string {
  let out = color;
  for (let i = 0; i < 40; i += 1) {
    if (contrastRatio(out, against) >= ratio) return out;
    out = direction === 'darken' ? darken(out, 0.06) : lighten(out, 0.06);
  }
  return out;
}

/** 글자색으로 쓸 때 흰색과 검정 중 더 잘 보이는 쪽 */
function readableInk(background: string): string {
  return contrastRatio('#FFFFFF', background) >= contrastRatio('#1F1D2B', background) ? '#FFFFFF' : '#1F1D2B';
}

/* ------------------------------------------------------------------ */
/* 실제 적용                                                            */
/* ------------------------------------------------------------------ */

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    if (typeof window === 'undefined' || !window.matchMedia) return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode === 'dark' ? 'dark' : 'light';
}

export function accentBaseFor(settings: Pick<ThemeSettings, 'accentMode' | 'accentColor' | 'character'>): string {
  if (settings.accentMode === 'custom') return normalizeHex(settings.accentColor);
  if (settings.accentMode === 'character') {
    return CHARACTER_ACCENTS[settings.character]?.color || CHARACTER_ACCENTS.pimong.color;
  }
  return PURPLE_ACCENT;
}

/** 실제 `--pa-surface`(src/index.css)와 반드시 같은 값이어야 한다. */
export const LIGHT_SURFACE = '#FFFFFF';
export const DARK_SURFACE = '#1B1923';

/**
 * v0.6.7: 앱 맨 위(아이폰 상태바 바로 아래) 색 = 본문 표면색(`--pa-surface`)과 **정확히 같은 HEX**.
 *
 * v0.6.6까지는 표면색에 캐릭터 포인트 컬러를 3.5%(다크 5%) 섞은 값을 썼다. 그래서 아이폰 상태바
 * (safe-area-inset-top)와 그 아래 본문 배경의 색이 미세하게 달라, 경계에 색 띠가 한 줄 보였다(IMG_3637).
 * 이제 두 값이 같은 문자열이라 어떤 포인트 컬러에서도 띠·경계선이 생기지 않는다.
 */
export function topSurfaceColor(_base: string | undefined, mode: 'light' | 'dark'): string {
  return mode === 'dark' ? DARK_SURFACE : LIGHT_SURFACE;
}

/**
 * 포인트 컬러 파생값을 화면 변수로 심는다.
 * 라이트/다크 각각에서 대비가 유지되도록 파생값을 다르게 계산한다.
 */
export function accentVars(base: string, mode: 'light' | 'dark'): Record<string, string> {
  const accent = normalizeHex(base);
  if (mode === 'dark') {
    const deep = ensureContrast(lighten(accent, 0.28), DARK_SURFACE, 4.5, 'lighten');
    return {
      '--accent': accent,
      '--accent-deep': deep,
      '--accent-soft': mix(accent, DARK_SURFACE, 0.82),
      '--accent-soft-weak': mix(accent, DARK_SURFACE, 0.9),
      '--accent-line': mix(accent, DARK_SURFACE, 0.55),
      '--accent-line-soft': mix(accent, DARK_SURFACE, 0.72),
      '--accent-muted': mix(accent, DARK_SURFACE, 0.35),
      '--accent-faint': mix(accent, '#EDEAF6', 0.55),
      '--accent-ink': mix(lighten(accent, 0.55), '#FFFFFF', 0.15),
      '--accent-grad': `linear-gradient(135deg, ${lighten(accent, 0.06)} 0%, ${accent} 100%)`,
      '--accent-contrast': readableInk(accent),
      '--bubble-user': `linear-gradient(135deg, ${mix(accent, DARK_SURFACE, 0.62)} 0%, ${mix(accent, DARK_SURFACE, 0.74)} 100%)`,
      '--pa-top': topSurfaceColor(accent, 'dark'),
    };
  }
  const deep = ensureContrast(darken(accent, 0.12), LIGHT_SURFACE, 4.5, 'darken');
  const ink = ensureContrast(mix(accent, '#000000', 0.42), mix(accent, LIGHT_SURFACE, 0.86), 4.5, 'darken');
  return {
    '--accent': accent,
    '--accent-deep': deep,
    '--accent-soft': mix(accent, LIGHT_SURFACE, 0.9),
    '--accent-soft-weak': mix(accent, LIGHT_SURFACE, 0.95),
    '--accent-line': mix(accent, LIGHT_SURFACE, 0.6),
    '--accent-line-soft': mix(accent, LIGHT_SURFACE, 0.78),
    '--accent-muted': mix(accent, LIGHT_SURFACE, 0.5),
    '--accent-faint': ensureContrast(mix(accent, '#5B5866', 0.45), LIGHT_SURFACE, 4.5, 'darken'),
    '--accent-ink': ink,
    '--accent-grad': `linear-gradient(135deg, ${lighten(accent, 0.12)} 0%, ${accent} 100%)`,
    '--accent-contrast': readableInk(accent),
    '--bubble-user': `linear-gradient(135deg, ${mix(accent, LIGHT_SURFACE, 0.8)} 0%, ${mix(accent, LIGHT_SURFACE, 0.88)} 100%)`,
    '--pa-top': topSurfaceColor(accent, 'light'),
  };
}

/**
 * v0.6.7: `index.html`에는 라이트/다크용 `theme-color` 메타가 media 쿼리로 두 개 있다.
 * 저장된 테마가 기기 설정과 다를 수 있으므로, 화면에 적용한 색을 모든 메타에 같이 써 준다.
 */
export function syncThemeColor(top: string): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', top);
  });
}

export const THEME_STORAGE_KEY = 'pomong.theme';

interface StoredTheme {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  accentMode: AccentMode;
  accentColor: string;
  character: string;
  /** 첫 페인트(index.html 인라인 스크립트)가 그대로 심는 파생 변수 */
  vars?: Record<string, string>;
}

export function readStoredTheme(): StoredTheme | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTheme>;
    const mode: ThemeMode = parsed.mode === 'dark' || parsed.mode === 'system' ? parsed.mode : 'light';
    const accentMode: AccentMode =
      parsed.accentMode === 'character' || parsed.accentMode === 'custom' ? parsed.accentMode : 'purple';
    return {
      mode,
      resolved: parsed.resolved === 'dark' ? 'dark' : 'light',
      accentMode,
      accentColor: normalizeHex(parsed.accentColor || PURPLE_ACCENT),
      character: String(parsed.character || 'pimong'),
      vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : undefined,
    };
  } catch {
    return null;
  }
}

function storeTheme(settings: ThemeSettings, resolved: 'light' | 'dark', vars: Record<string, string>): void {
  try {
    const stored: StoredTheme = {
      mode: settings.theme,
      resolved,
      accentMode: settings.accentMode,
      accentColor: normalizeHex(settings.accentColor),
      character: settings.character,
      vars,
    };
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* 저장 공간이 막혀 있어도 화면 적용은 계속한다 */
  }
}

let lastApplied: ThemeSettings | null = null;

/** 지금 화면에 테마를 적용하고, 다음 새로고침 때 깜빡이지 않게 저장한다. */
export function applyTheme(settings: ThemeSettings): { resolved: 'light' | 'dark'; base: string } {
  const resolved = resolveTheme(settings.theme);
  const base = accentBaseFor(settings);
  if (typeof document === 'undefined') return { resolved, base };
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  const vars = accentVars(base, resolved);
  Object.entries(vars).forEach(([key, value]) => root.style.setProperty(key, value));
  // 테마 모드 3종을 CSS에서도 구분할 수 있게 둔다(기기 설정 따름 표시 등).
  root.dataset.themeMode = settings.theme;
  lastApplied = settings;
  storeTheme(settings, resolved, vars);
  // iOS 상태 표시줄·주소창 색도 테마에 맞춘다.
  // v0.6.7: 상태바 색 = 본문 표면색(--pa-surface)과 같은 값. media 쿼리로 나뉜 메타도 **모두** 맞춘다.
  const top = vars['--pa-top'];
  syncThemeColor(top);
  // 상태바(노치) 아래까지 같은 배경으로 칠해 다크모드에 흰 띠가 남지 않게 한다.
  root.style.backgroundColor = top;
  if (document.body) document.body.style.backgroundColor = top;
  return { resolved, base };
}

/** 저장된 테마를 즉시(첫 페인트 뒤 최대한 빨리) 되살린다. */
export function applyStoredTheme(): void {
  const stored = readStoredTheme();
  if (!stored) return;
  applyTheme({
    theme: stored.mode,
    accentMode: stored.accentMode,
    accentColor: stored.accentColor,
    character: stored.character,
  });
}

/** 기기 설정(다크 모드)이 바뀌면 system 모드일 때만 다시 칠한다. */
export function watchSystemTheme(onChange?: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (lastApplied && lastApplied.theme === 'system') applyTheme(lastApplied);
    onChange?.();
  };
  if (media.addEventListener) media.addEventListener('change', handler);
  else media.addListener(handler);
  return () => {
    if (media.removeEventListener) media.removeEventListener('change', handler);
    else media.removeListener(handler);
  };
}

export function currentResolved(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}
