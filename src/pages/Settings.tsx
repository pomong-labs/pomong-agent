import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ExternalLink, LogOut, ShieldCheck, Sparkles } from 'lucide-react';
import Mascot from '../components/Mascot';
import { api, type SettingsResponse } from '../lib/api';

export default function SettingsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [nickname, setNickname] = useState('');
  const [agentName, setAgentName] = useState('Pomong');
  const [savedFlash, setSavedFlash] = useState('');

  const [provider, setProvider] = useState<'gemini' | 'openai' | 'claude'>('gemini');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () =>
    api
      .get<SettingsResponse>('/api/settings')
      .then((r) => {
        setData(r);
        setNickname(r.profile.nickname);
        setAgentName(r.profile.agentName);
        if (r.provider) {
          setProvider(r.provider.provider);
          setModel(r.provider.model);
        }
      })
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  const saveProfile = async () => {
    await api.put('/api/settings/profile', { nickname, agentName });
    setSavedFlash('저장했습니다');
    window.setTimeout(() => setSavedFlash(''), 1600);
    load();
  };

  const saveKey = async () => {
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const r = await api.post<{ message: string }>('/api/settings/api-key', { provider, apiKey, model: model || undefined });
      setKeyMsg({ ok: true, text: r.message });
      setApiKey('');
      load();
    } catch (err) {
      setKeyMsg({ ok: false, text: err instanceof Error ? err.message : '연결에 실패했습니다.' });
    } finally {
      setKeyBusy(false);
    }
  };

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    navigate('/login', { replace: true });
  };

  const selected = data?.providers.find((p) => p.id === provider);

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-8 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[720px]">
        <header className="flex items-center">
          <div>
            <h1 className="text-[26px] font-bold tracking-[-0.02em] lg:text-[34px]">설정</h1>
            <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">포몽의 이름과 AI 연결을 관리해요</p>
          </div>
          <Mascot name="minti" size={56} className="ml-auto lg:hidden" />
        </header>

        {/* profile */}
        <section className="mt-5 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="text-[16px] font-bold text-[#1F1D2B]">프로필</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">내 닉네임</span>
              <input className="pa-input" value={nickname} placeholder="닉네임" onChange={(e) => setNickname(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">에이전트 이름</span>
              <input className="pa-input" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            </label>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button className="pa-btn-primary px-5 py-2.5" onClick={saveProfile}>
              저장
            </button>
            {savedFlash ? (
              <span className="flex items-center gap-1 text-[13px] font-medium text-[#12B886]">
                <Check size={14} /> {savedFlash}
              </span>
            ) : null}
          </div>
        </section>

        {/* AI provider */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-bold text-[#1F1D2B]">AI Provider</h2>
              <p className="mt-1 text-[13px] text-pomong-sub">
                {data?.provider
                  ? `${data.provider.label} · ${data.provider.model} 연결됨`
                  : '아직 연결된 AI가 없습니다. 키를 연결하면 대화할 수 있어요.'}
              </p>
            </div>
            {data?.provider ? (
              <span className="flex items-center gap-1 rounded-full bg-[#EAFBF1] px-3 py-1.5 text-[12px] font-semibold text-[#12B886]">
                <Check size={12} strokeWidth={3} /> Connected
              </span>
            ) : null}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {(data?.providers || []).map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setProvider(p.id);
                  setModel(p.defaultModel);
                }}
                className={`rounded-2xl border-[1.5px] py-3 text-[14px] font-semibold transition ${
                  provider === p.id ? 'border-[#C9B8FF] bg-[#F8F5FF] text-[#7C63F6]' : 'border-[#EFEDF6] bg-white text-[#5B5866]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">모델</span>
              <select className="pa-input" value={model} onChange={(e) => setModel(e.target.value)}>
                {(selected?.models || []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {selected && !selected.models.includes(model) && model ? <option value={model}>{model}</option> : null}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">API 키</span>
              <input
                className="pa-input font-mono text-[13px]"
                type="password"
                placeholder={data?.provider ? '새 키로 교체하려면 입력' : 'API 키 입력'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className="pa-btn-primary px-5 py-2.5" onClick={saveKey} disabled={keyBusy || !apiKey.trim()}>
              {keyBusy ? '확인 중…' : '연결 테스트 후 저장'}
            </button>
            {selected ? (
              <a
                href={selected.console}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[12.5px] text-[#8B72F6] hover:underline"
              >
                키 발급 페이지 <ExternalLink size={12} />
              </a>
            ) : null}
          </div>
          {keyMsg ? (
            <p className={`mt-3 rounded-xl px-3 py-2.5 text-[13px] font-medium ${keyMsg.ok ? 'bg-[#EAFBF1] text-[#12B886]' : 'bg-[#FFF1F1] text-[#E5484D]'}`}>
              {keyMsg.text}
            </p>
          ) : null}
        </section>

        {/* security / about */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="text-[16px] font-bold text-[#1F1D2B]">정보</h2>
          <ul className="mt-3 divide-y divide-[#F6F4FB] text-[13.5px]">
            <li className="flex items-center justify-between py-3">
              <span className="text-pomong-sub">버전</span>
              <span className="font-semibold text-[#3B3947]">v{data?.version || '0.1.0'}</span>
            </li>
            <li className="flex items-center justify-between py-3">
              <span className="text-pomong-sub">데이터 보관</span>
              <span className="font-semibold text-[#3B3947]">내 서버 (SQLite)</span>
            </li>
            <li className="flex items-center justify-between py-3">
              <span className="text-pomong-sub">금고 암호화</span>
              <span className="flex items-center gap-1 font-semibold text-[#12B886]">
                <ShieldCheck size={14} /> AES-256-GCM
              </span>
            </li>
          </ul>
          <button className="pa-btn-ghost mt-4 w-full sm:w-auto" onClick={logout}>
            <LogOut size={16} /> 로그아웃
          </button>
        </section>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-[12px] text-[#B4B1C2]">
          <Sparkles size={12} /> Pomong Agent v{data?.version || '0.1.0'} · Pomong Labs
        </p>
      </div>
    </div>
  );
}
