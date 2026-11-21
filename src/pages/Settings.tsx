import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  Globe,
  KeyRound,
  LogOut,
  Mail,
  Moon,
  Monitor,
  Palette,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Type,
} from 'lucide-react';
import BackButton from '../components/BackButton';
import MascotFace from '../components/MascotFace';
import {
  api,
  type AccentMode,
  type ExaoneEffort,
  type MailAccount,
  type MailPreset,
  type PersonaId,
  type ProviderId,
  type PushStatus,
  type RouteChoice,
  type RoutingSettings,
  type SettingsResponse,
  type ThemeMode,
} from '../lib/api';
import { useAppStore } from '../lib/store';
import { PERSONA_OPTIONS, personaExample } from '../lib/persona';
import { ACCENT_CHOICES, CHARACTER_ACCENTS, applyTheme, normalizeHex } from '../lib/theme';
import { FONT_OPTIONS, applyFont, readStoredFont, type FontId } from '../lib/font';
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
      example: `나: 오늘 날씨 어때?\n${agent}: ${politeName}, 서울은 지금 흐리고 3도예요. 오후에 비 소식이 있으니 우산을 챙기시는 게 좋겠어요.`,
    },
    {
      id: 'casual' as const,
      label: '편한 반말',
      hint: '친구처럼',
      example: `나: 오늘 날씨 어때?\n${agent}: ${callName}아, 서울은 지금 흐리고 3도야. 오후에 비 온대, 우산 챙겨!`,
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
  /** v0.6.4: 앱 글꼴 — v0.6.5: 첫 페인트에 이미 적용된 글꼴(localStorage)에서 시작해 체크가 깜빡이지 않게 한다 */
  const [font, setFont] = useState<FontId>(() => readStoredFont());
  /** v0.6.4: 설정 카테고리 탭 — 긴 스크롤 대신 한 묶음씩 보여 준다. */
  const [tab, setTab] = useState<'look' | 'ai' | 'mail' | 'system'>('look');
  /** v0.6.4: AI 프로바이더는 평소 1줄로 접어 두고 필요할 때 펼친다. */
  const [openProvider, setOpenProvider] = useState<ProviderId | null>(null);
  const savedFlashTimer = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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

  /** v0.6.3: 작업별 모델 자동 라우팅 */
  const [routing, setRouting] = useState<RoutingSettings>({
    chat: 'inherit',
    browser: 'inherit',
    vision: 'inherit',
    writing: 'inherit',
  });
  const [routingBusy, setRoutingBusy] = useState(false);

  /** v0.6.3: 이메일(IMAP/SMTP) 계정 */
  const [mailAccounts, setMailAccounts] = useState<MailAccount[]>([]);
  const [mailPresets, setMailPresets] = useState<MailPreset[]>([]);
  const [mailForm, setMailForm] = useState({ provider: 'naver', email: '', secret: '', senderName: '' });
  const [mailBusy, setMailBusy] = useState(false);
  const [mailMsg, setMailMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);

  /** v0.6.13: 계정 비밀번호 변경 */
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** v0.6.13: PWA 캐시 초기화 */
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMsg, setCacheMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
        setFont(r.profile.font === 'default' ? readStoredFont() : r.profile.font || 'default');
        setProvider(r.active.provider);
        setModel(r.active.model);
        setEffort(r.providers.find((p) => p.id === 'exaone')?.reasoningEffort || 'low');
        if (r.routing) setRouting(r.routing);
        if (r.mail) {
          setMailAccounts(r.mail.accounts || []);
          setMailPresets(r.mail.presets || []);
        }
      })
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  // v0.6.4: 탭을 바꾸면 그 묶음의 처음부터 보이게 맨 위로 올린다.
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [tab]);

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
   * v0.6.13: 계정 비밀번호 변경.
   * 현재 비밀번호로 본인 확인 → 새 비밀번호(8자 이상) + 확인 일치 → 서버가 users.password_hash 를 바꾼다.
   */
  const changePassword = async () => {
    setPwMsg(null);
    if (!pwForm.current) {
      setPwMsg({ ok: false, text: '현재 비밀번호를 입력해 주세요.' });
      return;
    }
    if (pwForm.next.length < 8) {
      setPwMsg({ ok: false, text: '새 비밀번호는 8자 이상이어야 해요.' });
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      setPwMsg({ ok: false, text: '새 비밀번호 확인이 일치하지 않아요.' });
      return;
    }
    setPwBusy(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword: pwForm.current, newPassword: pwForm.next });
      setPwForm({ current: '', next: '', confirm: '' });
      setPwMsg({ ok: true, text: '비밀번호를 바꿨어요. 다음 로그인부터 새 비밀번호를 쓰세요.' });
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof Error ? err.message : '비밀번호를 바꾸지 못했어요.' });
    } finally {
      setPwBusy(false);
    }
  };

  /**
   * v0.6.13: 앱 캐시 초기화 및 새로고침.
   * 아이폰 PWA는 서비스워커가 예전 빌드를 캐시에 붙들고 있어 새 배포가 바로 반영되지 않는다.
   * Cache Storage 전체 삭제 → 서비스워커 등록 해제 → 새로고침. 새로고침 뒤 main.tsx 가
   * 서비스워커를 다시 등록하므로, 바로 다음 화면부터 새 버전을 받아 온다.
   */
  const resetAppCache = async () => {
    if (!window.confirm('앱 캐시를 지우고 새로고침할까요? 로그인 상태와 대화는 그대로예요.')) return;
    setCacheBusy(true);
    setCacheMsg({ ok: true, text: '캐시를 지우는 중이에요…' });
    try {
      if ('caches' in window) {
        const keys = await window.caches.keys();
        await Promise.all(keys.map((key) => window.caches.delete(key)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister().catch(() => false)));
      }
      setCacheMsg({ ok: true, text: '캐시를 비웠어요. 새로고침합니다…' });
      window.location.reload();
    } catch (err) {
      setCacheBusy(false);
      setCacheMsg({ ok: false, text: err instanceof Error ? err.message : '캐시를 지우지 못했어요.' });
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
          font,
        })
        .then(() => refreshProfile())
        .then(() => {
          setSavedFlash('저장했습니다');
          window.setTimeout(() => setSavedFlash(''), 1500);
        })
        .catch(() => undefined);
    }, 250);
  };

  /** v0.6.4: 글꼴은 고르는 즉시 화면에 적용하고 서버에도 저장한다(새로고침·다른 기기에서도 유지). */
  const pickFont = (next: FontId) => {
    setFont(next);
    applyFont(next);
    setSavedFlash('글꼴을 바꿨어요');
    if (savedFlashTimer.current) window.clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = window.setTimeout(() => setSavedFlash(''), 1800);
    void api
      .put('/api/settings/profile', {
        nickname,
        agentName,
        character,
        tone,
        persona,
        personaCustom,
        theme,
        accentMode,
        accentColor,
        font: next,
      })
      .then(() => refreshProfile())
      .catch(() => undefined);
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
      font,
    });
    applyTheme({ theme, accentMode, accentColor, character });
    applyFont(font);
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
          font,
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

  /** v0.6.3: 작업 유형별 모델 선택(누르는 즉시 저장) */
  const pickRouting = async (kind: keyof RoutingSettings, choice: RouteChoice) => {
    setRouting((prev) => ({ ...prev, [kind]: choice }));
    setRoutingBusy(true);
    try {
      const res = await api.post<{ routing: RoutingSettings }>('/api/settings/routing', { [kind]: choice });
      setRouting(res.routing);
    } catch {
      await load();
    } finally {
      setRoutingBusy(false);
    }
  };

  /** v0.6.3: 메일 계정 연결(IMAP·SMTP 연결 시험 후 저장) */
  const connectMail = async () => {
    setMailBusy(true);
    setMailMsg(null);
    try {
      const res = await api.post<{ accounts: MailAccount[] }>('/api/mail/accounts', {
        provider: mailForm.provider,
        email: mailForm.email.trim(),
        secret: mailForm.secret,
        senderName: mailForm.senderName.trim(),
      });
      setMailAccounts(res.accounts || []);
      setMailForm({ provider: mailForm.provider, email: '', secret: '', senderName: '' });
      setMailMsg({ ok: true, text: '메일 계정을 연결했어요. 이제 AI에게 메일을 맡길 수 있어요.' });
    } catch (err) {
      setMailMsg({ ok: false, text: err instanceof Error ? err.message : '메일 계정을 연결하지 못했습니다.' });
    } finally {
      setMailBusy(false);
    }
  };

  const testMail = async () => {
    setMailBusy(true);
    setMailMsg(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>('/api/mail/test', {
        provider: mailForm.provider,
        email: mailForm.email.trim(),
        secret: mailForm.secret,
        senderName: mailForm.senderName.trim(),
      });
      setMailMsg({ ok: Boolean(res.ok), text: res.message });
    } catch (err) {
      setMailMsg({ ok: false, text: err instanceof Error ? err.message : '연결 시험에 실패했습니다.' });
    } finally {
      setMailBusy(false);
    }
  };

  const removeMail = async (id: string) => {
    if (!window.confirm('이 메일 계정 연결을 해제할까요?')) return;
    setMailBusy(true);
    try {
      const res = await api.del<{ accounts: MailAccount[] }>(`/api/mail/accounts/${id}`);
      setMailAccounts(res.accounts || []);
    } finally {
      setMailBusy(false);
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
  /** v0.6.3: EXAONE 무료 키 만료까지 남은 날(D-3부터 빨갛게) */
  const exaoneExpiry = data?.exaone?.expiry || data?.providers.find((p) => p.id === 'exaone')?.keyExpiry || null;
  const routingChoices: { id: RouteChoice; label: string }[] = [
    { id: 'inherit', label: '채팅 모델 그대로' },
    ...(data?.providers || []).map((p) => ({ id: p.id as RouteChoice, label: p.label })),
  ];
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

  /** v0.6.4: 프로바이더 줄을 눌렀을 때 상세(모델·키)를 연다. */
  const toggleProvider = (id: ProviderId) => {
    setOpenProvider((prev) => (prev === id ? null : id));
    setProvider(id);
    const target = data?.providers.find((p) => p.id === id);
    setModel(id === data?.active.provider ? data?.active.model || '' : target?.defaultModel || '');
    setApiKey('');
    setKeyMsg(null);
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
    <div className="flex h-full min-h-0 flex-col">
      {/* v0.6.6: 제목·카테고리 바는 스크롤 컨테이너 **밖에 고정** — 콘텐츠가 위로 삐져나오는 일이 원천적으로 없다 */}
      <div className="shrink-0 px-4 pb-0.5 pt-5 lg:px-10 lg:pt-9">
        <div className="mx-auto w-full max-w-[720px]">
        <header className="flex items-center gap-2">
          <BackButton />
          <div>
            <h1 className="text-[26px] font-bold tracking-[-0.02em] lg:text-[34px]">설정</h1>
            <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">AI 이름·캐릭터·말투와 모델 연결을 관리해요</p>
          </div>
          <MascotFace character={character} size={56} className="ml-auto lg:hidden" />
        </header>

        {/* v0.6.4: 카테고리 탭 — 한 번에 한 묶음만 보여 줘 긴 스크롤을 줄인다 */}
        {/* v0.6.6: sticky를 걷어내고 스크롤 영역 밖 고정 헤더로 옮겼다. */}
        <div className="mt-4">
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto rounded-2xl bg-[#F6F4FB] p-1 dark:bg-[#232030]">
            {([
              { id: 'look' as const, label: '캐릭터·테마', icon: Palette },
              { id: 'ai' as const, label: 'AI·자동선택', icon: Sparkles },
              { id: 'mail' as const, label: '이메일·알림', icon: Mail },
              { id: 'system' as const, label: '백업·시스템', icon: ShieldCheck },
            ]).map((item) => {
              const active = tab === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 py-2 text-[12.5px] font-semibold transition ${
                    active
                      ? 'bg-white text-[#7C63F6] shadow-[0_2px_8px_rgba(90,80,160,0.10)] dark:bg-[#1B1923]'
                      : 'text-[#8A8A9A] hover:text-[#5B5866]'
                  }`}
                  aria-pressed={active}
                >
                  <Icon size={14} />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
        </div>
      </div>

      {/* v0.6.6: 헤더 아래 콘텐츠만 스크롤된다 */}
      <div ref={panelRef} className="pa-scroll mt-3 min-h-0 flex-1 overflow-y-auto px-4 pb-8 lg:px-10">
        <div className="mx-auto w-full max-w-[720px]">

        {tab === 'look' ? (
          <>
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

          {/* v0.6.4: 글꼴 선택 (기본 · 프리텐다드 · 카카오 큰글씨) */}
          <div className="mt-5 border-t border-[#F1EFF8] pt-4 dark:border-[#2A2636]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#5B5866]">
                <Type size={13} /> 글꼴
              </span>
              <span className="text-[11.5px] text-[#B4B1C2]">누르면 바로 앱 전체에 적용돼요</span>
            </div>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
              {FONT_OPTIONS.map((opt) => {
                const active = font === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => pickFont(opt.id)}
                    className={`rounded-2xl border-[1.5px] px-3 py-2.5 text-left transition ${
                      active ? 'border-[#C9B8FF] bg-[#F8F5FF] dark:bg-[#241F33]' : 'border-[#EFEDF6] bg-white hover:bg-[#FBFAFF] dark:bg-transparent'
                    }`}
                    aria-pressed={active}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className={`text-[12.5px] font-semibold ${active ? 'text-[#7C63F6]' : 'text-[#4B4856]'}`}>
                        {opt.label}
                      </span>
                      {active ? (
                        <span className="ml-auto flex h-4 w-4 items-center justify-center rounded-full bg-[#8B72F8] text-white">
                          <Check size={10} strokeWidth={4} />
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`mt-1.5 block truncate text-[15px] ${active ? 'text-[#3A2F7A]' : 'text-[#5B5866]'}`}
                      style={{ fontFamily: opt.family }}
                    >
                      {opt.sample}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-[#B4B1C2]">{opt.hint}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11.5px] leading-[1.6] text-[#B4B1C2]">
              카카오 큰글씨는 앱에 함께 들어 있어 인터넷이 느려도 바로 보여요. 프리텐다드는 처음 고를 때만 내려받습니다.
            </p>
          </div>
        </section>

          </>
        ) : null}

        {tab === 'ai' ? (
          <>
        {/* AI provider — v0.6.4: 연결된 AI는 1줄 요약으로 접고, 누르면 상세를 펼친다 */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-bold text-[#1F1D2B]">AI 모델</h2>
              <p className="mt-1 text-[13px] text-pomong-sub">
                {data?.active ? `지금은 ${selected?.label || data.active.provider} · ${data.active.model} 로 답해요` : '아직 연결된 AI가 없습니다.'}
              </p>
            </div>
            {selected?.connected ? (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#EAFBF1] px-3 py-1.5 text-[12px] font-semibold text-[#12B886]">
                <Check size={12} strokeWidth={3} /> 연결됨
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-[#FFF6E7] px-3 py-1.5 text-[12px] font-semibold text-[#E49B18]">키 필요</span>
            )}
          </div>

          <ul className="mt-4 space-y-2">
            {(data?.providers || []).map((p) => {
              const opened = openProvider === p.id;
              const isActive = data?.active.provider === p.id;
              return (
                <li
                  key={p.id}
                  className={`overflow-hidden rounded-2xl border-[1.5px] transition ${
                    opened ? 'border-[#D6C9FF] bg-[#FBFAFF] dark:bg-[#1E1B29]' : 'border-[#EFEDF6] bg-white dark:bg-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => toggleProvider(p.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-expanded={opened}
                      aria-label={`${p.label} 설정 열기`}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${p.connected ? 'bg-[#22C55E]' : 'bg-[#DAD6E6]'}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className={`text-[14px] font-semibold ${isActive ? 'text-[#7C63F6]' : 'text-[#3B3947]'}`}>{p.label}</span>
                          {p.id === 'exaone' ? (
                            <span className="rounded-md bg-[#EAFBF1] px-1.5 py-0.5 text-[10px] font-bold text-[#12B886]">무료</span>
                          ) : null}
                          {isActive ? (
                            <span className="rounded-md bg-[#F3EEFF] px-1.5 py-0.5 text-[10px] font-semibold text-[#7C63F6]">사용 중</span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-[11.5px] text-[#8A8A9A]">
                          {p.connected
                            ? `연결됨 · ${isActive ? data?.active.model || p.defaultModel : p.defaultModel}`
                            : '키를 연결하면 바로 쓸 수 있어요'}
                        </span>
                      </span>
                    </button>
                    {p.connected && !isActive ? (
                      <button
                        type="button"
                        className="shrink-0 rounded-full bg-[#F3EEFF] px-2.5 py-1 text-[11.5px] font-semibold text-[#7C63F6] transition active:scale-95"
                        onClick={() => void useModel(p.id, p.defaultModel)}
                      >
                        전환
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => toggleProvider(p.id)}
                      className="flex shrink-0 items-center gap-0.5 rounded-full border border-[#EFEDF6] px-2.5 py-1 text-[11.5px] font-semibold text-[#6B677A] transition active:scale-95"
                      aria-label={opened ? `${p.label} 접기` : `${p.label} 수정`}
                    >
                      {p.connected ? '수정' : '연결'}
                      <ChevronDown size={12} className={`transition ${opened ? 'rotate-180' : ''}`} />
                    </button>
                  </div>

                  {opened ? (
                    <div className="space-y-3 border-t border-[#EFE9FF] px-3 py-3 dark:border-[#2A2636]">
                      <label className="block">
                        <span className="mb-1.5 block text-[12.5px] font-semibold text-[#5B5866]">모델</span>
                        <select className="pa-input" value={model} onChange={(e) => setModel(e.target.value)}>
                          {(p.models || []).map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                          {p.models && !p.models.includes(model) && model ? <option value={model}>{model}</option> : null}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-[12.5px] font-semibold text-[#5B5866]">API 키</span>
                        <input
                          className="pa-input font-mono text-[13px]"
                          type="password"
                          placeholder={p.connected ? '새 키로 교체하려면 입력' : 'API 키 입력'}
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>

                      {p.id === 'exaone' ? (
                        <div className="rounded-2xl px-3.5 py-3 ring-1" style={{ background: 'var(--pa-surface-3)', borderColor: 'var(--pa-line)' }}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[13px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                              추론 강도
                            </span>
                            <span className="text-[11px]" style={{ color: 'var(--pa-mute)' }}>
                              높을수록 정확하지만 느려요
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2">
                            {effortChoices.map((choice) => (
                              <button
                                key={choice.id}
                                type="button"
                                onClick={() => void pickEffort(choice.id)}
                                className="rounded-xl border-[1.5px] px-2 py-2 text-center transition active:scale-[0.98]"
                                style={
                                  effort === choice.id
                                    ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-line)', color: 'var(--accent-ink)' }
                                    : { background: 'var(--pa-surface)', borderColor: 'var(--pa-line)', color: 'var(--pa-ink)' }
                                }
                                aria-pressed={effort === choice.id}
                              >
                                <span className="block text-[13px] font-bold">{choice.label}</span>
                                <span className="block text-[10.5px]" style={{ color: 'var(--pa-mute)' }}>
                                  {choice.hint}
                                </span>
                              </button>
                            ))}
                          </div>
                          <p className="mt-2 text-[11px] leading-[1.55]" style={{ color: 'var(--pa-mute)' }}>
                            K-EXAONE 2.5는 답하기 전에 항상 추론해요. 사진은 볼 수 없는 텍스트 모델이고, 무료 키는 30일마다
                            재발급이 필요해요.
                          </p>
                          {exaoneConnected && exaoneExpiry?.label ? (
                            <p
                              className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                                exaoneExpiry.expired
                                  ? 'bg-[#FFF1F1] text-[#E5484D]'
                                  : exaoneExpiry.warn
                                    ? 'bg-[#FFF6E7] text-[#C77A12]'
                                    : 'bg-[#EAFBF1] text-[#12B886]'
                              }`}
                            >
                              <Clock size={11} /> 무료 키 {exaoneExpiry.label}
                              {exaoneExpiry.daysLeft !== null && !exaoneExpiry.expired ? ` · ${exaoneExpiry.daysLeft}일 남음` : ''}
                              {exaoneExpiry.warn ? ' · docs.exaone.ai에서 재발급' : ''}
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-2">
                        <button className="pa-btn-primary px-4 py-2.5" onClick={saveKey} disabled={keyBusy || !apiKey.trim()}>
                          {keyBusy ? '확인 중…' : '키 연결'}
                        </button>
                        <button
                          className="pa-btn-ghost px-4 py-2.5"
                          onClick={() => void useModel(p.id, model)}
                          disabled={!p.connected}
                          title={p.connected ? '이 모델로 대화하기' : '먼저 키를 연결해 주세요'}
                        >
                          이 모델 사용
                        </button>
                        <a
                          href={p.console}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 text-[12.5px] text-[#8B72F6] hover:underline"
                        >
                          키 발급 페이지 <ExternalLink size={12} />
                        </a>
                      </div>
                      {openProvider === p.id && keyMsg ? (
                        <p
                          className={`rounded-xl px-3 py-2.5 text-[13px] font-medium ${
                            keyMsg.ok ? 'bg-[#EAFBF1] text-[#12B886]' : 'bg-[#FFF1F1] text-[#E5484D]'
                          }`}
                        >
                          {keyMsg.text}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 rounded-xl bg-[#FAF8FF] px-3 py-2 text-[11.5px] leading-[1.55] text-[#7C6FB0] dark:bg-[#1E1B29]">
            연결한 AI는 한 줄로 접혀 있어요. 「수정」을 누르면 모델·키를 바꿀 수 있고, 키는 서버에서 암호화해 보관합니다.
          </p>
        </section>

        {/* v0.6.3: 작업별 모델 자동 선택 */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-bold text-[#1F1D2B]">작업별 모델 자동 선택</h2>
              <p className="mt-1 text-[13px] text-pomong-sub">
                지정한 작업이 감지되면 그 AI가 답해요. 두면 지금 채팅 모델을 그대로 써요.
              </p>
            </div>
          </div>
          <ul className="mt-3 space-y-2">
            {(data?.routingOptions || [
              { kind: 'chat' as const, label: '일반 대화', hint: '짧은 질문·잡담' },
              { kind: 'browser' as const, label: '브라우저 · 로그인 · 작업', hint: '사이트 열기, 로그인, 클릭·입력' },
              { kind: 'vision' as const, label: '사진 · 파일 분석', hint: '사진을 보고 답하기, 파일 읽기' },
              { kind: 'writing' as const, label: '요약 · 글쓰기 · 자동화', hint: '요약, 초안, 예약 실행' },
            ]).map((opt) => (
              <li
                key={opt.kind}
                className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-[#FAF9FD] px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-[#3B3947]">{opt.label}</p>
                  <p className="text-[11px] text-pomong-sub">{opt.hint}</p>
                </div>
                <select
                  className="pa-input h-9 w-[168px] py-1 text-[12.5px]"
                  value={routing[opt.kind]}
                  onChange={(e) => void pickRouting(opt.kind, e.target.value as RouteChoice)}
                  disabled={routingBusy}
                  aria-label={`${opt.label} 모델`}
                >
                  {routingChoices.map((choice) => {
                    const connected =
                      choice.id === 'inherit' || Boolean(data?.providers.find((p) => p.id === choice.id)?.connected);
                    return (
                      <option key={choice.id} value={choice.id} disabled={!connected}>
                        {choice.label}
                        {choice.id !== 'inherit' && !connected ? ' (미연결)' : ''}
                      </option>
                    );
                  })}
                </select>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 rounded-xl bg-[#FAF8FF] px-3 py-2 text-[11.5px] leading-[1.55] text-[#7C6FB0]">
            사진을 붙였는데 지금 모델이 사진을 못 보면(EXAONE), 사진을 볼 수 있는 AI로 자동으로 넘겨요.
          </p>
        </section>

          </>
        ) : null}

        {tab === 'mail' ? (
          <>
        {/* v0.6.3: 이메일(IMAP/SMTP) */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-1.5 text-[16px] font-bold text-[#1F1D2B]">
                <Mail size={17} className="text-[#7C63F6]" /> 이메일
              </h2>
              <p className="mt-1 text-[13px] text-pomong-sub">
                네이버·지메일 앱 비밀번호로 메일함을 읽고, 확인 카드를 거쳐 보내요.
              </p>
            </div>
            {mailAccounts.length ? (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#EAFBF1] px-3 py-1.5 text-[12px] font-semibold text-[#12B886]">
                <Check size={12} strokeWidth={3} /> {mailAccounts.length}개 연결됨
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-[#FFF6E7] px-3 py-1.5 text-[12px] font-semibold text-[#E49B18]">
                미연결
              </span>
            )}
          </div>

          {mailAccounts.length ? (
            <ul className="mt-3 space-y-1.5">
              {mailAccounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center justify-between gap-2 rounded-2xl bg-[#FAF9FD] px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-[#3B3947]">{account.email}</p>
                    <p className="truncate text-[11px] text-pomong-sub">
                      {account.label} · {account.imapHost} · {account.lastTestAt ? '연결 확인됨' : '확인 전'}
                    </p>
                  </div>
                  <button
                    className="shrink-0 rounded-xl p-1.5 text-[#D9D5E4] transition hover:text-[#E5484D]"
                    onClick={() => void removeMail(account.id)}
                    aria-label="메일 연결 해제"
                    disabled={mailBusy}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">메일 서비스</span>
              <select
                className="pa-input"
                value={mailForm.provider}
                onChange={(e) => setMailForm((prev) => ({ ...prev, provider: e.target.value }))}
              >
                {(mailPresets.length ? mailPresets : [{ id: 'naver', label: '네이버 메일' }, { id: 'gmail', label: 'Gmail' }]).map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">이메일 주소</span>
              <input
                className="pa-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@naver.com"
                value={mailForm.email}
                onChange={(e) => setMailForm((prev) => ({ ...prev, email: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">앱 비밀번호</span>
              <input
                className="pa-input font-mono text-[13px]"
                type="password"
                autoComplete="new-password"
                placeholder="앱 비밀번호(공백 없이)"
                value={mailForm.secret}
                onChange={(e) => setMailForm((prev) => ({ ...prev, secret: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">보내는 사람 이름</span>
              <input
                className="pa-input"
                placeholder="홍길동"
                value={mailForm.senderName}
                onChange={(e) => setMailForm((prev) => ({ ...prev, senderName: e.target.value }))}
              />
            </label>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              className="pa-btn-primary px-4 py-2.5"
              onClick={() => void connectMail()}
              disabled={mailBusy || !mailForm.email.trim() || !mailForm.secret.trim()}
            >
              {mailBusy ? '확인 중…' : '계정 연결'}
            </button>
            <button
              className="pa-btn-ghost px-4 py-2.5"
              onClick={() => void testMail()}
              disabled={mailBusy || !mailForm.email.trim() || !mailForm.secret.trim()}
            >
              연결 시험
            </button>
          </div>
          {mailMsg ? (
            <p
              className={`mt-2.5 whitespace-pre-wrap rounded-xl px-3 py-2.5 text-[12.5px] font-medium ${
                mailMsg.ok ? 'bg-[#EAFBF1] text-[#12B886]' : 'bg-[#FFF1F1] text-[#E5484D]'
              }`}
            >
              {mailMsg.text}
            </p>
          ) : null}
          <p className="mt-2.5 text-[11.5px] leading-[1.6] text-[#8A8A9A]">
            {mailPresets.find((p) => p.id === mailForm.provider)?.help ||
              '네이버는 환경설정 > POP3/IMAP에서 IMAP/SMTP를 켜고, Gmail은 2단계 인증 뒤 앱 비밀번호를 발급해 주세요.'}
            <br />
            앱 비밀번호는 서버에서 암호화해 보관하고, 발송은 채팅의 확인 카드에서 「보내기」를 눌러야 이뤄져요.
          </p>
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

          </>
        ) : null}

        {tab === 'system' ? (
          <>
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

        {/* v0.6.13: 계정 비밀번호 변경 */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="flex items-center gap-1.5 text-[16px] font-bold text-[#1F1D2B]">
            <KeyRound size={16} className="text-[#7C63F6]" /> 계정 비밀번호 변경
          </h2>
          <p className="mt-2 text-[12.5px] leading-[1.6] text-[#8A8A9A]">
            이 앱에 로그인할 때 쓰는 비밀번호예요. 바꾸면 지금 보고 있는 이 기기는 그대로 로그인되어 있고,
            다음 로그인부터 새 비밀번호를 쓰면 돼요.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">현재 비밀번호</span>
              <input
                type="password"
                autoComplete="current-password"
                className="pa-input"
                value={pwForm.current}
                placeholder="••••••••"
                onChange={(e) => setPwForm((prev) => ({ ...prev, current: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">새 비밀번호</span>
              <input
                type="password"
                autoComplete="new-password"
                className="pa-input"
                value={pwForm.next}
                placeholder="8자 이상"
                onChange={(e) => setPwForm((prev) => ({ ...prev, next: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-[#5B5866]">새 비밀번호 확인</span>
              <input
                type="password"
                autoComplete="new-password"
                className="pa-input"
                value={pwForm.confirm}
                placeholder="한 번 더 입력"
                onChange={(e) => setPwForm((prev) => ({ ...prev, confirm: e.target.value }))}
              />
            </label>
          </div>
          <button
            type="button"
            className="pa-btn-primary mt-3 px-4 py-2.5 text-[13px]"
            onClick={() => void changePassword()}
            disabled={pwBusy || !pwForm.current || !pwForm.next || !pwForm.confirm}
          >
            <KeyRound size={15} /> {pwBusy ? '바꾸는 중…' : '비밀번호 변경'}
          </button>
          {pwMsg ? (
            <p
              className={`mt-2.5 whitespace-pre-wrap rounded-xl px-3 py-2.5 text-[12.5px] font-medium ${
                pwMsg.ok ? 'bg-[#EAFBF1] text-[#12B886]' : 'bg-[#FFF1F1] text-[#E5484D]'
              }`}
            >
              {pwMsg.text}
            </p>
          ) : null}
        </section>

        {/* v0.6.13: PWA 캐시 초기화 및 새로고침 */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="flex items-center gap-1.5 text-[16px] font-bold text-[#1F1D2B]">
            <RefreshCw size={16} className="text-[#7C63F6]" /> 앱 캐시 초기화
          </h2>
          <p className="mt-2 text-[12.5px] leading-[1.6] text-[#8A8A9A]">
            새 버전을 배포해도 아이폰 홈 화면 앱(PWA)이 예전 화면을 계속 보여 줄 때 눌러 주세요.
            저장된 캐시와 서비스워커 등록을 지우고 새로고침해서, 지금 서버에 있는 최신 버전을 바로 받아옵니다.
            로그인 상태·대화·금고는 지워지지 않아요.
          </p>
          <button
            type="button"
            className="pa-btn-ghost mt-3 inline-flex items-center gap-1.5 px-3.5 py-2.5 text-[13px]"
            onClick={() => void resetAppCache()}
            disabled={cacheBusy}
          >
            <RefreshCw size={15} /> {cacheBusy ? '지우는 중…' : '앱 캐시 초기화 및 새로고침'}
          </button>
          {cacheMsg ? (
            <p
              className={`mt-2.5 whitespace-pre-wrap rounded-xl px-3 py-2.5 text-[12.5px] font-medium ${
                cacheMsg.ok ? 'bg-[#F7F5FF] text-[#5B4BC4]' : 'bg-[#FFF1F1] text-[#E5484D]'
              }`}
            >
              {cacheMsg.text}
            </p>
          ) : null}
        </section>

        {/* security / about */}
        <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
          <h2 className="text-[16px] font-bold text-[#1F1D2B]">정보</h2>
          <ul className="mt-3 divide-y divide-[#F6F4FB] text-[13.5px]">
            <li className="flex items-center justify-between py-3">
              <span className="text-pomong-sub">버전</span>
              <span className="font-semibold text-[#3B3947]">v{data?.version || '0.6.16'}</span>
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
          </>
        ) : null}

        <p className="mt-6 flex items-center justify-center gap-1.5 text-[12px] text-[#B4B1C2]">
          <Sparkles size={12} /> Pomong Agent v{data?.version || '0.6.16'} · Pomong Labs
        </p>
        </div>
      </div>
    </div>
  );
}
