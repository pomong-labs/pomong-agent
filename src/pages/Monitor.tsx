import { useEffect, useMemo, useState } from 'react';
import { Box, Cpu, Database, Globe, HardDrive, MemoryStick, Menu, RefreshCw, Terminal } from 'lucide-react';
import Gauge from '../components/Gauge';
import Mascot from '../components/Mascot';
import { api, type SystemStats } from '../lib/api';
import { formatTime, formatUptime, statusLabel } from '../lib/format';

type ViewMode = 'ring' | 'bar' | 'graph';

const COLORS = {
  cpu: { from: '#CDB4FF', to: '#8B72F6', solid: '#8B72F6', soft: '#F3EEFF' },
  ram: { from: '#BBE6FF', to: '#4A90FF', solid: '#4A90FF', soft: '#EFF7FF' },
  disk: { from: '#BCF4DE', to: '#12B886', solid: '#12B886', soft: '#EBFBF3' },
} as const;

const processIcon = (name: string) => {
  const n = name.toLowerCase();
  if (/postgres|mysql|redis|sqlite/.test(n)) return Database;
  if (/nginx|apache|caddy|httpd/.test(n)) return Globe;
  if (/ssh|bash|sh$|zsh/.test(n)) return Terminal;
  if (/node|python|java|deno|bun/.test(n)) return Cpu;
  return Box;
};

