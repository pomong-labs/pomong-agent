import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import Mascot from '../components/Mascot';
import Logo from '../components/Logo';
import { api, ApiError } from '../lib/api';

type ProviderId = 'gemini' | 'openai' | 'claude';

const STEPS = [
  { n: 1, label: 'Account', color: '#FFB7CA', tint: '#FFF0F4' },
  { n: 2, label: 'AI Key', color: '#A78BFA', tint: '#F3EEFF' },
  { n: 3, label: 'Style', color: '#7CB7F5', tint: '#EFF7FF' },
  { n: 4, label: 'Done', color: '#5ED3A8', tint: '#EBFBF3' },
];

const PROVIDERS: { id: ProviderId; label: string; accent: string }[] = [
  { id: 'gemini', label: 'Gemini', accent: '#7C63F6' },
  { id: 'openai', label: 'OpenAI', accent: '#1F1D2B' },
  { id: 'claude', label: 'Claude', accent: '#D97757' },
];

function ProviderMark({ id, size = 22 }: { id: ProviderId; size?: number }) {
  if (id === 'gemini') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <defs>
          <linearGradient id="gm" x1="2" y1="2" x2="22" y2="22">
            <stop stopColor="#4285F4" />
            <stop offset="0.5" stopColor="#A259FF" />
            <stop offset="1" stopColor="#F49AC2" />
          </linearGradient>
        </defs>
        <path d="M12 2c.6 4.7 3.3 7.4 8 8-4.7.6-7.4 3.3-8 8-.6-4.7-3.3-7.4-8-8 4.7-.6 7.4-3.3 8-8z" fill="url(#gm)" />
      </svg>
    );
  }
  if (id === 'openai') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#1F1D2B" strokeWidth="1.7">
        <circle cx="12" cy="12" r="4.1" />
        <path d="M12 7.9V3.4M12 20.6v-4.5M7.9 12H3.4M20.6 12h-4.5M9 9l-3.2-3.2M18.2 18.2 15 15M15 9l3.2-3.2M5.8 18.2 9 15" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#D97757" strokeWidth="2" strokeLinecap="round">
      <path d="M12 4v16M4 8l16 8M20 8 4 16" />
    </svg>
  );
}

