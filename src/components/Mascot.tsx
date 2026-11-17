export type MascotName = 'pimong' | 'pongi' | 'poding' | 'lamong' | 'mello' | 'minti';

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
  return (
    <img
      src={`/mascots/${file}.png`}
      width={size}
      height={size}
      alt={alt ?? `포몽 마스코트 ${name}`}
      draggable={false}
      className={`select-none object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
