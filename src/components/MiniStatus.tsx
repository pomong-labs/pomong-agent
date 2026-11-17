import { useEffect, useState } from 'react';
import { api, type SystemStats } from '../lib/api';
import Gauge from './Gauge';

const COLORS = {
  cpu: { from: '#CDB4FF', to: '#8B72F6' },
  ram: { from: '#BBE6FF', to: '#4A90FF' },
  disk: { from: '#BCF4DE', to: '#1FC08A' },
};

export default function MiniStatus({ compact = false }: { compact?: boolean }) {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<{ stats: SystemStats }>('/api/monitor/stats')
        .then((r) => alive && setStats(r.stats))
        .catch(() => undefined);
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-full bg-[#F1FBEF] px-3 py-1.5 text-[12px] font-semibold text-[#159A63]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E]" />
        CPU {stats ? Math.round(stats.cpu) : '–'}% · {stats?.status === 'healthy' ? 'Healthy' : 'Check'}
      </div>
    );
  }

  const healthy = stats?.status === 'healthy';

  return (
    <div className="rounded-3xl border border-[#F0EFF6] bg-white p-5 shadow-[0_4px_18px_rgba(90,80,160,0.05)]">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-semibold text-[#3B3947]">Server Mini-Status</span>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#12B886]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#12B886]" /> Live
        </span>
      </div>
      <div className="mt-4 flex items-start justify-between gap-1">
        {(
          [
            ['CPU', stats?.cpu ?? 0, COLORS.cpu],
            ['RAM', stats?.ram ?? 0, COLORS.ram],
            ['Disk', stats?.disk ?? 0, COLORS.disk],
          ] as const
        ).map(([label, value, color]) => (
          <div key={label} className="flex flex-col items-center gap-2">
            <Gauge value={value} size={72} thickness={7} from={color.from} to={color.to}>
              <span className="text-[13px] font-bold text-[#2A2A35]">{Math.round(value)}%</span>
            </Gauge>
            <span className="text-[13px] text-[#8A8A9A]">{label}</span>
          </div>
        ))}
      </div>
      <div
        className={`mt-4 flex items-center justify-center gap-2 rounded-xl py-2.5 text-[14px] font-semibold ${
          healthy ? 'bg-[#EAFBF1] text-[#12B886]' : 'bg-[#FFF6E7] text-[#E49B18]'
        }`}
      >
        <span className="flex h-4 w-4 items-center justify-center rounded-full border-[1.6px] border-current text-[9px]">
          ✓
        </span>
        {healthy ? 'Healthy' : stats ? 'Check needed' : 'Loading'}
      </div>
    </div>
  );
}
