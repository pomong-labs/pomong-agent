import { useEffect, useState } from 'react';
import type { AgentState } from '../lib/store';
import { assetUrl } from '../lib/version';

export const AGENT_FACE_STATE: Record<AgentState, string> = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  responding: 'responding',
  error: 'error',
};

/** 선택한 캐릭터의 상태별 표정 PNG (public/mascots/face). 없으면 기본 캐릭터 이미지로 대체. */
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
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={alt ?? '포몽 에이전트 캐릭터'}
      draggable={false}
      onError={() => setFailed(true)}
      className={`select-none object-contain transition-transform duration-300 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
