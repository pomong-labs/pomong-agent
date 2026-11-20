import { useEffect, useState, type FocusEvent } from 'react';

/**
 * v0.6.3 — iOS/PWA 가상 키보드 대응
 *
 * iOS 사파리·홈화면 앱은 입력칸에 포커스가 가면 키보드가 올라오고,
 * 그때 보이는 영역(visualViewport)이 줄어든다. 모달을 `88vh` 같은 고정 높이로 두면
 * 입력칸이 키보드 뒤로 숨어 스크롤도 되지 않는다.
 * 그래서 열려 있는 동안 visualViewport 높이를 따라가며 모달 최대 높이를 정한다.
 */
export function useVisualViewportHeight(open: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setHeight(Math.round(vv.height));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [open]);

  return height;
}

/** 포커스된 입력칸을 화면 가운데로 끌어와 키보드에 가리지 않게 한다. */
export function keepFieldVisible(event: FocusEvent<HTMLElement>): void {
  const el = event.target as HTMLElement | null;
  if (!el || !el.tagName) return;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  // 키보드가 올라오는 애니메이션이 끝난 뒤 한 번, 그리고 조금 더 뒤에 한 번 더.
  window.setTimeout(() => {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      /* ignore */
    }
  }, 260);
  window.setTimeout(() => {
    try {
      el.scrollIntoView({ block: 'center' });
    } catch {
      /* ignore */
    }
  }, 520);
}

/** 모달·시트에 그대로 넣는 최대 높이(px 또는 CSS 값) */
export function modalMaxHeight(viewportHeight: number | null, fallback = '88vh'): number | string {
  if (!viewportHeight) return fallback;
  return Math.max(240, viewportHeight - 28);
}
