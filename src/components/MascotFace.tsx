import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentState } from '../lib/store';
import { FACE_STATES, isImageReady, mascotFaceSrc, mascotSrc, preloadCharacter, preloadImage } from '../lib/preload';

export const AGENT_FACE_STATE: Record<AgentState, string> = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  responding: 'responding',
  error: 'error',
};

/**
 * 화면에 겹쳐 두는 표정 — 이 다섯 장은 항상 DOM 에 있다.
 * 전환할 때 `<img>` 를 새로 만들지 않고 `opacity`·`scale` CSS transition 만 바꾸므로,
 * 첫 프레임에 캐릭터가 비는(깜빡이는) 순간이 없다.
 */
const LAYER_STATES: readonly AgentState[] = FACE_STATES;

/**
 * 선택한 캐릭터의 상태별 표정 PNG (public/mascots/face). 없으면 기본 캐릭터 이미지로 대체.
 *
 * v0.6.3: 대기 ↔ 작업중 이미지가 뚝 끊기지 않게 crossfade + 살짝 scale.
 * v0.6.11: 배지 전환과 같은 550ms·cubic-bezier(0.22,1,0.36,1) 로 맞춤(index.css).
 * v0.6.17: `key` 를 그림 주소로 주어 새 `<img>` 를 마운트하던 구조를 걷어냈다. 그 구조는 첫 프레임에
 *   새 그림이 `opacity: 0` 으로 시작하고 이전 그림은 `useEffect` 가 돈 뒤에야 붙어서
 *   캐릭터가 한 프레임 사라졌다. 지금은 다섯 상태 그림을 미리 겹쳐 두고, 앱 부팅 때
 *   프리로드·디코드된 그림에만 `data-on` 을 옮긴다. 새 그림이 아직 준비되지 않았으면
 *   이전 표정을 그대로 보여 주므로 빠른 연속 상태 변화에도 빈 프레임이 생기지 않는다.
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
  /** 화면에 실제로 올라온(디코드된) 그림 주소 */
  const [decoded, setDecoded] = useState<Record<string, boolean>>({});
  /** 표정 그림이 없어 기본 캐릭터로 대체해야 하는 주소 */
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  // ?v= 버전 쿼리: 브라우저·PWA가 예전 표정 이미지를 캐시에서 꺼내 쓰지 못하게 한다.
  const baseSrc = mascotSrc(character);
  const faceSrcs = useMemo(() => {
    const map = new Map<AgentState, string>();
    for (const s of LAYER_STATES) map.set(s, mascotFaceSrc(character, AGENT_FACE_STATE[s]));
    return map;
  }, [character]);

  const ready = (src: string) => Boolean(decoded[src]) || isImageReady(src);
  const srcFor = (s: AgentState) => {
    const face = faceSrcs.get(s) ?? baseSrc;
    return failed[face] ? baseSrc : face;
  };

  const targetSrc = srcFor(state);
  // 새 표정이 아직 준비되지 않았으면 지금 보이는 표정을 그대로 둔다 — 1프레임도 비지 않는다.
  const shownRef = useRef<AgentState>(state);
  const shownState: AgentState = ready(targetSrc) || shownRef.current === state ? state : shownRef.current;
  const shownSrc = srcFor(shownState);

  useEffect(() => {
    shownRef.current = shownState;
  }, [shownState]);

  // 설정에서 캐릭터를 바꾸면 그 캐릭터의 표정을 먼저 받아 둔다(중복 요청은 합쳐진다).
  useEffect(() => {
    void preloadCharacter(character);
  }, [character]);

  // 지금 보여 줄 그림이 뒤늦게 준비되는 경우를 한 번 더 밀어 준다.
  useEffect(() => {
    void preloadImage(targetSrc);
  }, [targetSrc]);

  const markLoaded = (src: string) =>
    setDecoded((prev) => (prev[src] ? prev : { ...prev, [src]: true }));
  const markFailed = (src: string) =>
    setFailed((prev) => (prev[src] ? prev : { ...prev, [src]: true }));

  const label = alt ?? '포몽 에이전트 캐릭터';
  const layers: { key: string; src: string; on: boolean }[] = [
    { key: 'base', src: baseSrc, on: shownSrc === baseSrc },
    ...LAYER_STATES.map((s) => ({
      key: `face-${s}`,
      src: srcFor(s),
      // 표정 그림이 없어 기본 캐릭터로 대체된 경우 base 레이어만 보여 준다(같은 그림이 겹치지 않게).
      on: shownState === s && shownSrc !== baseSrc,
    })),
  ];

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center align-middle ${className}`}
      style={{ width: size, height: size }}
    >
      {layers.map((layer) => (
        <img
          key={layer.key}
          src={layer.src}
          alt={layer.on ? label : ''}
          aria-hidden={layer.on ? undefined : true}
          draggable={false}
          decoding="async"
          data-on={layer.on ? 'true' : 'false'}
          onLoad={() => markLoaded(layer.src)}
          onError={() => markFailed(layer.src)}
          className="pa-face-layer"
        />
      ))}
    </span>
  );
}
