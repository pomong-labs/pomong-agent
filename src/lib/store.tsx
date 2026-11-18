import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type ChatMessage, type LoginRequest, type ModelsResponse, type Profile, type TaskRun } from './api';

export type AgentState = 'idle' | 'thinking' | 'working' | 'responding' | 'error';

export interface AgentStatus {
  state: AgentState;
  label: string;
  detail: string;
  startedAt: string | null;
  lastError: string | null;
}

interface SettingsShape {
  profile: Profile;
  active: { provider: string; model: string };
  providers: ModelsResponse['providers'];
}

interface AppStoreValue {
  profile: Profile;
  models: ModelsResponse | null;
  refreshModels: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshAll: () => Promise<void>;
  selectModel: (provider: string, model?: string) => Promise<{ ok: boolean; message?: string; needsKey?: boolean }>;
  messages: ChatMessage[];
  messagesLoaded: boolean;
  /** 이번 턴의 실시간 작업 카드(도구가 도는 동안) */
  liveTask: TaskRun | null;
  /** 지난 대화에 붙은 작업 카드 */
  taskRuns: TaskRun[];
  sending: boolean;
  error: string;
  aiReady: boolean;
  /** 채팅에 떠 있는 로그인 카드 (금고에 계정이 없을 때) */
  loginRequests: LoginRequest[];
  /** 금고가 잠겨 있으면 카드에서 PIN을 받아야 한다 */
  vault: { configured: boolean; unlocked: boolean };
  submitLoginCard: (
    id: string,
    input: { username: string; password: string; masterPin?: string }
  ) => Promise<{ ok: boolean; message?: string }>;
  dismissLoginCard: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  clearChat: () => Promise<void>;
  draft: string;
  setDraft: (value: string) => void;
  agent: AgentStatus;
  visibleState: AgentState;
  keyboardOpen: boolean;
}

const DEFAULT_PROFILE: Profile = { nickname: '', theme: 'light', language: 'ko', agentName: 'Pomong', character: 'pimong', tone: 'polite' };

const AppStore = createContext<AppStoreValue | null>(null);

export function useAppStore(): AppStoreValue {
  const ctx = useContext(AppStore);
  if (!ctx) throw new Error('useAppStore must be used inside <AppStoreProvider>');
  return ctx;
}

/**
 * iOS Safari/PWA 키보드 대응.
 *
 * 키보드가 올라오면 iOS는 ① 뷰포트 높이를 줄이고 ② 스크롤한 만큼 visualViewport.offsetTop을
 * 올린다. position: fixed 로 붙여 둔 앱 셸은 ②를 따라가지 않아 화면 위쪽에 흰 여백이 남고,
 * 입력창은 화면 밖으로 밀려난다. 그래서 보이는 영역 높이(--app-height)와 함께 offsetTop을
 * --app-offset 으로 넘기고, 셸을 그만큼 translateY 해 항상 키보드 위에 붙인다.
 */
