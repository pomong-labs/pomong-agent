/**
 * v0.7.3 — 업데이트 직후 빈 화면 복구
 *
 * 배포로 새 번들이 올라오면, 이미 열려 있던 화면(또는 옛 index.html 을 들고 있던 PWA)이
 * 사라진 `/assets/index-OLD.js` 를 요청해 모듈 로드가 실패하고 빈 화면이 남는 일이 있다.
 * 그때 새로고침 한 번이면 새 번들을 받아 정상으로 돌아오므로, 다음 세 경우에 **한 번만**
 * 자동 새로고침한다.
 *
 *   1) vite:preloadError — 동적 import 의 preload 가 실패
 *   2) /assets/* 모듈 스크립트 로드 실패
 *   3) "Failed to fetch dynamically imported module" 류의 unhandledrejection
 *
 * sessionStorage 가드(20초)로 새로고침이 반복되는 무한 루프를 막는다.
 */
const GUARD_KEY = 'pomong.recoverReloadAt';
const GUARD_WINDOW_MS = 20_000;

export function reloadOnce(reason: string): boolean {
  try {
    const last = Number(sessionStorage.getItem(GUARD_KEY) || 0);
    if (Number.isFinite(last) && last > 0 && Date.now() - last < GUARD_WINDOW_MS) return false;
    sessionStorage.setItem(GUARD_KEY, String(Date.now()));
  } catch {
    // sessionStorage 가 막힌 브라우저(사파리 프라이빗 등)에서는 자동 새로고침을 하지 않는다.
    return false;
  }
  // eslint-disable-next-line no-console
  console.warn(`[pomong] 새 화면을 불러옵니다 (${reason})`);
  window.location.reload();
  return true;
}

export function installReloadRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    const detail = event as Event & { preventDefault?: () => void };
    detail.preventDefault?.();
    reloadOnce('preload-error');
  });

  window.addEventListener(
    'error',
    (event) => {
      const target = event.target as (HTMLElement & { src?: string }) | null;
      if (!target || target.tagName !== 'SCRIPT') return;
      if (!String(target.src || '').includes('/assets/')) return;
      reloadOnce('script-load');
    },
    true
  );

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string } | string | undefined;
    const text = String(typeof reason === 'string' ? reason : reason?.message || '');
    if (/dynamically imported module|module script failed|error loading dynamically/i.test(text)) {
      reloadOnce('dynamic-import');
    }
  });
}