export default function Setup() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<'checking' | 'locked' | 'token' | 'ready'>('checking');
  const [tokenValue, setTokenValue] = useState(params.get('token') || '');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // step 1
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  // step 2
  const [provider, setProvider] = useState<ProviderId>('gemini');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [connected, setConnected] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [testing, setTesting] = useState(false);
  // step 3
  const [nickname, setNickname] = useState('');
  const [agentName, setAgentName] = useState('Pomong');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [language, setLanguage] = useState<'ko' | 'en'>('ko');

  useEffect(() => {
    const token = params.get('token');
    api
      .get<{ verified: boolean }>('/api/setup/state')
      .then(async (state) => {
        if (state.verified) {
          setPhase('ready');
          return;
        }
        if (token) {
          try {
            await api.post('/api/setup/verify-token', { token });
            setPhase('ready');
          } catch {
            setPhase('token');
            setError('설정 토큰이 올바르지 않습니다. 서버 로그에 출력된 주소를 다시 확인해 주세요.');
          }
          return;
        }
        setPhase('token');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 410) setPhase('locked');
        else setPhase('token');
      });
  }, [params]);

  const verifyToken = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/api/setup/verify-token', { token: tokenValue.trim() });
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : '토큰 확인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const canNext = useMemo(() => {
    if (step === 0) return username.trim().length >= 2 && password.length >= 8 && password === password2;
    if (step === 1) return connected || skipped;
    if (step === 2) return true;
    return true;
  }, [step, username, password, password2, connected, skipped]);

  const saveAccount = async () => {
    await api.post('/api/setup/account', { username: username.trim(), password });
  };

  const testKey = async () => {
    setTesting(true);
    setError('');
    try {
      await api.post('/api/setup/provider', { provider, apiKey });
      setConnected(true);
      setNotice('연결이 성공적으로 완료되었습니다.');
    } catch (err) {
      setConnected(false);
      setError(err instanceof Error ? err.message : '연결 테스트에 실패했습니다.');
    } finally {
      setTesting(false);
    }
  };

  const savePrefs = async () => {
    await api.post('/api/setup/preferences', { nickname, agentName, theme, language });
  };

  const next = async () => {
    setError('');
    setBusy(true);
    try {
      if (step === 0) {
        if (password !== password2) throw new Error('비밀번호가 서로 다릅니다.');
        await saveAccount();
      } else if (step === 1) {
        if (!connected && !skipped) {
          await api.post('/api/setup/provider', { provider, apiKey, skip: true });
        }
      } else if (step === 2) {
        await savePrefs();
      } else {
        await api.post('/api/setup/complete', {});
        navigate('/', { replace: true });
        return;
      }
      setStep((s) => Math.min(3, s + 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : '다음 단계로 넘어가지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    setError('');
    setNotice('');
    setStep((s) => Math.max(0, s - 1));
  };

  if (phase === 'checking') {
    return (
      <div className="flex h-full items-center justify-center bg-pomong-bg">
        <Mascot name="pimong" hero size={90} className="animate-float" />
      </div>
    );
  }

  if (phase === 'locked') {
    return (
      <div className="flex h-full items-center justify-center bg-pomong-bg p-6">
        <div className="pa-card w-full max-w-md p-10 text-center">
          <Mascot name="poding" hero size={90} className="mx-auto" />
          <h1 className="mt-4 text-[22px] font-bold">설정이 이미 완료되었어요</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-pomong-sub">
            보안을 위해 /setup 경로는 잠겼습니다.<br />관리자 계정으로 로그인해 주세요.
          </p>
          <button className="pa-btn-primary mt-6 w-full" onClick={() => navigate('/login')}>
            로그인 화면으로
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'token') {
    return (
      <div className="flex h-full items-center justify-center bg-pomong-bg p-6">
        <div className="pa-card w-full max-w-md p-10 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-pomong-lavender">
            <KeyRound size={28} className="text-pomong-primaryDeep" />
          </div>
          <h1 className="mt-5 text-[22px] font-bold">설정 토큰이 필요해요</h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-pomong-sub">
            서버 로그에 출력된 1회용 설정 주소의 토큰을 입력해 주세요.<br />
            <span className="text-[13px] text-[#A8A5B8]">docker compose logs pomong-agent | grep setup</span>
          </p>
          <input
            className="pa-input mt-6 text-center font-mono text-[14px]"
            placeholder="setup token"
            value={tokenValue}
            onChange={(e) => setTokenValue(e.target.value)}
          />
          {error ? <p className="mt-3 text-[13.5px] font-medium text-[#E5484D]">{error}</p> : null}
          <button className="pa-btn-primary mt-5 w-full" disabled={busy || !tokenValue.trim()} onClick={verifyToken}>
            확인
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-full overflow-hidden bg-pomong-bg px-4 pb-14 pt-8 sm:px-8">
      {/* soft decorations */}
      <div className="pointer-events-none absolute -left-24 top-24 h-72 w-72 rounded-full bg-[#FFE4EE] opacity-40 blur-3xl" />
      <div className="pointer-events-none absolute -right-16 top-10 h-64 w-64 rounded-full bg-[#E4F4FF] opacity-50 blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-[#F1EAFF] opacity-40 blur-3xl" />

      <div className="relative mx-auto w-full max-w-[860px]">
        {/* stepper */}
        <ol className="flex items-start justify-center gap-1.5 sm:gap-3">
          {STEPS.map((s, i) => {
            const active = step === i;
            const done = step > i;
            return (
              <li key={s.n} className="flex items-start">
                <div
                  className="flex flex-col items-center gap-1.5 rounded-[18px] px-3 py-2 transition sm:flex-row sm:gap-2.5 sm:rounded-full sm:px-5 sm:py-2.5"
                  style={{
                    background: active ? '#fff' : `${s.tint}`,
                    border: `1.5px solid ${active ? s.color : 'transparent'}`,
                    boxShadow: active ? '0 10px 24px rgba(120,100,200,0.12)' : 'none',
                  }}
                >
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-bold text-white"
                    style={{ background: active || done ? s.color : '#fff', color: active || done ? '#fff' : s.color, border: `1.5px solid ${s.color}` }}
                  >
                    {done ? <Check size={13} strokeWidth={3} /> : s.n}
                  </span>
                  <span className="text-[13px] font-semibold sm:text-[15px]" style={{ color: s.color }}>
                    {s.label}
                  </span>
                </div>
                {i < STEPS.length - 1 ? (
                  <span className="mx-0.5 mt-3 hidden h-[1.5px] w-4 rounded bg-[#E7E4F1] sm:block lg:w-8" />
                ) : null}
              </li>
            );
          })}
        </ol>

        {/* mascot stage */}
        <div className="relative mt-6 flex items-end justify-center">
          <Mascot name="pimong" hero size={148} className="-mr-4 hidden translate-y-3 animate-float sm:block" />
          <Mascot name="pongi" hero size={132} className="-ml-2 hidden translate-y-5 animate-float sm:block" />
          <div className="absolute -top-2 left-1/2 hidden -translate-x-1/2 rounded-2xl rounded-bl-md bg-white px-4 py-2 text-[13px] font-medium text-[#6B677A] shadow-card sm:block">
            {step === 0 ? '이 서버의 주인이 누구인지 알려주세요!' : step === 1 ? 'AI 키를 연결하면 더 똑똑해져요!' : step === 2 ? '취향을 알려주면 더 친해질 수 있어요!' : '준비가 끝났어요!'}
          </div>
        </div>

        {/* card */}
        <div className="relative -mt-6 rounded-[34px] bg-white px-5 py-8 shadow-soft sm:px-12 sm:py-10">
          <div className="flex flex-col items-center">
            <Logo size={30} withText={false} />
            <h1 className="mt-3 text-center text-[26px] font-bold tracking-[-0.02em] sm:text-[32px]">Pomong Agent Setup</h1>
            <p className="mt-2 text-center text-[14.5px] text-pomong-sub">
              {step === 0 && '먼저 관리자 계정을 만들어 주세요.'}
              {step === 1 && 'AI 서비스 연결을 설정해 주세요.'}
              {step === 2 && '나만의 포몽을 꾸며 주세요.'}
              {step === 3 && '설정이 완료되었습니다. 이제 시작해요!'}
            </p>
          </div>

          <div className="mt-8">
            {step === 0 ? (
              <div className="mx-auto max-w-[460px] space-y-4">
                <Field label="아이디">
                  <input className="pa-input" placeholder="admin" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
                </Field>
                <Field label="비밀번호" hint="8자 이상">
                  <input
                    className="pa-input"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="비밀번호 확인">
                  <input
                    className="pa-input"
                    type="password"
                    placeholder="••••••••"
                    value={password2}
                    onChange={(e) => setPassword2(e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <div className="flex items-start gap-3 rounded-2xl bg-[#F7F5FF] px-4 py-3.5 text-[13px] leading-relaxed text-[#6D6880]">
                  <ShieldCheck size={18} className="mt-0.5 shrink-0 text-pomong-primaryDeep" />
                  이 계정은 서버의 유일한 관리자입니다. 비밀번호는 scrypt로 해시되어 저장되고, 외부로 전송되지 않습니다.
                </div>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="mx-auto max-w-[560px] space-y-6">
                <div>
                  <p className="mb-2.5 text-[14px] font-semibold text-[#3B3947]">1. AI Provider 선택</p>
                  <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-[#E9E7F2]">
                    {PROVIDERS.map((p) => {
                      const active = provider === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setProvider(p.id);
                            setConnected(false);
                            setNotice('');
                          }}
                          className={`flex items-center justify-center gap-2 py-4 text-[15px] font-semibold transition ${
                            active ? 'bg-[#F6F2FF] text-[#7C63F6]' : 'bg-white text-[#3B3947]'
                          } ${p.id !== 'claude' ? 'border-r border-[#E9E7F2]' : ''}`}
                          style={active ? { boxShadow: 'inset 0 0 0 1.5px #C9B8FF' } : undefined}
                        >
                          <ProviderMark id={p.id} />
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <p className="mb-2.5 text-[14px] font-semibold text-[#3B3947]">2. API Key 입력</p>
                  <div className="relative">
                    <input
                      className="pa-input pr-[130px] font-mono text-[13.5px]"
                      type={showKey ? 'text' : 'password'}
                      placeholder="API 키를 붙여넣어 주세요"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setConnected(false);
                      }}
                    />
                    <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                      <button
                        type="button"
                        className="rounded-lg p-2 text-[#A8A5B8] hover:bg-[#F7F5FF]"
                        onClick={() => setShowKey((v) => !v)}
                        aria-label="키 표시"
                      >
                        {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                      {connected ? (
                        <span className="flex items-center gap-1 rounded-full bg-[#EAFBF1] px-3 py-1.5 text-[12.5px] font-semibold text-[#12B886]">
                          <Check size={13} strokeWidth={3} /> Connected
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={testKey}
                          disabled={testing || !apiKey.trim()}
                          className="rounded-xl bg-[#F4F0FF] px-3 py-2 text-[12.5px] font-semibold text-[#7C63F6] disabled:opacity-40"
                        >
                          {testing ? '확인 중…' : '연결 테스트'}
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-2 text-[12.5px] text-[#9B98AB]">
                    {notice || '안전하게 암호화되어 저장되며, 언제든 변경할 수 있어요.'}
                  </p>
                </div>

                <button
                  type="button"
                  className="text-[13px] font-medium text-[#9B98AB] underline decoration-[#DDD9EA] underline-offset-4"
                  onClick={() => {
                    setSkipped(true);
                    setConnected(false);
                    setStep(2);
                  }}
                >
                  지금은 건너뛰고 나중에 설정할게요
                </button>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="mx-auto max-w-[520px] space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="내 닉네임" hint="선택">
                    <input className="pa-input" placeholder="현준" value={nickname} onChange={(e) => setNickname(e.target.value)} />
                  </Field>
                  <Field label="에이전트 이름">
                    <input className="pa-input" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
                  </Field>
                </div>
                <Field label="테마">
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setTheme('light')}
                      className={`rounded-2xl border-[1.5px] px-4 py-3 text-left text-[14px] font-semibold ${
                        theme === 'light' ? 'border-[#C9B8FF] bg-[#F8F5FF] text-[#7C63F6]' : 'border-[#E9E7F2] bg-white text-[#5B5866]'
                      }`}
                    >
                      라이트 (기본)
                      <span className="mt-1 block text-[12px] font-normal text-[#9B98AB]">포몽 파스텔</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTheme('dark')}
                      className={`rounded-2xl border-[1.5px] px-4 py-3 text-left text-[14px] font-semibold ${
                        theme === 'dark' ? 'border-[#C9B8FF] bg-[#F8F5FF] text-[#7C63F6]' : 'border-[#E9E7F2] bg-white text-[#5B5866]'
                      }`}
                    >
                      다크
                      <span className="mt-1 block text-[12px] font-normal text-[#9B98AB]">v0.2에서 적용</span>
                    </button>
                  </div>
                </Field>
                <Field label="언어">
                  <div className="grid grid-cols-2 gap-3">
                    {(
                      [
                        ['ko', '한국어'],
                        ['en', 'English'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setLanguage(value)}
                        className={`rounded-2xl border-[1.5px] px-4 py-3 text-[14px] font-semibold ${
                          language === value ? 'border-[#C9B8FF] bg-[#F8F5FF] text-[#7C63F6]' : 'border-[#E9E7F2] bg-white text-[#5B5866]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="mx-auto max-w-[480px]">
                <div className="flex flex-col items-center">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#EAFBF1]">
                    <Check size={38} className="text-[#12B886]" strokeWidth={3} />
                  </div>
                  <p className="mt-4 text-[17px] font-bold">모든 준비가 끝났어요!</p>
                  <p className="mt-1 text-center text-[14px] leading-relaxed text-pomong-sub">
                    이제 {agentName || 'Pomong'}와 함께 서버도 챙기고 일도 정리해 보세요.
                  </p>
                </div>
                <dl className="mt-6 divide-y divide-[#F1EFF7] overflow-hidden rounded-2xl border border-[#F1EFF7]">
                  <SummaryRow label="관리자 계정" value={username || 'admin'} />
                  <SummaryRow label="AI Provider" value={connected ? PROVIDERS.find((p) => p.id === provider)?.label || '연결됨' : '나중에 설정'} />
                  <SummaryRow label="에이전트" value={agentName || 'Pomong'} />
                  <SummaryRow label="보안" value="AES-256-GCM 금고 사용 가능" />
                </dl>
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="mx-auto mt-5 max-w-[520px] rounded-2xl bg-[#FFF1F1] px-4 py-3 text-[13.5px] font-medium text-[#E5484D]">
              {error}
            </div>
          ) : null}

          <div className="mx-auto mt-7 flex max-w-[520px] flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              className={`pa-btn-ghost w-full justify-center sm:w-auto ${step === 0 ? 'invisible' : ''}`}
              onClick={back}
              disabled={busy}
            >
              <ArrowLeft size={17} /> Back
            </button>
            <button className="pa-btn-primary w-full sm:w-auto sm:min-w-[200px]" onClick={next} disabled={busy || !canNext}>
              {step === 3 ? (
                <>
                  <Sparkles size={17} /> 시작하기
                </>
              ) : (
                <>
                  Next Step <ArrowRight size={17} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline gap-1.5 text-[14px] font-semibold text-[#3B3947]">
        {label}
        {hint ? <span className="text-[12px] font-normal text-[#A8A5B8]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between bg-white px-4 py-3.5">
      <dt className="text-[13.5px] text-pomong-sub">{label}</dt>
      <dd className="text-[13.5px] font-semibold text-[#3B3947]">{value}</dd>
    </div>
  );
}