export default function Monitor() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [history, setHistory] = useState<{ t: number; cpu: number; ram: number; disk: number }[]>([]);
  const [mode, setMode] = useState<ViewMode>('ring');
  const [showAllLogs, setShowAllLogs] = useState(false);

  const load = () =>
    api
      .get<{ stats: SystemStats; history: { t: number; cpu: number; ram: number; disk: number }[] }>('/api/monitor/stats')
      .then((r) => {
        setStats(r.stats);
        setHistory(r.history);
      })
      .catch(() => undefined);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const healthy = stats?.status === 'healthy';

  const metrics = stats
    ? [
        {
          key: 'cpu' as const,
          label: 'CPU',
          value: stats.cpu,
          detail: `${stats.cores}코어 · ${(stats.cpuMhz / 1000).toFixed(1)} GHz`,
          icon: Cpu,
        },
        {
          key: 'ram' as const,
          label: 'RAM',
          value: stats.ram,
          detail: `${stats.ramUsedGB} GB / ${stats.ramTotalGB} GB`,
          icon: MemoryStick,
        },
        {
          key: 'disk' as const,
          label: '디스크',
          value: stats.disk,
          detail: `${stats.diskUsedGB} GB / ${stats.diskTotalGB} GB`,
          icon: HardDrive,
        },
      ]
    : [];

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 px-4 pb-2 pt-4 lg:px-10 lg:pb-3 lg:pt-8">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F0F8FF] ring-1 ring-[#E3F2FF]">
          <Mascot name={healthy ? 'pongi-check' : 'pongi-alert'} size={32} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-bold tracking-[-0.02em] lg:text-[34px]">서버 관제실</h1>
          <p className="mt-0.5 text-[13px] text-pomong-sub lg:mt-1.5 lg:text-[16px]">
            실시간 서버 상태
            {stats ? (
              <span className="ml-2 hidden text-[13px] text-[#B4B1C2] lg:inline">
                {stats.hostname} · {stats.osName} · 가동 {formatUptime(stats.uptimeSec)} · 부하 {stats.load1.toFixed(2)}
              </span>
            ) : null}
          </p>
        </div>
        <button className="rounded-xl p-2.5 text-[#6B677A] lg:hidden" aria-label="메뉴">
          <Menu size={22} />
        </button>
      </header>

      <div className="pa-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6 lg:px-10">
        {/* view switch */}
        <div className="mt-3 flex justify-end lg:mt-0 lg:-mt-14 lg:pb-2">
          <div className="flex w-full rounded-full bg-[#F4F3F9] p-1 lg:w-auto lg:bg-white lg:p-1.5 lg:shadow-card lg:ring-1 lg:ring-[#F1EFF7]">
            {(
              [
                ['ring', '원형', '원형 게이지'],
                ['bar', '바', '콤팩트 바'],
                ['graph', '상세', '상세 그래프'],
              ] as const
            ).map(([value, short, long]) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={`flex-1 rounded-full px-4 py-2 text-[13.5px] font-semibold transition lg:flex-none lg:px-6 lg:py-2.5 lg:text-[15px] ${
                  mode === value ? 'bg-white text-[#7C63F6] shadow-sm lg:bg-[#F7F4FF]' : 'text-[#8A8A9A]'
                }`}
              >
                <span className="lg:hidden">{short}</span>
                <span className="hidden lg:inline">{long}</span>
              </button>
            ))}
          </div>
        </div>

        {!stats ? (
          <div className="mt-10 flex flex-col items-center gap-3 text-pomong-sub">
            <RefreshCw size={20} className="animate-spin" />
            <span className="text-[14px]">서버 상태를 불러오는 중…</span>
          </div>
        ) : (
          <>
            {/* RING MODE */}
            {mode === 'ring' ? (
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:mt-6 lg:gap-5">
                {metrics.map((m) => (
                  <div key={m.key} className="pa-card flex items-center gap-5 p-5 sm:flex-col sm:items-center sm:gap-3 sm:p-7">
                    <Gauge value={m.value} size={104} thickness={9} from={COLORS[m.key].from} to={COLORS[m.key].to}>
                      <span className="text-[26px] font-bold leading-none text-[#1F1D2B]">
                        {Math.round(m.value)}
                        <span className="ml-0.5 text-[14px] font-semibold text-[#8A8A9A]">%</span>
                      </span>
                    </Gauge>
                    <div className="min-w-0 flex-1 sm:flex-none sm:text-center">
                      <p className="text-[18px] font-bold text-[#1F1D2B]">{m.label}</p>
                      <p className="mt-1 text-[13px] text-[#8A8A9A]">{m.detail}</p>
                      <span className="mt-2.5 inline-flex rounded-lg bg-[#EAFBF1] px-2.5 py-1 text-[12px] font-semibold text-[#12B886]">
                        {statusLabel(stats.status)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* BAR MODE */}
            {mode === 'bar' ? (
              <div className="mt-4 grid grid-cols-1 gap-3 lg:mt-6 lg:grid-cols-3 lg:gap-5">
                {metrics.map((m) => (
                  <div key={m.key} className="pa-card p-5 lg:p-6">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: COLORS[m.key].soft, color: COLORS[m.key].solid }}>
                        <m.icon size={19} />
                      </span>
                      <div className="flex-1">
                        <p className="text-[15px] font-semibold text-[#3B3947]">{m.label}</p>
                        <p className="text-[12.5px] text-[#9B98AB]">{m.detail}</p>
                      </div>
                      <p className="text-[24px] font-bold" style={{ color: COLORS[m.key].solid }}>
                        {Math.round(m.value)}%
                      </p>
                    </div>
                    <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-[#F2F0F8]">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${Math.max(2, Math.min(100, m.value))}%`,
                          background: `linear-gradient(90deg,${COLORS[m.key].from},${COLORS[m.key].to})`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* GRAPH MODE */}
            {mode === 'graph' ? (
              <div className="pa-card mt-4 p-5 lg:mt-6 lg:p-7">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[16px] font-bold text-[#1F1D2B]">최근 6분 추이</p>
                    <p className="mt-0.5 text-[12.5px] text-[#9B98AB]">3초 간격 실측 · 최대 {history.length}개 샘플</p>
                  </div>
                  <div className="flex items-center gap-4 text-[12.5px] font-medium text-[#6B677A]">
                    {(['cpu', 'ram', 'disk'] as const).map((k) => (
                      <span key={k} className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: COLORS[k].solid }} />
                        {k.toUpperCase()} {Math.round(stats[k])}%
                      </span>
                    ))}
                  </div>
                </div>
                <LineChart history={history} />
              </div>
            ) : null}

            {/* processes + logs */}
            <div className="mt-3 grid grid-cols-1 gap-3 lg:mt-5 lg:grid-cols-[1.6fr_1fr] lg:gap-5">
              <div className="pa-card p-4 lg:p-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-[16px] font-bold text-[#1F1D2B] lg:text-[19px]">상위 프로세스</h2>
                  <span className="text-[12.5px] text-[#9B98AB] lg:hidden">상위 3개</span>
                  <span className="hidden text-[13px] text-[#9B98AB] lg:block">실시간 · 상위 5개</span>
                </div>
                <div className="mt-3 divide-y divide-[#F5F3FA]">
                  {stats.processes.slice(0, 5).map((p, i) => (
                    <div key={p.pid} className={`${i > 2 ? 'hidden lg:block' : ''}`}>
                      <div className="flex items-center gap-3 py-2.5 lg:py-3">
                        <span
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                          style={{
                            background: [COLORS.cpu.soft, COLORS.ram.soft, COLORS.disk.soft][i % 3],
                            color: [COLORS.cpu.solid, COLORS.ram.solid, COLORS.disk.solid][i % 3],
                          }}
                        >
                          {(() => {
                            const Icon = processIcon(p.name);
                            return <Icon size={17} strokeWidth={2} />;
                          })()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-semibold text-[#3B3947]">{p.name}</p>
                          <div className="mt-1.5 h-1.5 w-full max-w-[160px] overflow-hidden rounded-full bg-[#F3F1F8]">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, Math.max(3, p.cpu * 4))}%`,
                                background: [COLORS.cpu.solid, COLORS.ram.solid, COLORS.disk.solid][i % 3],
                              }}
                            />
                          </div>
                        </div>
                        <span className="w-[62px] text-right text-[13.5px] font-semibold text-[#3B3947]">{p.cpu.toFixed(1)}%</span>
                        <span className="hidden w-[64px] text-right text-[13px] text-[#8A8A9A] sm:block">{p.ramMB}MB</span>
                        <span className="rounded-lg bg-[#EAFBF1] px-2 py-1 text-[11.5px] font-semibold text-[#12B886]">정상</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pa-card p-4 lg:p-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-[16px] font-bold text-[#1F1D2B] lg:text-[19px]">최근 시스템 로그</h2>
                  <button className="text-[13px] font-medium text-[#8B72F6]" onClick={() => setShowAllLogs((v) => !v)}>
                    {showAllLogs ? '접기' : '전체 보기'}
                  </button>
                </div>
                <ul className="mt-2 divide-y divide-[#F5F3FA]">
                  {stats.logs.slice(0, showAllLogs ? 8 : 5).map((log) => (
                    <li key={log.id} className="flex items-start gap-3 py-3">
                      <span className="w-[42px] shrink-0 text-[12.5px] text-[#A8A5B8]">{formatTime(log.at)}</span>
                      <span
                        className="mt-[6px] h-2 w-2 shrink-0 rounded-full"
                        style={{
                          background:
                            log.level === 'error' ? '#F76A6A' : log.level === 'warn' ? '#F5B547' : log.level === 'success' ? '#22C55E' : '#4A90FF',
                        }}
                      />
                      <span className="line-clamp-2 flex-1 text-[13.5px] leading-snug text-[#4B4856]">{log.message}</span>
                    </li>
                  ))}
                  {stats.logs.length === 0 ? <li className="py-4 text-[13px] text-[#A8A5B8]">기록된 로그가 없습니다.</li> : null}
                </ul>
              </div>
            </div>
          </>
        )}
      </div>

      {/* mascot bubble — small, in the page header, never over the data cards */}
      <div className="pointer-events-none absolute right-6 top-3 hidden items-center gap-1.5 md:flex lg:right-10">
        <span className="rounded-2xl rounded-br-md bg-white px-3 py-1 text-[12px] font-medium text-[#6B677A] shadow-card">
          {stats?.status === 'healthy' ? '서버 아주 쾌적해요!' : '조금 살펴볼까요?'}
        </span>
        <Mascot name={healthy ? 'pongi-check' : 'pongi-alert'} size={28} />
      </div>
    </div>
  );
}

function LineChart({ history }: { history: { t: number; cpu: number; ram: number; disk: number }[] }) {
  const width = 800;
  const height = 220;
  const data = useMemo(() => (history.length ? history : [{ t: Date.now(), cpu: 0, ram: 0, disk: 0 }]), [history]);
  const path = (key: 'cpu' | 'ram' | 'disk') => {
    if (data.length < 2) return '';
    return data
      .map((d, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - (Math.min(100, d[key]) / 100) * (height - 16) - 8;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  };

  return (
    <div className="mt-4 w-full overflow-hidden">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[200px] w-full" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" y1={height * f} x2={width} y2={height * f} stroke="#F3F1F9" strokeWidth="1" />
        ))}
        {(['disk', 'ram', 'cpu'] as const).map((k) => (
          <path key={k} d={path(k)} fill="none" stroke={COLORS[k].to} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
    </div>
  );
}
