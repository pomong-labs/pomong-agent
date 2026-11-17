import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type ChatMessage, type ModelsResponse, type Profile } from './api';

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
  sending: boolean;
  error: string;
  aiReady: boolean;
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
    const apply = () => {
      const height = vv?.height ?? window.innerHeight;
      const layout = window.innerHeight;
      const offsetTop = vv?.offsetTop ?? 0;
      const offsetLeft = vv?.offsetLeft ?? 0;
      const open = layout - height > 140 || offsetTop > 2;
      const root = document.documentElement;
      root.style.setProperty('--app-height', `${Math.round(height)}px`);
      root.style.setProperty('--app-offset', `${Math.round(offsetTop)}px`);
      root.style.setProperty('--app-offset-x', `${Math.round(offsetLeft)}px`);
      root.classList.toggle('kb-open', open);
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
    apply();
    vv?.addEventListener('resize', onResize);
    vv?.addEventListener('scroll', onFocusOrScroll);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', resetScroll, { passive: true });
    window.addEventListener('orientationchange', onResize);
    document.addEventListener('focusin', onFocusOrScroll);
    document.addEventListener('focusout', onFocusOrScroll);
    return () => {
      cancelAnimationFrame(frame);
      vv?.removeEventListener('resize', onResize);
      vv?.removeEventListener('scroll', onFocusOrScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', resetScroll);
      window.removeEventListener('orientationchange', onResize);
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
      .get<{ messages: ChatMessage[] }>('/api/chat/messages')
      .then((r) => setMessages(r.messages))
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
      const r = await api.get<{ messages: ChatMessage[] }>('/api/chat/messages');
      setMessages(r.messages);
    } catch {
      /* not signed in yet */
    } finally {
      setMessagesLoaded(true);
    }
  }, []);

  /** 로그인/설정 완료 직후 프로필·모델·대화를 다시 불러온다. */
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshProfile(), refreshModels(), loadMessages()]);
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
      const res = await api.post<{ message: ChatMessage; userMessage?: ChatMessage }>('/api/chat/messages', { message: content });
      // 서버가 저장한 내 메시지(userMessage)로 임시 메시지를 바꾸고, AI 답변을 뒤에 붙인다.
      // 예전에는 응답에 AI 답변만 담겨 와서 내 메시지가 화면에서 사라졌다.
      const mine: ChatMessage = res.userMessage ?? { ...optimistic, id: res.message.id - 1 };
      setMessages((prev) => {
        const next = prev.filter((m) => m.id !== optimistic.id && m.id !== mine.id && m.id !== res.message.id);
        next.push(mine);
        next.push(res.message);
        return next.sort((a, b) => a.id - b.id);
      });
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
      sending,
      error,
      aiReady,
      send,
      clearChat,
      draft,
      setDraft,
      agent,
      visibleState,
      keyboardOpen,
    }),
    [profile, models, refreshModels, refreshProfile, refreshAll, selectModel, messages, messagesLoaded, sending, error, aiReady, send, clearChat, draft, agent, visibleState, keyboardOpen]
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
