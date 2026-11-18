import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ExternalLink, Globe, Loader2, Plus, Search, Sparkles } from 'lucide-react';
import BackButton from '../components/BackButton';
import Mascot from '../components/Mascot';
import { api, type ServiceEntry } from '../lib/api';
import { useAppStore } from '../lib/store';

const CATEGORY_LABEL: Record<string, string> = {
  all: '전체',
  dev: '개발·생산성',
  shopping: '쇼핑',
  life: '생활·여행',
  social: '메일·SNS',
};

export default function Services() {
  const navigate = useNavigate();
  const { setDraft } = useAppStore();
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [categories, setCategories] = useState<{ id: string; label: string }[]>([]);
  const [connectedCount, setConnectedCount] = useState(0);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [hint, setHint] = useState('');

  const load = useCallback(async () => {
    const res = await api
      .get<{ services: ServiceEntry[]; connectedCount: number; categories: { id: string; label: string }[] }>('/api/services')
      .catch(() => null);
    if (!res) return;
    setServices(res.services);
    setConnectedCount(res.connectedCount);
    setCategories(res.categories);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return services.filter(
      (service) =>
        (filter === 'all' || service.category === filter) &&
        (!q || service.name.toLowerCase().includes(q) || service.examples.some((ex) => ex.toLowerCase().includes(q)))
    );
  }, [services, filter, query]);

  /** 서비스 사이트를 브라우저로 바로 연다(로그인은 내가, AI는 이어받기). */
  const openLogin = async (service: ServiceEntry | null, url?: string) => {
    const target = url || service?.loginUrl;
    if (!target) return;
    setBusyId(service?.id || 'custom');
    setHint('');
    try {
      const res = await api.post<{ session: { id: string } }>('/api/browser/sessions', {});
      await api.post(`/api/browser/sessions/${res.session.id}/input`, { type: 'goto', url: target }).catch(() => undefined);
      navigate('/browser');
    } catch (err) {
      setHint(err instanceof Error ? err.message : '브라우저를 열지 못했어요.');
    } finally {
      setBusyId(null);
    }
  };

  /** 예시를 누르면 채팅 입력창에 그대로 채워진다. */
  const useExample = (text: string) => {
    setDraft(text);
    navigate('/');
  };

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-10 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[900px]">
        <header className="flex items-center gap-2">
          <BackButton />
          <div className="min-w-0 flex-1">
            <h1 className="text-[26px] font-bold tracking-[-0.02em] lg:text-[34px]">연결된 앱 및 서비스</h1>
            <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">금고 계정·브라우저 로그인으로 AI가 이어서 도와드릴 수 있어요</p>
          </div>
          <Mascot name="poding" size={56} />
        </header>

        {/* 연결됨 요약 */}
        <div className="mt-4 flex items-center gap-3 rounded-[20px] bg-gradient-to-r from-[#F3EEFF] to-[#EAF6FF] px-4 py-3.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-[#12B886] shadow-sm">
            <Check size={19} strokeWidth={3} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold text-[#3A2F7A]">
              연결됨 {connectedCount}개 <span className="font-medium text-[#8A82B8]">/ 전체 {services.length}개</span>
            </p>
            <p className="text-[11.5px] text-[#7E78A8]">금고에 계정을 저장하거나 한 번 로그인해 두면 다음부터 바로 이어져요.</p>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#B7B4C6]" />
            <input className="pa-input pl-10" placeholder="서비스 검색 (예: 쿠팡, 깃허브)" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {(categories.length ? categories : Object.keys(CATEGORY_LABEL).map((id) => ({ id, label: CATEGORY_LABEL[id] }))).map((category) => (
            <button
              key={category.id}
              onClick={() => setFilter(category.id)}
              className={`pa-chip shrink-0 ${filter === category.id ? 'pa-chip-active' : ''}`}
            >
              {CATEGORY_LABEL[category.id] || category.label}
            </button>
          ))}
        </div>

        {hint ? <p className="mt-3 rounded-[14px] bg-[#FFF8E7] px-3 py-2 text-[12px] text-[#9A7412]">{hint}</p> : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {visible.map((service) => (
            <article key={service.id} className="rounded-[22px] bg-white p-4 shadow-card ring-1 ring-[#F6F4FB]">
              <div className="flex items-start gap-3">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-[20px]"
                  style={{ background: service.tint, color: service.color }}
                >
                  {service.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-[15.5px] font-bold text-[#1F1D2B]">{service.name}</h3>
                    {service.connected ? (
                      <span className="shrink-0 rounded-full bg-[#EAFBF1] px-2 py-0.5 text-[10.5px] font-bold text-[#0F9668]">연결됨</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-[#A8A5B8]">{CATEGORY_LABEL[service.category]}</p>
                </div>
                <button
                  className="flex shrink-0 items-center gap-1 rounded-full bg-[#F7F5FF] px-2.5 py-1.5 text-[11.5px] font-bold text-[#7C63F6] disabled:opacity-50"
                  onClick={() => openLogin(service)}
                  disabled={busyId === service.id}
                >
                  {busyId === service.id ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                  {service.connected ? '열기' : '로그인'}
                </button>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {service.examples.map((example) => (
                  <button
                    key={example}
                    onClick={() => useExample(example)}
                    className="flex items-center gap-1 rounded-full bg-[#FAF9FD] px-2.5 py-1.5 text-left text-[11.5px] font-medium text-[#5B5866] ring-1 ring-[#F1EEF9] transition active:scale-[0.98]"
                  >
                    <Sparkles size={10} className="shrink-0 text-[#B9A8FF]" />
                    {example}
                  </button>
                ))}
              </div>

              <div className="mt-2 flex items-center justify-between">
                <button className="text-[11.5px] font-semibold text-[#8B72F6]" onClick={() => navigate('/vault')}>
                  금고에 계정 등록
                </button>
                <a href={service.loginUrl} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 text-[11px] text-[#B4B1C2]">
                  사이트 <ExternalLink size={10} />
                </a>
              </div>
            </article>
          ))}
        </div>

        {/* 커스텀 주소 추가 */}
        <div className="mt-4 rounded-[22px] bg-white p-4 shadow-card ring-1 ring-[#F6F4FB]">
          <h3 className="text-[14.5px] font-bold text-[#1F1D2B]">다른 사이트 추가</h3>
          <p className="mt-0.5 text-[11.5px] text-[#A8A5B8]">주소를 넣으면 브라우저로 열어 로그인하고, 그 사이트의 일을 AI에게 맡길 수 있어요.</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              className="pa-input flex-1"
              placeholder="https://example.com"
              inputMode="url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
            />
            <button
              className="pa-btn-primary shrink-0 px-4 py-2.5 text-[13px]"
              onClick={() => openLogin(null, customUrl.trim())}
              disabled={!customUrl.trim() || busyId === 'custom'}
            >
              <Plus size={15} /> 열기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
