import { assetUrl } from '../lib/version';
import { mascotSrc } from '../lib/preload';

export type MascotName =
  | 'pimong'
  | 'pongi'
  | 'poding'
  | 'lamong'
  | 'mello'
  | 'minti'
  // 상황별 표정·소품
  | 'pimong-cheer'
  | 'pimong-think'
  | 'pimong-surprised'
  | 'pongi-check'
  | 'pongi-alert'
  | 'poding-key'
  | 'mello-check';

const HERO = new Set<MascotName>(['pimong', 'pongi', 'poding']);

export default function Mascot({
  name = 'pimong',
  size = 48,
  hero = false,
  className = '',
  alt,
}: {
  name?: MascotName;
  size?: number;
  hero?: boolean;
  className?: string;
  alt?: string;
}) {
  const file = hero && HERO.has(name) ? `${name}-hero` : name;
  // v0.6.17: 로고·마스코트도 에셋 버전을 붙여, 새로 배포하면 예전 그림이 캐시에서 나오지 않게 한다.
  return (
    <img
      src={mascotSrc(file)}
      width={size}
      height={size}
      alt={alt ?? `포몽 마스코트 ${name}`}
      draggable={false}
      decoding="async"
      className={`select-none object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** 스플래시·로그인 화면의 브랜드 로고 (v0.6.17: 에셋 버전 쿼리 공통화) */
export function brandLogoUrl(dark = false): string {
  return assetUrl(dark ? '/pomong-labs-logo-dark.png' : '/pomong-labs-logo.png');
}
