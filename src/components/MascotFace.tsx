import { useEffect, useRef, useState } from 'react';
import type { AgentState } from '../lib/store';
import { assetUrl } from '../lib/version';

export const AGENT_FACE_STATE: Record<AgentState, string> = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  responding: 'responding',
  error: 'error',
};

/**
 * 선택한 캐릭터의 상태별 표정 PNG (public/mascots/face). 없으면 기본 캐릭터 이미지로 대체.
 *
 * v0.6.3: 대기 ↔ 작업중 이미지가 뚝 끊기지 않게,
 * 이전 표정을 위에 겹쳐 두고 새 표정을 crossfade + 살짝 scale 로 바꾼다.
 * v0.6.11: 배지 전환과 같은 550ms·cubic-bezier(0.22,1,0.36,1) 로 늘려(index.css)
 * 상태 배지 색과 캐릭터 표정이 함께 부드럽게 넘어간다.
 */
export default function MascotFace({
  character = 'pimong',
  state = 'idle',
  size = 44,
  className = '',
  alt,
}: {
  character?: string;
  state?: AgentState;
  size?: number;
  className?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [character, state]);
  // ?v= 버전 쿼리: 브라우저·PWA가 예전 표정 이미지를 캐시에서 꺼내 쓰지 못하게 한다.
  const src = assetUrl(
    failed ? `/mascots/${character}.png` : `/mascots/face/${character}-${AGENT_FACE_STATE[state]}.png`
  );

  const lastSrc = useRef(src);
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    if (lastSrc.current === src) return;
    const before = lastSrc.current;
    lastSrc.current = src;
    setPrevious(before);
    // v0.6.11: 크로스페이드가 550ms 로 길어져, 이전 이미지는 그 애니메이션이 끝난 뒤에 지운다.
    const timer = window.setTimeout(() => setPrevious(null), 620);
    return () => window.clearTimeout(timer);
  }, [src]);

  const common = {
    width: size,
    height: size,
    alt: alt ?? '포몽 에이전트 캐릭터',
    draggable: false,
    style: { width: size, height: size },
  } as const;

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center align-middle ${className}`}
      style={{ width: size, height: size }}
    >
      {previous ? (
        <img
          {...common}
          src={previous}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto select-none object-contain pa-face-out"
        />
      ) : null}
      <img
        {...common}
        key={src}
        src={src}
        onError={() => setFailed(true)}
        className="relative select-none object-contain pa-face-in"
      />
    </span>
  );
}
