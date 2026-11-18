import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ExternalLink, LogOut, ShieldCheck, Sparkles } from 'lucide-react';
import MascotFace from '../components/MascotFace';
import { api, type ProviderId, type SettingsResponse } from '../lib/api';
import { useAppStore } from '../lib/store';
import PolicySection from '../components/PolicySection';

/** 말투 선택지와 그 말투로 대화했을 때의 예시 (설정 화면에 그대로 보여 준다) */
function toneOptions(callName: string, agentName: string) {
  const agent = agentName || 'Pomong';
  return [
    {
      id: 'polite' as const,
      label: '존댓말',
      hint: '정중하게',
      example: `나: 오늘 날씨 어때?\n${agent}: ${callName}, 인제는 지금 흐리고 3도예요. 오후에 비 소식이 있으니 우산을 챙기시는 게 좋겠어요.`,
    },
    {
      id: 'casual' as const,
      label: '편한 반말',
      hint: '친구처럼',
      example: `나: 오늘 날씨 어때?\n${agent}: ${callName}아, 인제는 지금 흐리고 3도야. 오후에 비 온대, 우산 챙겨!`,
    },
  ];
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const { refreshProfile, refreshModels } = useAppStore();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [nickname, setNickname] = useState('');
  const [agentName, setAgentName] = useState('Pomong');
  const [character, setCharacter] = useState('pimong');
  const [tone, setTone] = useState<'polite' | 'casual'>('polite');
  const [savedFlash, setSavedFlash] = useState('');

  const [provider, setProvider] = useState<ProviderId>('gemini');
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
        setCharacter(r.profile.character || 'pimong');
        setTone(r.profile.tone === 'casual' ? 'casual' : 'polite');
        setProvider(r.active.provider);
        setModel(r.active.model);
      })
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  const saveProfile = async () => {
    await api.put('/api/settings/profile', { nickname, agentName, character, tone });
    setSavedFlash('저장했습니다');
    window.setTimeout(() => setSavedFlash(''), 1800);
    await load();
    await refreshProfile();
  };

  const saveKey = async () => {
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const r = await api.post<{ message: string }>('/api/settings/api-key', { provider, apiKey, model: model || undefined });
      setKeyMsg({ ok: true, text: r.message });
      setApiKey('');
      await load();
      await refreshModels();
    } catch (err) {
      setKeyMsg({ ok: false, text: err instanceof Error ? err.message : '연결에 실패했습니다.' });
    } finally {
      setKeyBusy(false);
    }
  };

  const useModel = async (nextProvider: ProviderId, nextModel: string) => {
    setKeyMsg(null);
    try {
      await api.post('/api/models/select', { provider: nextProvider, model: nextModel });
      setProvider(nextProvider);
      setModel(nextModel);
      await load();
      await refreshModels();
    } catch (err) {
      setKeyMsg({ ok: false, text: err instanceof Error ? err.message : '모델을 바꾸지 못했습니다.' });
    }
  };

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    navigate('/login', { replace: true });
  };

  const selected = data?.providers.find((p) => p.id === provider);
  const callName = nickname.trim() || '주인님';
  const mascots = data?.mascots || [
    { id: 'poding', name: '포딩' },
    { id: 'pimong', name: '피몽' },
    { id: 'lamong', name: '라몽' },
    { id: 'pongi', name: '퐁이' },
    { id: 'mello', name: '멜로' },
    { id: 'minti', name: '민티' },
  ];

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-8 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[720px]">
        <header className="flex items-center">
          <div>
            <h1 className="text-[26px] font-bold tracking-[-0.02em] lg:text-[34px]">설정</h1>
            <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">AI 이름·캐릭터·말투와 모델 연결을 관리해요</p>
          </div>
          <MascotFace character={character} size={56} className="ml-auto lg:hidden" />
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
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">AI 이름</span>
              <input className="pa-input" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            </label>
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-semibold text-[#5B5866]">AI 캐릭터</span>
              <span className="text-[11.5px] text-[#B4B1C2]">말풍선·상단바 얼굴이 함께 바뀌어요</span>
            </div>
            <div className="mt-2.5 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {mascots.map((m) => {
                const active = character === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setCharacter(m.id)}
                    className={`flex flex-col items-center gap-1 rounded-2xl border-[1.5px] px-2 py-2.5 transition ${
                      active ? 'border-[#C9B8FF] bg-[#F8F5FF]' : 'border-[#EFEDF6] bg-white hover:bg-[#FBFAFF]'
                    }`}
                    aria-pressed={active}
                  >
                    <span className="relative">
                      <MascotFace character={m.id} state={active ? 'responding' : 'idle'} size={44} />
                      {active ? (
                        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#8B72F8] text-white">
                          <Check size={10} strokeWidth={4} />
                        </span>
                      ) : null}
                    </span>
                    <span className={`text-[12px] font-semibold ${active ? 'text-[#7C63F6]' : 'text-[#6B677A]'}`}>{m.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-semibold text-[#5B5866]">AI 말투</span>
              <span className="text-[11.5px] text-[#B4B1C2]">저장하면 다음 대화부터 적용돼요</span>
            </div>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              {toneOptions(callName, agentName).map((opt) => {
                const active = tone === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setTone(opt.id)}
                    className={`rounded-2xl border-[1.5px] px-4 py-3 text-left transition ${
                      active ? 'border-[#C9B8FF] bg-[#F8F5FF]' : 'border-[#EFEDF6] bg-white hover:bg-[#FBFAFF]'
                    }`}
                    aria-pressed={active}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`text-[14.5px] font-semibold ${active ? 'text-[#7C63F6]' : 'text-[#4B4856]'}`}>{opt.label}</span>
                      <span className="text-[11.5px] font-medium text-[#B4B1C2]">{opt.hint}</span>
                      {active ? (
                        <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-[#8B72F8] text-white">
                          <Check size={12} strokeWidth={4} />
                        </span>
                      ) : null}
                    </span>
                    <span className={`mt-2 block whitespace-pre-line rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ${active ? 'bg-white text-[#5B5866]' : 'bg-[#FAF9FD] text-[#6B677A]'}`}>
                      {opt.example}
                    </span>
                  </button>
                );
              })}
            </div>
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
              <h2 className="text-[16px] font-bold text-[#1F1D2B]">AI 모델</h2>
              <p className="mt-1 text-[13px] text-pomong-sub">
                {data?.active ? `지금은 ${selected?.label || data.active.provider} · ${data.active.model} 로 답해요` : '아직 연결된 AI가 없습니다.'}
              </p>
            </div>
            {selected?.connected ? (
              <span className="flex items-center gap-1 rounded-full bg-[#EAFBF1] px-3 py-1.5 text-[12px] font-semibold text-[#12B886]">
                <Check size={12} strokeWidth={3} /> 연결됨
              </span>
            ) : (
              <span className="rounded-full bg-[#FFF6E7] px-3 py-1.5 text-[12px] font-semibold text-[#E49B18]">키 필요</span>
            )}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {(data?.providers || []).map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setProvider(p.id);
                  setModel(p.id === data?.active.provider ? data.active.model : p.defaultModel);
                  setKeyMsg(null);
                }}
                className={`relative rounded-2xl border-[1.5px] py-3 text-[14px] font-semibold transition ${
                  provider === p.id ? 'border-[#C9B8FF] bg-[#F8F5FF] text-[#7C63F6]' : 'border-[#EFEDF6] bg-white text-[#5B5866]'
                }`}
              >
                {p.label}
                <span
                  className={`absolute right-2 top-2 h-1.5 w-1.5 rounded-full ${p.connected ? 'bg-[#22C55E]' : 'bg-[#DAD6E6]'}`}
                  aria-hidden
                />
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
                placeholder={selected?.connected ? '새 키로 교체하려면 입력' : 'API 키 입력'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className="pa-btn-primary px-4 py-2.5" onClick={saveKey} disabled={keyBusy || !apiKey.trim()}>
              {keyBusy ? '확인 중…' : '키 연결'}
            </button>
            <button
              className="pa-btn-ghost px-4 py-2.5"
              onClick={() => useModel(provider, model)}
              disabled={!selected?.connected}
              title={selected?.connected ? '이 모델로 대화하기' : '먼저 키를 연결해 주세요'}
            >
              이 모델 사용
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
          {data?.providers.some((p) => p.connected) ? (
            <div className="mt-4 rounded-2xl bg-[#FAF8FF] px-4 py-3">
              <p className="text-[12px] font-semibold text-[#8A8A9A]">연결된 AI</p>
              <ul className="mt-1.5 space-y-1">
                {data.providers
                  .filter((p) => p.connected)
                  .map((p) => (
                    <li key={p.id} className="flex items-center justify-between text-[13px]">
                      <span className="font-medium text-[#4B4856]">
                        {p.label} {p.active ? <span className="ml-1 rounded-md bg-[#F3EEFF] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#7C63F6]">사용 중</span> : null}
                      </span>
                      <button
                        className="text-[12px] font-semibold text-[#8B72F6] disabled:text-[#C9C5D6]"
                        disabled={p.active}
                        onClick={() => useModel(p.id, p.id === data.active.provider ? data.active.model : p.defaultModel)}
                      >
                        전환
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </section>

        <PolicySection />

        {/* security / about */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="text-[16px] font-bold text-[#1F1D2B]">정보</h2>
          <ul className="mt-3 divide-y divide-[#F6F4FB] text-[13.5px]">
            <li className="flex items-center justify-between py-3">
              <span className="text-pomong-sub">버전</span>
              <span className="font-semibold text-[#3B3947]">v{data?.version || '0.4.0'}</span>
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
          <Sparkles size={12} /> Pomong Agent v{data?.version || '0.4.0'} · Pomong Labs
        </p>
      </div>
    </div>
  );
}
