import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  BellOff,
  Check,
  Download,
  ExternalLink,
  Globe,
  LogOut,
  Moon,
  Monitor,
  Palette,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-react';
import BackButton from '../components/BackButton';
import MascotFace from '../components/MascotFace';
import {
  api,
  type AccentMode,
  type ExaoneEffort,
  type PersonaId,
  type ProviderId,
  type PushStatus,
  type SettingsResponse,
  type ThemeMode,
} from '../lib/api';
import { useAppStore } from '../lib/store';
import { PERSONA_OPTIONS, personaExample } from '../lib/persona';
import { ACCENT_CHOICES, CHARACTER_ACCENTS, applyTheme, normalizeHex } from '../lib/theme';
import PolicySection from '../components/PolicySection';

/** VAPID 공개키(base64url) → Uint8Array (PushManager.subscribe에 필요) */
function urlBase64ToUint8Array(base64: string): BufferSource {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out.buffer as ArrayBuffer;
}

/** 말투 선택지와 그 말투로 대화했을 때의 예시 (설정 화면에 그대로 보여 준다) */
function toneOptions(callName: string, agentName: string) {
  const agent = agentName || 'Pomong';
  const politeName = callName.endsWith('님') ? callName : `${callName} 님`;
  return [
    {
      id: 'polite' as const,
      label: '존댓말',
      hint: '정중하게',
      example: `나: 오늘 날씨 어때?\n${agent}: ${politeName}, 인제는 지금 흐리고 3도예요. 오후에 비 소식이 있으니 우산을 챙기시는 게 좋겠어요.`,
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
  const [persona, setPersona] = useState<PersonaId>('default');
  const [personaCustom, setPersonaCustom] = useState('');
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [accentMode, setAccentMode] = useState<AccentMode>('purple');
  const [accentColor, setAccentColor] = useState('#8B72F8');
  const [savedFlash, setSavedFlash] = useState('');
  const themeSaveTimer = useRef<number | null>(null);
  const profileSaveTimer = useRef<number | null>(null);

  const [provider, setProvider] = useState<ProviderId>('gemini');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  /** v0.6.2: EXAONE 추론 강도 (low·medium·high) */
  const [effort, setEffort] = useState<ExaoneEffort>('low');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);

  const load = () =>
    api
      .get<SettingsResponse>('/api/settings')
      .then((r) => {
        setData(r);
        setNickname(r.profile.nickname);
        setAgentName(r.profile.agentName);
        setCharacter(r.profile.character || 'pimong');
        setTone(r.profile.tone === 'casual' ? 'casual' : 'polite');
        setPersona(r.profile.persona || 'default');
        setPersonaCustom(r.profile.personaCustom || '');
        setTheme(r.profile.theme || 'light');
        setAccentMode(r.profile.accentMode || 'purple');
        setAccentColor(r.profile.accentColor || '#8B72F8');
        setProvider(r.active.provider);
        setModel(r.active.model);
        setEffort(r.providers.find((p) => p.id === 'exaone')?.reasoningEffort || 'low');
      })
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  const loadPush = async () => {
    const status = await api.get<PushStatus>('/api/push/status').catch(() => null);
    setPushStatus(status);
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setPushOn(Boolean(sub) && status?.subscriptions !== 0);
    } catch {
      setPushOn(false);
    }
  };

  useEffect(() => {
    if ('serviceWorker' in navigator) void loadPush();
  }, []);

  const enablePush = async () => {
    setPushBusy(true);
    setPushMsg('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('이 브라우저는 푸시 알림을 지원하지 않아요. 아이폰은 홈 화면에 앱을 추가한 뒤 열어 주세요.');
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('알림 권한이 거부되었습니다. 브라우저 설정에서 알림을 허용해 주세요.');
      const { publicKey } = await api.get<{ publicKey: string }>('/api/push/vapid-key');
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      const raw = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      await api.post('/api/push/subscribe', { endpoint: raw.endpoint, keys: raw.keys, ua: navigator.userAgent });
      setPushOn(true);
      setPushMsg('푸시 알림을 켰어요. 앱을 보고 있지 않을 때만 알려드려요.');
      await loadPush();
    } catch (err) {
      setPushMsg(err instanceof Error ? err.message : '푸시를 켜지 못했습니다.');
    } finally {
      setPushBusy(false);
    }
  };

  const disablePush = async () => {
    setPushBusy(true);
    setPushMsg('');
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
      }
      setPushOn(false);
      setPushMsg('푸시 알림을 껐어요.');
      await loadPush();
    } catch (err) {
      setPushMsg(err instanceof Error ? err.message : '푸시를 끄지 못했습니다.');
    } finally {
      setPushBusy(false);
    }
  };

  const sendTestPush = async () => {
    setPushBusy(true);
    setPushMsg('');
    try {
      const res = await api.post<{ sent: number; skipped: boolean; reason?: string; code?: string; details?: string[] }>(
        '/api/push/test'
      );
      if (res.sent) {
        setPushMsg('테스트 알림을 보냈어요.');
      } else {
        // v0.5.2: '구독 없음'으로 뭉뚜리지 않고 실제 이유를 보여 준다.
        const lines = [res.reason || '알 수 없는 이유로 보내지 못했어요.'];
        if (res.code === 'no_subscription') lines.push('아래 알림 스위치를 껐다 켜면 이 기기가 다시 등록됩니다.');
        if (res.details?.length) lines.push(`서버 응답: ${res.details.join(' / ')}`);
        setPushMsg(lines.join('\n'));
      }
    } catch (err) {
      setPushMsg(err instanceof Error ? err.message : '테스트 알림을 보내지 못했습니다.');
    } finally {
      setPushBusy(false);
    }
  };

  const resetBrowserState = async () => {
    if (!window.confirm('저장된 브라우저 로그인 세션(쿠키)을 지울까요? 다시 로그인해야 합니다.')) return;
    setBrowserBusy(true);
    try {
      await api.del('/api/browser/state');
      setPushMsg('브라우저 로그인 세션을 초기화했어요.');
    } finally {
      setBrowserBusy(false);
    }
  };

  /**
   * v0.6.0: 말토·성격 프리셋도 테마처럼 **누르는 즉시 서버에 저장**한다.
   * 예전에는 저장 버튼을 눌러야만 반영돼서, 프리셋만 고치고 나가면 사라졌다.
   */
  const applyAndSaveProfile = (patch: { tone?: 'polite' | 'casual'; persona?: PersonaId; personaCustom?: string }) => {
    const toneNext = patch.tone ?? tone;
    const personaNext = patch.persona ?? persona;
    const customNext = patch.personaCustom ?? personaCustom;
    setTone(toneNext);
    setPersona(personaNext);
    setPersonaCustom(customNext);
    if (profileSaveTimer.current) window.clearTimeout(profileSaveTimer.current);
    profileSaveTimer.current = window.setTimeout(() => {
      void api
        .put('/api/settings/profile', {
          nickname,
          agentName,
          character,
          tone: toneNext,
          persona: personaNext,
          personaCustom: customNext,
          theme,
          accentMode,
          accentColor,
        })
        .then(() => refreshProfile())
        .then(() => {
          setSavedFlash('저장했습니다');
          window.setTimeout(() => setSavedFlash(''), 1500);
        })
        .catch(() => undefined);
    }, 250);
  };

  const saveProfile = async () => {
    await api.put('/api/settings/profile', {
      nickname,
      agentName,
      character,
      tone,
      persona,
      personaCustom,
      theme,
      accentMode,
      accentColor,
    });
    applyTheme({ theme, accentMode, accentColor, character });
    setSavedFlash('저장했습니다');
    window.setTimeout(() => setSavedFlash(''), 1800);
    await load();
    await refreshProfile();
  };

  /**
   * 테마는 고르는 즉시 화면에 적용하고 서버에도 저장한다.
   * (새로고침·다른 기기에서도 그대로, 저장 버튼을 잊을 일 없이)
   */
  const applyAndSaveTheme = (next: { theme?: ThemeMode; accentMode?: AccentMode; accentColor?: string }) => {
    const themeNext = next.theme ?? theme;
    const modeNext = next.accentMode ?? accentMode;
    const colorNext = next.accentColor ?? accentColor;
    setTheme(themeNext);
    setAccentMode(modeNext);
    setAccentColor(colorNext);
    applyTheme({ theme: themeNext, accentMode: modeNext, accentColor: colorNext, character });
    if (themeSaveTimer.current) window.clearTimeout(themeSaveTimer.current);
    // 색상 피커는 움직일 때마다 값이 바뀌므로 잠깐 모아서 한 번만 저장한다.
    themeSaveTimer.current = window.setTimeout(() => {
      void api
        .put('/api/settings/profile', {
          nickname,
          agentName,
          character,
          tone,
          persona,
          personaCustom,
          theme: themeNext,
          accentMode: modeNext,
          accentColor: colorNext,
        })
        .then(() => refreshProfile())
        .catch(() => undefined);
    }, 400);
  };

  useEffect(() => {
    return () => {
      if (themeSaveTimer.current) window.clearTimeout(themeSaveTimer.current);
    };
  }, []);

  const saveKey = async () => {
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const r = await api.post<{ message: string }>('/api/settings/api-key', {
        provider,
        apiKey,
        model: model || undefined,
        reasoningEffort: provider === 'exaone' ? effort : undefined,
      });
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
  const characterAccent = CHARACTER_ACCENTS[character]?.color || '#8B72F8';
  const previewAccent = accentMode === 'character' ? characterAccent : accentMode === 'custom' ? normalizeHex(accentColor) : '#8B72F8';
  const accentLabel =
    accentMode === 'character'
      ? `캐릭터 맞춤 · ${CHARACTER_ACCENTS[character]?.name || '피몽'} ${CHARACTER_ACCENTS[character]?.hint || ''}`
      : accentMode === 'custom'
        ? `직접 고른 색 ${normalizeHex(accentColor)}`
        : '기본 퍼플';
  /** v0.6.2: EXAONE 추론 강도 — 문서 기준 low가 가장 빠르고 high/max가 정확하다. */
  const effortChoices: { id: ExaoneEffort; label: string; hint: string }[] = [
    { id: 'low', label: '낮음', hint: '가장 빠른 응답' },
    { id: 'medium', label: '보통', hint: '속도·정확 균형' },
    { id: 'high', label: '높음', hint: '정확·느림' },
  ];
  const exaoneConnected = Boolean(data?.providers.find((p) => p.id === 'exaone')?.connected);
  const pickEffort = async (next: ExaoneEffort) => {
    setEffort(next);
    setKeyMsg(null);
    if (!exaoneConnected) return;
    try {
      await api.post('/api/settings/provider-options', { provider: 'exaone', reasoningEffort: next });
      await load();
    } catch (err) {
      setKeyMsg({ ok: false, text: err instanceof Error ? err.message : '추론 강도를 바꾸지 못했습니다.' });
    }
  };

  const themeChoices: { id: ThemeMode; label: string; hint: string; icon: typeof Sun }[] = [
    { id: 'light', label: '라이트', hint: '밝은 화면', icon: Sun },
    { id: 'dark', label: '다크', hint: '어두운 화면', icon: Moon },
    { id: 'system', label: '기기 설정 따름', hint: '아이폰 설정에 맞춤', icon: Monitor },
  ];
  const accentChoices: { id: AccentMode; label: string; hint: string }[] = [
    { id: 'character', label: '캐릭터 맞춤', hint: `${CHARACTER_ACCENTS[character]?.name || '피몽'} 컬러` },
    { id: 'purple', label: '기본 퍼플', hint: '포몽 브랜드' },
    { id: 'custom', label: '직접 고르기', hint: '원하는 색으로' },
  ];
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
        <header className="flex items-center gap-2">
          <BackButton />
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
              <span className="text-[11.5px] text-[#B4B1C2]">누르면 바로 저장돼요 · 다음 대화부터 적용</span>
            </div>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              {toneOptions(callName, agentName).map((opt) => {
                const active = tone === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => applyAndSaveProfile({ tone: opt.id })}
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

          <div className="mt-5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-semibold text-[#5B5866]">AI 성격·말투 프리셋</span>
              <span className="text-[11.5px] text-[#B4B1C2]">말투 위에 얹는 성격의 결</span>
            </div>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              {PERSONA_OPTIONS.map((opt) => {
                const active = persona === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => applyAndSaveProfile({ persona: opt.id })}
                    className={`rounded-2xl border-[1.5px] px-4 py-3 text-left transition ${
                      active ? 'border-[#C9B8FF] bg-[#F8F5FF]' : 'border-[#EFEDF6] bg-white hover:bg-[#FBFAFF]'
                    }`}
                    aria-pressed={active}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-[15px] leading-none">{opt.emoji}</span>
                      <span className={`text-[14px] font-semibold ${active ? 'text-[#7C63F6]' : 'text-[#4B4856]'}`}>
                        {opt.label}
                      </span>
                      <span className="text-[11.5px] font-medium text-[#B4B1C2]">{opt.hint}</span>
                      {active ? (
                        <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-[#8B72F8] text-white">
                          <Check size={12} strokeWidth={4} />
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1.5 block text-[11.5px] leading-relaxed text-[#8A8A9A]">{opt.summary}</span>
                  </button>
                );
              })}
            </div>
            {persona === 'custom' ? (
              <label className="mt-2.5 block">
                <span className="mb-1.5 block text-[12.5px] font-semibold text-[#5B5866]">원하는 성격 한 줄</span>
                <input
                  className="pa-input"
                  value={personaCustom}
                  maxLength={60}
                  placeholder="예: 츤데레지만 챙길 건 다 챙기는 비서"
                  onChange={(e) => applyAndSaveProfile({ personaCustom: e.target.value })}
                />
              </label>
            ) : null}
            <div className="mt-2.5 rounded-2xl bg-[#FAF9FD] px-3.5 py-2.5">
              <span className="text-[11px] font-semibold text-[#B4B1C2]">미리보기</span>
              <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed text-[#5B5866]">
                {personaExample(persona, { callName, agentName, polite: tone === 'polite', custom: personaCustom })}
              </p>
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

        {/* 테마 (v0.5.6) */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-bold text-[#1F1D2B]">화면 테마</h2>
              <p className="mt-1 text-[13px] text-pomong-sub">고르는 즉시 적용되고, 새로고침해도 그대로예요</p>
            </div>
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#F3EEFF] px-3 py-1.5 text-[11.5px] font-semibold text-[#7C63F6]">
              <Palette size={12} />
              {theme === 'system' ? '기기 설정 따름' : theme === 'dark' ? '다크' : '라이트'}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {themeChoices.map((opt) => {
              const active = theme === opt.id;
              const Icon = opt.icon;
              return (
                <button
                  key={opt.id}
                  onClick={() => applyAndSaveTheme({ theme: opt.id })}
                  className={`flex flex-col items-center gap-1.5 rounded-2xl border-[1.5px] px-2 py-3 transition ${
                    active ? 'border-[#C9B8FF] bg-[#F8F5FF] text-[#7C63F6]' : 'border-[#EFEDF6] bg-white text-[#5B5866]'
                  }`}
                  aria-pressed={active}
                >
                  <Icon size={19} />
                  <span className="text-[12.5px] font-semibold leading-none">{opt.label}</span>
                  <span className={`text-[10.5px] ${active ? 'text-[#8B72F6]' : 'text-[#B4B1C2]'}`}>{opt.hint}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-semibold text-[#5B5866]">포인트 컬러</span>
              <span className="text-[11.5px] text-[#B4B1C2]">버튼 · 활성 탭 · 배지 · 내 말풍선</span>
            </div>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
              {accentChoices.map((opt) => {
                const active = accentMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => applyAndSaveTheme({ accentMode: opt.id })}
                    className={`flex items-center gap-2.5 rounded-2xl border-[1.5px] px-3.5 py-2.5 text-left transition ${
                      active ? 'border-[#C9B8FF] bg-[#F8F5FF]' : 'border-[#EFEDF6] bg-white hover:bg-[#FBFAFF]'
                    }`}
                    aria-pressed={active}
                  >
                    <span
                      className="h-6 w-6 shrink-0 rounded-full ring-2 ring-white"
                      style={{
                        background:
                          opt.id === 'character'
                            ? characterAccent
                            : opt.id === 'custom'
                              ? normalizeHex(accentColor)
                              : '#8B72F8',
                      }}
                    />
                    <span className="min-w-0">
                      <span className={`block text-[13px] font-semibold ${active ? 'text-[#7C63F6]' : 'text-[#4B4856]'}`}>
                        {opt.label}
                      </span>
                      <span className="block truncate text-[10.5px] text-[#B4B1C2]">{opt.hint}</span>
                    </span>
                    {active ? (
                      <span className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#8B72F8] text-white">
                        <Check size={10} strokeWidth={4} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {accentMode === 'custom' ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {ACCENT_CHOICES.map((choice) => {
                  const active = normalizeHex(accentColor) === choice.color;
                  return (
                    <button
                      key={choice.color}
                      onClick={() => applyAndSaveTheme({ accentColor: choice.color })}
                      className={`h-8 w-8 rounded-full ring-2 transition ${active ? 'ring-[#7C63F6]' : 'ring-transparent'}`}
                      style={{ background: choice.color }}
                      title={choice.name}
                      aria-label={choice.name}
                      aria-pressed={active}
                    />
                  );
                })}
                <label className="ml-1 flex items-center gap-2 rounded-full border border-[#E9E7F2] px-3 py-1.5 text-[11.5px] font-semibold text-[#5B5866]">
                  <input
                    type="color"
                    className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                    value={normalizeHex(accentColor)}
                    onChange={(e) => applyAndSaveTheme({ accentColor: e.target.value })}
                    aria-label="직접 색 고르기"
                  />
                  직접 고르기
                </label>
              </div>
            ) : null}

            <div className="mt-3 flex items-center gap-2.5 rounded-2xl bg-[#FAF9FD] px-3.5 py-2.5">
              <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: previewAccent }} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[#5B5866]">{accentLabel}</span>
              <span
                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-bold"
                style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
              >
                <Check size={10} strokeWidth={4} /> 저장됨
              </span>
            </div>
            <p className="mt-2 text-[11.5px] leading-[1.6] text-[#B4B1C2]">
              캐릭터 맞춤은 지금 고른 마스코트의 색을 그대로 따라가요. 마스코트를 바꾸면 포인트 컬러도 함께 바뀝니다.
            </p>
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
                {p.id === 'exaone' ? (
                  <span className="ml-1 rounded-md bg-[#EAFBF1] px-1.5 py-0.5 align-middle text-[10px] font-bold text-[#12B886]">무료</span>
                ) : null}
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

          {provider === 'exaone' ? (
            <div className="mt-3 rounded-2xl bg-[#F7FBFF] px-3.5 py-3 ring-1 ring-[#E7F1FE]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-[#3B3947]">추론 강도</span>
                <span className="text-[11px] text-[#8A8A9A]">높을수록 정확하지만 느려요</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {effortChoices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    onClick={() => void pickEffort(choice.id)}
                    className={`rounded-xl border-[1.5px] px-2 py-2 text-center transition ${
                      effort === choice.id
                        ? 'border-[#9DC7FF] bg-white text-[#2F86D8]'
                        : 'border-transparent bg-white/70 text-[#6B677A] hover:border-[#D7E7FB]'
                    }`}
                    aria-pressed={effort === choice.id}
                  >
                    <span className="block text-[13px] font-bold">{choice.label}</span>
                    <span className="block text-[10.5px] text-[#9B98AB]">{choice.hint}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-[1.55] text-[#7C86A0]">
                K-EXAONE 2.5는 답하기 전에 항상 추론해요. 사진은 볼 수 없는 텍스트 모델이고, 무료 키는 30일마다
                재발급이 필요해요.
              </p>
            </div>
          ) : null}

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

        {/* 알림 · 브라우저 */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="text-[16px] font-bold text-[#1F1D2B]">알림 · 브라우저</h2>
          <div className="mt-3 flex items-center gap-3 rounded-2xl bg-[#FAF9FD] px-4 py-3">
            <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${pushOn ? 'bg-[#EAFBF1] text-[#12B886]' : 'bg-[#F3EEFF] text-[#8B72F6]'}`}>
              {pushOn ? <Bell size={17} /> : <BellOff size={17} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-[#3B3947]">푸시 알림 받기</p>
              <p className="text-[11.5px] leading-[1.5] text-[#8A8A9A]">
                앱을 보고 있을 때는 알림이 뜨지 않아요. 답변 완료·로그인 필요·예약/워치 알림만 보내드려요.
              </p>
            </div>
            <button
              className={`relative h-6 w-11 shrink-0 rounded-full px-0.5 transition ${pushOn ? 'bg-[#9FDCC4]' : 'bg-[#E4E1EF]'}`}
              onClick={() => (pushOn ? disablePush() : enablePush())}
              disabled={pushBusy || !pushStatus?.enabled}
              aria-label={pushOn ? '푸시 알림 끄기' : '푸시 알림 켜기'}
            >
              <span className={`block h-5 w-5 rounded-full bg-white shadow transition ${pushOn ? 'translate-x-[20px]' : 'translate-x-0'}`} />
            </button>
          </div>
          {pushStatus && !pushStatus.enabled ? (
            <p className="mt-2 text-[11.5px] text-[#C08A16]">푸시 키를 준비하지 못했어요{pushStatus.error ? ` (${pushStatus.error})` : ''}.</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <button className="pa-btn-ghost px-3 py-2 text-[12.5px]" onClick={sendTestPush} disabled={pushBusy || !pushOn}>
              <Send size={14} /> 테스트 알림 보내기
            </button>
            <button className="pa-btn-ghost px-3 py-2 text-[12.5px]" onClick={resetBrowserState} disabled={browserBusy}>
              <Globe size={14} /> <Trash2 size={13} /> 브라우저 로그인 세션 초기화
            </button>
          </div>
          {pushMsg ? (
            <p className="mt-2 whitespace-pre-line rounded-xl bg-[#F7F5FF] px-3 py-2 text-[12px] leading-relaxed text-[#5B4BC4]">
              {pushMsg}
            </p>
          ) : null}
          <p className="mt-3 text-[11.5px] leading-[1.6] text-[#B4B1C2]">
            브라우저 로그인 세션은 서버의 data/browser-state.json 에 보관돼, 앱을 다시 열어도 로그인이 유지됩니다.
            아이폰은 사파리 공유 → “홈 화면에 추가”로 설치해야 푸시 알림을 받을 수 있어요.
            {pushStatus?.subject ? ` (발신자 주소: ${pushStatus.subject})` : ''}
          </p>
        </section>

        <PolicySection />

        {/* 데이터 백업 (v0.5.4) */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="text-[16px] font-bold text-[#1F1D2B]">데이터 백업</h2>
          <p className="mt-2 text-[12.5px] leading-[1.6] text-[#8A8A9A]">
            기억함·대화·대화방·자동화·설정·금고 메타를 JSON 파일 하나로 내려받아요. 더 좋은 사양의 서버로 옮길 때 그대로 쓸 수 있어요.
            금고 비밀번호와 API 키 평문은 파일에 들어가지 않아요.
          </p>
          <a
            href="/api/backup/export"
            download
            className="pa-btn-ghost mt-3 inline-flex items-center gap-1.5 px-3.5 py-2.5 text-[13px]"
          >
            <Download size={15} /> 데이터 백업 내보내기 (JSON)
          </a>
        </section>

        {/* security / about */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="text-[16px] font-bold text-[#1F1D2B]">정보</h2>
          <ul className="mt-3 divide-y divide-[#F6F4FB] text-[13.5px]">
            <li className="flex items-center justify-between py-3">
              <span className="text-pomong-sub">버전</span>
              <span className="font-semibold text-[#3B3947]">v{data?.version || '0.6.0'}</span>
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
          <Sparkles size={12} /> Pomong Agent v{data?.version || '0.6.0'} · Pomong Labs
        </p>
      </div>
    </div>
  );
}
