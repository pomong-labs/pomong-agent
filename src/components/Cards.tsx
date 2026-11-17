import type { SystemStats, Task } from '../lib/api';
import { formatTime, statusLabel } from '../lib/format';
import { Cpu, HardDrive, MemoryStick, ListChecks } from 'lucide-react';

const metricColors = {
  CPU: { text: 'text-[#8B72F6]', bar: 'linear-gradient(90deg,#CDB4FF,#8B72F6)', tile: 'bg-[#F3EEFF] text-[#8B72F6]' },
  RAM: { text: 'text-[#4A90FF]', bar: 'linear-gradient(90deg,#BBE6FF,#4A90FF)', tile: 'bg-[#EFF7FF] text-[#4A90FF]' },
  Disk: { text: 'text-[#12B886]', bar: 'linear-gradient(90deg,#BCF4DE,#12B886)', tile: 'bg-[#EBFBF3] text-[#12B886]' },
} as const;

export function StatsCard({ stats }: { stats: SystemStats }) {
  const rows = [
    { label: 'CPU', value: stats.cpu, icon: Cpu },
    { label: 'RAM', value: stats.ram, icon: MemoryStick },
    { label: 'Disk', value: stats.disk, icon: HardDrive },
  ] as const;

  return (
    <div className="mt-4 rounded-[22px] border border-[#F1EFF7] p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold text-[#3B3947]">서버 상태 요약</span>
        <span
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold ${
            stats.status === 'healthy' ? 'bg-[#EAFBF1] text-[#12B886]' : 'bg-[#FFF6E7] text-[#E49B18]'
          }`}
        >
          <span className="text-[11px]">♥</span> {stats.status === 'healthy' ? 'Healthy' : statusLabel(stats.status)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-4">
        {rows.map((row) => {
          const c = metricColors[row.label];
          return (
            <div key={row.label} className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${c.tile}`}>
                  <row.icon size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] leading-none text-[#8A8A9A]">{row.label}</p>
                  <p className={`mt-1 text-[22px] font-bold leading-none sm:text-[26px] ${c.text}`}>{Math.round(row.value)}%</p>
                </div>
              </div>
              <div className="mt-3 h-[5px] w-full overflow-hidden rounded-full bg-[#F2F0F8]">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${Math.max(3, Math.min(100, row.value))}%`, background: c.bar }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-[#F4F2FA] pt-3.5 text-[13px] text-[#6B677A]">
        <span className="flex h-5 w-5 items-center justify-center rounded-full border-[1.6px] border-[#12B886] text-[10px] text-[#12B886]">✓</span>
        모든 시스템이 정상적으로 운영되고 있어요.
      </div>
    </div>
  );
}

export function TasksCard({ tasks }: { tasks: Task[] }) {
  const palette = ['#12B886', '#F5B547', '#4A90FF', '#8B72F6'];
  return (
    <div className="mt-3 rounded-[22px] bg-[#FAF8FF] p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[15px] font-semibold text-[#3B3947]">
        <ListChecks size={17} className="text-[#8B72F6]" /> 오늘 할 일
      </div>
      {tasks.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-[#9B98AB]">아직 등록된 할 일이 없어요. Tasks 탭에서 추가해 보세요.</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {tasks.slice(0, 5).map((task, i) => (
            <li key={task.id} className="flex items-center gap-2.5 text-[14px]">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: palette[i % palette.length] }} />
              <span className={`flex-1 truncate ${task.done ? 'text-[#B4B1C2] line-through' : 'text-[#3B3947]'}`}>{task.title}</span>
              {task.due ? <span className="shrink-0 text-[13px] text-[#A8A5B8]">{formatTime(task.due)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