function useVisualViewport(): boolean {
  const [kbOpen, setKbOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    let frame = 0;
    // 키보드가 없는 상태의 "가장 큰" 가시 높이. iOS는 설정에 따라 키보드가 열릴 때
    // innerHeight(레이아웃 뷰포트)까지 같이 줄어들기 때문에(interactive-widget=resizes-content),
    // "innerHeight - visualViewport.height" 만 비교하면 항상 0이 되어 kb-open이 켜지지 않는다.
    // 그래서 지금 높이가 아니라 "한 번이라도 본 가장 큰 높이"를 기준으로 줄어든 폭을 잰다.
    let baseline = 0;

    const isEditable = (el: Element | null): boolean =>
      !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (el as HTMLElement).isContentEditable === true);
    const isMobileWidth = () => window.matchMedia('(max-width: 1023px)').matches;

    const measureBaseline = () => {
      const tallest = Math.max(window.innerHeight, vv?.height ?? 0, document.documentElement.clientHeight);
      if (tallest > baseline) baseline = tallest;
    };

    const apply = () => {
      const height = vv?.height ?? window.innerHeight;
      const offsetTop = vv?.offsetTop ?? 0;
      const offsetLeft = vv?.offsetLeft ?? 0;
      const shrink = baseline - height;
      const typing = isEditable(document.activeElement) && isMobileWidth();
      // ① 입력창에 포커스가 있으면(모바일 폭) 확실히 키보드 상태로 본다.
      // ② 포커스 이벤트가 늦거나 programmatic focus일 때를 위해 뷰포트가 120px 이상 줄어도 키보드 상태.
      // ③ 키보드가 화면을 밀어 올린 경우(offsetTop)도 포함.
      const open = typing || shrink > 120 || (offsetTop > 2 && shrink > 8);
      const root = document.documentElement;
      root.style.setProperty('--app-height', `${Math.round(height)}px`);
      root.style.setProperty('--app-offset', `${Math.round(offsetTop)}px`);
      root.style.setProperty('--app-offset-x', `${Math.round(offsetLeft)}px`);
      root.classList.toggle('kb-open', open);
      // 키보드가 닫혀 있을 때만 기준 높이를 갱신한다(키보드 높이를 기준으로 굳지 않게).
      if (!open) measureBaseline();
      setKbOpen(open);
    };
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    // 페이지가 스크롤된 상태로 키보드가 올라오면 fixed 셸이 같이 밀려 올라간다 → 항상 맨 위에 둔다.
    const resetScroll = () => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
      if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0;
    };
    const onFocusOrScroll = () => {
      resetScroll();
      onResize();
    };
    measureBaseline();
    apply();
    vv?.addEventListener('resize', onResize);
    vv?.addEventListener('scroll', onFocusOrScroll);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', resetScroll, { passive: true });
    const onOrientation = () => {
      // 화면 방향이 바뀌면 기준 높이를 새로 잡는다(가로↔세로 높이가 다르다).
      baseline = 0;
      onResize();
    };
    window.addEventListener('orientationchange', onOrientation);
    document.addEventListener('focusin', onFocusOrScroll);
    document.addEventListener('focusout', onFocusOrScroll);
    return () => {
      cancelAnimationFrame(frame);
      vv?.removeEventListener('resize', onResize);
      vv?.removeEventListener('scroll', onFocusOrScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', resetScroll);
      window.removeEventListener('orientationchange', onOrientation);
      document.removeEventListener('focusin', onFocusOrScroll);
      document.removeEventListener('focusout', onFocusOrScroll);
    };
  }, []);
  return kbOpen;
}

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const keyboardOpen = useVisualViewport();
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([]);
  const [liveTask, setLiveTask] = useState<TaskRun | null>(null);
  const [loginRequests, setLoginRequests] = useState<LoginRequest[]>([]);
  const [vaultState, setVaultState] = useState<{ configured: boolean; unlocked: boolean }>({ configured: false, unlocked: false });
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [aiReady, setAiReady] = useState(true);
  const [draft, setDraft] = useState('');
  const [agent, setAgent] = useState<AgentStatus>({ state: 'idle', label: '대기 중', detail: '', startedAt: null, lastError: null });
  const sendingRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const refreshModels = useCallback(async () => {
    try {
      const r = await api.get<ModelsResponse>('/api/models');
      setModels(r);
      setAiReady(r.providers.some((p) => p.connected && p.id === r.active.provider));
    } catch {
      /* ignore */
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const r = await api.get<{ profile: Profile } & SettingsShape>('/api/settings');
      setProfile(r.profile);
    } catch {
      /* ignore */
    }
  }, []);

  // 첫 로드: 프로필 · 모델 목록 · 지난 대화
  useEffect(() => {
    api
      .get<SettingsShape>('/api/settings')
      .then((r) => {
        setProfile(r.profile);
      })
      .catch(() => undefined);
    refreshModels();
    api
      .get<{ messages: ChatMessage[]; taskRuns?: TaskRun[] }>('/api/chat/messages')
      .then((r) => {
        setMessages(r.messages);
        setTaskRuns(r.taskRuns || []);
      })
      .catch(() => undefined)
      .finally(() => setMessagesLoaded(true));
    api
      .get<{ aiConfigured: boolean }>('/api/auth/me')
      .then((r) => setAiReady(r.aiConfigured))
      .catch(() => undefined);
  }, [refreshModels]);

  // AI 상태는 서버가 들고 있으므로 탭을 옮겨도(다른 기기에서도) 그대로 보인다.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const r = await api.get<AgentStatus & { ok: true }>('/api/agent/status');
        if (!alive) return;
        setAgent({ state: r.state, label: r.label, detail: r.detail, startedAt: r.startedAt, lastError: r.lastError });
      } catch {
        /* ignore */
      }
    };
    load();
    const id = window.setInterval(load, sendingRef.current ? 1500 : 6000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [sending]);

  const loadMessages = useCallback(async () => {
    try {
      const r = await api.get<{ messages: ChatMessage[]; taskRuns?: TaskRun[] }>('/api/chat/messages');
      setMessages(r.messages);
      setTaskRuns(r.taskRuns || []);
    } catch {
      /* not signed in yet */
    } finally {
      setMessagesLoaded(true);
    }
  }, []);

  /** 채팅에 떠 있던 로그인 카드(대기·최근 저장)와 금고 잠금 상태 */
  const loadLoginCards = useCallback(async () => {
    try {
      const r = await api.get<{ requests: LoginRequest[]; configured: boolean; unlocked: boolean }>('/api/vault/login-cards');
      setLoginRequests(r.requests || []);
      setVaultState({ configured: r.configured, unlocked: r.unlocked });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadLoginCards();
  }, [loadLoginCards]);

  /**
   * 서버 이벤트(SSE): 중간 안내 말풍선·최종 답변·작업 카드를 실시간으로 받는다.
   * POST 응답을 기다리지 않고도 "잠시만요" 말풍선과 진행 단계가 먼저 뜨게 하는 통로다.
   */
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    try {
      source = new EventSource('/api/events');
    } catch {
      return;
    }
    const onMessage = (ev: MessageEvent) => {
      try {
        const event = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> };
        if (event.type === 'task') {
          const run = event.data?.run as TaskRun | undefined;
          if (run) setLiveTask(run);
          return;
        }
        if (event.type === 'chat_message' || event.type === 'chat') {
          const message = event.data?.message as ChatMessage | undefined;
          if (!message || typeof message.id !== 'number') return;
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message].sort((a, b) => a.id - b.id)));
          return;
        }
        if (event.type === 'login_request') {
          const request = event.data?.request as LoginRequest | undefined;
          if (!request || !request.id) return;
          setLoginRequests((prev) => {
            const next = prev.some((r) => r.id === request.id)
              ? prev.map((r) => (r.id === request.id ? request : r))
              : [...prev, request];
            return next.filter((r) => r.status !== 'cancelled').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          });
        }
      } catch {
        /* ignore */
      }
    };
    source.addEventListener('message', onMessage as EventListener);
    source.onerror = () => {
      /* 브라우저가 자동 재연결한다 */
    };
    return () => {
      source?.removeEventListener('message', onMessage as EventListener);
      source?.close();
    };
  }, []);

  /** 앱을 보고 있는지 서버에 알려 준다(보고 있으면 푸시를 보내지 않는다). */
  useEffect(() => {
    const clientId = (() => {
      try {
        const saved = sessionStorage.getItem('pomong.pushClient');
        if (saved) return saved;
        const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('pomong.pushClient', id);
        return id;
      } catch {
        return 'default';
      }
    })();
    const ping = () => {
      void api.post('/api/push/presence', { clientId, visible: document.visibilityState === 'visible' }).catch(() => undefined);
    };
    ping();
    const timer = window.setInterval(ping, 25_000);
    document.addEventListener('visibilitychange', ping);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', ping);
    };
  }, []);

  /** 로그인/설정 완료 직후 프로필·모델·대화를 다시 불러온다. */
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshProfile(), refreshModels(), loadMessages(), loadLoginCards()]);
    try {
      const me = await api.get<{ aiConfigured: boolean }>('/api/auth/me');
      setAiReady(me.aiConfigured);
    } catch {
      /* ignore */
    }
  }, [refreshProfile, refreshModels, loadMessages]);

  const selectModel = useCallback(
    async (provider: string, model?: string) => {
      try {
        const r = await api.post<{ active: { provider: string; model: string } }>('/api/models/select', { provider, model });
        await refreshModels();
        setError('');
        return { ok: true, message: `${r.active.model}` };
      } catch (err) {
        const needsKey = err instanceof ApiError && err.code === 'provider_not_connected';
        return { ok: false, message: err instanceof Error ? err.message : '모델을 바꾸지 못했습니다.', needsKey };
      }
    },
    [refreshModels]
  );

  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError('');
    setDraft('');
    const optimistic: ChatMessage = {
      id: -Date.now(),
      role: 'user',
      content,
      meta: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await api.post<{ message: ChatMessage; userMessage?: ChatMessage; taskRun?: TaskRun | null }>('/api/chat/messages', { message: content });
      // 서버가 저장한 내 메시지(userMessage)로 임시 메시지를 바꾸고, AI 답변을 뒤에 붙인다.
      // 예전에는 응답에 AI 답변만 담겨 와서 내 메시지가 화면에서 사라졌다.
      const mine: ChatMessage = res.userMessage ?? { ...optimistic, id: res.message.id - 1 };
      setMessages((prev) => {
        const next = prev.filter((m) => m.id !== optimistic.id && m.id !== mine.id && m.id !== res.message.id);
        next.push(mine);
        next.push(res.message);
        return next.sort((a, b) => a.id - b.id);
      });
      if (res.taskRun) {
        setTaskRuns((prev) => [res.taskRun as TaskRun, ...prev.filter((r) => r.id !== (res.taskRun as TaskRun).id)]);
      }
      setAiReady(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_provider') {
        setAiReady(false);
        await refreshModels();
      }
      setError(err instanceof Error ? err.message : '응답을 받지 못했습니다.');
      // 서버에는 내 메시지가 이미 저장돼 있을 수 있으니 실제 저장본으로 맞춘다.
      void loadMessages();
    } finally {
      sendingRef.current = false;
      setSending(false);
      setLiveTask(null);
      window.setTimeout(() => {
        api.get<AgentStatus & { ok: true }>('/api/agent/status').then((r) => setAgent({ state: r.state, label: r.label, detail: r.detail, startedAt: r.startedAt, lastError: r.lastError })).catch(() => undefined);
      }, 600);
    }
  }, [refreshModels, loadMessages]);

  const clearChat = useCallback(async () => {
    await api.del('/api/chat/messages').catch(() => undefined);
    setMessages([]);
    setError('');
  }, []);

  /** 로그인 카드: 아이디·비밀번호(필요하면 금고 PIN)를 서버로 보낸다. 값은 이 화면 밖으로 남지 않는다. */
  const submitLoginCard = useCallback(
    async (id: string, input: { username: string; password: string; masterPin?: string }) => {
      try {
        await api.post(`/api/vault/login-card/${id}/submit`, input);
        setLoginRequests((prev) =>
          prev.map((r) => (r.id === id ? { ...r, status: 'submitted' as const, updatedAt: new Date().toISOString() } : r))
        );
        setVaultState((prev) => ({ ...prev, unlocked: true }));
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : '로그인 정보를 저장하지 못했습니다.' };
      }
    },
    []
  );

  const dismissLoginCard = useCallback(async (id: string) => {
    await api.post(`/api/vault/login-card/${id}/cancel`).catch(() => undefined);
    setLoginRequests((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const visibleState: AgentState = sending
    ? agent.state === 'working'
      ? 'working'
      : 'thinking'
    : agent.state;

  const value = useMemo<AppStoreValue>(
    () => ({
      profile,
      models,
      refreshModels,
      refreshProfile,
      refreshAll,
      selectModel,
      messages,
      messagesLoaded,
      liveTask,
      taskRuns,
      sending,
      error,
      aiReady,
      loginRequests,
      vault: vaultState,
      submitLoginCard,
      dismissLoginCard,
      send,
      clearChat,
      draft,
      setDraft,
      agent,
      visibleState,
      keyboardOpen,
    }),
    [profile, models, refreshModels, refreshProfile, refreshAll, selectModel, messages, messagesLoaded, liveTask, taskRuns, sending, error, aiReady, loginRequests, vaultState, submitLoginCard, dismissLoginCard, send, clearChat, draft, agent, visibleState, keyboardOpen]
  );

  return <AppStore.Provider value={value}>{children}</AppStore.Provider>;
}

export const AGENT_STATE_META: Record<AgentState, { label: string; dot: string; text: string; bg: string }> = {
  idle: { label: '대기 중', dot: '#22C55E', text: '#12B886', bg: '#EAFBF1' },
  thinking: { label: '생각 중', dot: '#B9A8FF', text: '#7C63F6', bg: '#F3EEFF' },
  working: { label: '작업 중', dot: '#4A90FF', text: '#3A78D6', bg: '#EFF7FF' },
  responding: { label: '응답 중', dot: '#F5B547', text: '#C98A14', bg: '#FFF6E7' },
  error: { label: '오류', dot: '#F76A6A', text: '#E5484D', bg: '#FFF1F1' },
};
