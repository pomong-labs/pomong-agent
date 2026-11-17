import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CloudSun, ListChecks, ListPlus, CheckCircle2, Lock, Activity, Clock, Sparkles } from 'lucide-react';
import Mascot from '../components/Mascot';
import { api, type ToolCatalogEntry } from '../lib/api';

const ICONS: Record<string, typeof CloudSun> = {
  weather_get: CloudSun,
  tasks_list: ListChecks,
  tasks_add: ListPlus,
  tasks_complete: CheckCircle2,
  vault_list: Lock,
  server_stats: Activity,
  time_now: Clock,
};

const TINTS: Record<string, { bg: string; fg: string }> = {
  weather_get: { bg: '#EFF7FF', fg: '#3A78D6' },
  tasks_list: { bg: '#F3EEFF', fg: '#7C63F6' },
  tasks_add: { bg: '#F3EEFF', fg: '#7C63F6' },
  tasks_complete: { bg: '#EAFBF1', fg: '#12B886' },
  vault_list: { bg: '#FFF6E7', fg: '#E49B18' },
  server_stats: { bg: '#EFF7FF', fg: '#4A90FF' },
  time_now: { bg: '#FFF0F5', fg: '#F2568B' },
};

export default function Tools() {
  const navigate = useNavigate();
  const [tools, setTools] = useState<ToolCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<{ tools: ToolCatalogEntry[] }>('/api/tools')
      .then((r) => setTools(r.tools))
      .catch((err) => setError(err instanceof Error ? err.message : '도구 목록을 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-8 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[720px]">
        <header className="flex items-center gap-2">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-2xl text-[#6B677A] transition hover:bg-[#F7F5FF]"
            onClick={() => navigate('/more')}
            aria-label="뒤로"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-[24px] font-bold tracking-[-0.02em] lg:text-[30px]">도구</h1>
            <p className="text-[13px] text-pomong-sub lg:text-[15px]">AI가 대화 중에 직접 쓸 수 있는 기능이에요</p>
          </div>
          <Mascot name="minti" size={46} className="ml-auto" />
        </header>

        <div className="mt-4 flex items-start gap-2.5 rounded-2xl bg-[#F8F5FF] px-4 py-3 text-[12.5px] leading-relaxed text-[#6B5FA8]">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-[#B9A8FF]" />
          <span>
            도구는 제가 스스로 판단해 부릅니다. 아래 예시처럼 편하게 말을 걸어 주세요. 날씨는 Open-Meteo 무료 API라 키 없이 동작해요.
          </span>
        </div>

        {loading ? (
          <p className="mt-6 text-center text-[13px] text-[#A8A5B8]">불러오는 중…</p>
        ) : null}
        {error ? (
          <p className="mt-6 rounded-2xl bg-[#FFF1F1] px-4 py-3 text-[13px] font-medium text-[#E5484D]">{error}</p>
        ) : null}

        <ul className="mt-4 space-y-2.5">
          {tools.map((tool) => {
            const Icon = ICONS[tool.name] || Sparkles;
            const tint = TINTS[tool.name] || { bg: '#F3EEFF', fg: '#7C63F6' };
            return (
              <li
                key={tool.name}
                className="rounded-[22px] bg-white p-4 shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#F6F4FB] lg:p-5"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl" style={{ background: tint.bg, color: tint.fg }}>
                    <Icon size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[15.5px] font-bold text-[#1F1D2B]">{tool.label}</h2>
                      <span className="rounded-md bg-[#FAF9FD] px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-[#B4B1C2]">
                        {tool.name}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-pomong-sub">{tool.summary}</p>
                    <div className="mt-2 rounded-xl bg-[#FAF9FD] px-3 py-2">
                      <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-[#B4B1C2]">이렇게 물어보세요</span>
                      <span className="mt-0.5 block text-[13px] font-medium text-[#5B5866]">“{tool.example}”</span>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-6 text-center text-[12px] text-[#B4B1C2]">도구 목록은 서버의 실제 도구 정의에서 그대로 가져옵니다</p>
      </div>
    </div>
  );
}
