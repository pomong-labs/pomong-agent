import { useId, type ReactNode } from 'react';

interface GaugeProps {
  value: number;
  size?: number;
  thickness?: number;
  from: string;
  to: string;
  track?: string;
  className?: string;
  children?: ReactNode;
}

export default function Gauge({
  value,
  size = 120,
  thickness = 10,
  from,
  to,
  track = 'var(--pa-gauge-track)',
  className = '',
  children,
}: GaugeProps) {
  const id = useId().replace(/:/g, '');
  const safe = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const dash = (safe / 100) * c;

  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={thickness} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#g-${id})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          style={{ transition: 'stroke-dasharray .8s cubic-bezier(.22,1,.36,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

export function MiniGauge({
  value,
  label,
  from,
  to,
  size = 74,
}: {
  value: number;
  label?: string;
  from: string;
  to: string;
  size?: number;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <Gauge value={value} size={size} thickness={7} from={from} to={to}>
        <span className="text-[13px] font-bold leading-none text-pomong-ink">
          {Math.round(value)}%
        </span>
      </Gauge>
      {label ? <span className="text-[13px] text-pomong-sub">{label}</span> : null}
    </div>
  );
}
