import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  type ChatMessage,
  type ChatSession,
  type LoginRequest,
  type ModelsResponse,
  type Profile,
  type TaskRun,
  type VaultUnlockRequest,
} from './api';
import { decideTurnOutcome, isBusyState, isNetworkError } from './network';
import { applyStoredTheme, applyTheme, watchSystemTheme } from './theme';

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
  /** 서버 작업이 이어지는 중이라 연결을 다시 붙여 지켜보는 상태 (v0.5.5) */
  recovering: boolean;
  error: string;
  aiReady: boolean;
  /** 채팅에 떠 있는 로그인 카드 (금고에 계정이 없을 때) */
  loginRequests: LoginRequest[];
  /** 채팅에 떠 있는 금고 PIN 입력 카드 (v0.5.4) */
  unlockRequests: VaultUnlockRequest[];
  /** 금고가 잠겨 있으면 카드에서 PIN을 받아야 한다 */
  vault: { configured: boolean; unlocked: boolean };
  submitLoginCard: (
    id: string,
    input: { username: string; password: string; masterPin?: string }
  ) => Promise<{ ok: boolean; message?: string }>;
  dismissLoginCard: (id: string) => Promise<void>;
  submitUnlockCard: (id: string, pin: string) => Promise<{ ok: boolean; message?: string }>;
  dismissUnlockCard: (id: string) => Promise<void>;
  /** 대화방 (v0.5.4) */
  sessions: ChatSession[];
  activeSession: string;
  refreshSessions: () => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  newSession: () => Promise<string | null>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** AI 답변·작업 중지 */
  stop: () => Promise<void>;
  send: (text: string, attachmentIds?: string[]) => Promise<void>;
  clearChat: () => Promise<void>;
  draft: string;
  setDraft: (value: string) => void;
  agent: AgentStatus;
  visibleState: AgentState;
  keyboardOpen: boolean;
}

const DEFAULT_PROFILE: Profile = {
  nickname: '',
  theme: 'light',
  accentMode: 'purple',
  accentColor: '#8B72F8',
  language: 'ko',
  agentName: 'Pomong',
  character: 'pimong',
  tone: 'polite',
  persona: 'default',
  personaCustom: '',
};

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
  const [unlockRequests, setUnlockRequests] = useState<VaultUnlockRequest[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<string>(() => {
    try {
      return localStorage.getItem('pomong.activeSession') || 'default';
    } catch {
      return 'default';
    }
  });
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const [vaultState, setVaultState] = useState<{ configured: boolean; unlocked: boolean }>({ configured: false, unlocked: false });
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState('');
  const [aiReady, setAiReady] = useState(true);
  const [draft, setDraft] = useState('');
  const [agent, setAgent] = useState<AgentStatus>({ state: 'idle', label: '대기 중', detail: '', startedAt: null, lastError: null });
  const sendingRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  /** messagesLoaded의 최신값(이벤트 핸들러에서 읽는다) */
  const messagesLoadedRef = useRef(false);
  /** 연결 복구 루프 세대 번호 — 값이 바뀌면 진행 중이던 복구를 버린다 */
  const recoveryTokenRef = useRef(0);
  /** 지금 복구 루프가 진행 UI를 들고 있는지(방을 옮길 때 정리하려고) */
  const recoveringRef = useRef(false);
  const reconcilingRef = useRef(false);
  const lastReconcileRef = useRef(0);

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

  // v0.5.6: 테마 — 저장된 값을 먼저 칠하고(깜빡임 방지), 기기 설정이 바뀌면 따라간다.
  useEffect(() => {
    applyStoredTheme();
    return watchSystemTheme();
  }, []);

  // 서버 설정을 받아 오면 그 값이 최종 테마다.
  useEffect(() => {
    applyTheme({
      theme: profile.theme,
      accentMode: profile.accentMode || 'purple',
      accentColor: profile.accentColor || '#8B72F8',
      character: profile.character || 'pimong',
    });
  }, [profile.theme, profile.accentMode, profile.accentColor, profile.character]);

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
      .get<{ messages: ChatMessage[]; taskRuns?: TaskRun[] }>(
        `/api/chat/messages?session=${encodeURIComponent(activeSessionRef.current)}`
      )
      .then((r) => {
        setMessages(r.messages);
        setTaskRuns(r.taskRuns || []);
      })
      .catch(() => undefined)
      .finally(() => setMessagesLoaded(true));
    // v0.5.4: 대화방 목록
    api
      .get<{ sessions: ChatSession[] }>('/api/chat/sessions')
      .then((r) => setSessions(r.sessions || []))
      .catch(() => undefined);
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

  const loadMessages = useCallback(async (sessionId?: string) => {
    const id = sessionId || activeSessionRef.current;
    try {
      const r = await api.get<{ messages: ChatMessage[]; taskRuns?: TaskRun[] }>(
        `/api/chat/messages?session=${encodeURIComponent(id)}`
      );
      // 다른 방으로 빠르게 넘어간 뒤 늦게 도착한 예전 응답이 현재 대화를 덮지 않게 한다.
      if (id !== activeSessionRef.current) return;
      setMessages(r.messages);
      setTaskRuns(r.taskRuns || []);
    } catch {
      /* not signed in yet */
    } finally {
      setMessagesLoaded(true);
      messagesLoadedRef.current = true;
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.get<{ sessions: ChatSession[] }>('/api/chat/sessions');
      setSessions(r.sessions || []);
    } catch {
      /* ignore */
    }
  }, []);

  /* ------------------------------------------------------------------ */
  /* v0.5.5: 아이폰 백그라운드 끊김(Load failed)에서 이어 받기             */
  /* iOS가 fetch를 끊어도 서버는 계속 그 턴을 돌린다. 그래서 화면은        */
  /* 오류 카드를 띄우지 않고, 서버가 작업 중이면 진행 UI를 유지한 채        */
  /* 짧은 폴링(SSE + 1.8초)으로 완료를 기다렸다가 답장을 그대로 붙인다.     */
  /* ------------------------------------------------------------------ */

  const fetchSnapshot = useCallback(async (session: string) => {
    try {
      const r = await api.get<{ messages: ChatMessage[]; taskRuns?: TaskRun[] }>(
        `/api/chat/messages?session=${encodeURIComponent(session)}`
      );
      return { messages: r.messages || [], taskRuns: r.taskRuns || [] };
    } catch {
      return null;
    }
  }, []);

  const applySnapshot = useCallback(
    (session: string, snapshot: { messages: ChatMessage[]; taskRuns: TaskRun[] }) => {
      if (session !== activeSessionRef.current) return;
      setMessages((prev) => {
        const sameLength = prev.length === snapshot.messages.length;
        const sameLast = prev[prev.length - 1]?.id === snapshot.messages[snapshot.messages.length - 1]?.id;
        return sameLength && sameLast ? prev : snapshot.messages;
      });
      setTaskRuns(snapshot.taskRuns || []);
      messagesLoadedRef.current = true;
      setMessagesLoaded(true);
    },
    []
  );

  /** 연결이 끊긴 뒤 서버 작업을 지켜보고, 끝나면 답장을 화면에 붙인다. */
  const watchServerTurn = useCallback(
    async (input: { session: string; sinceId: number; prompt?: string }) => {
      const session = input.session;
      if (session !== activeSessionRef.current) return;
      const token = ++recoveryTokenRef.current;
      recoveringRef.current = true;
      setRecovering(true);
      setSending(true);
      sendingRef.current = true;
      setError('');

      const finish = () => {
        if (token !== recoveryTokenRef.current) return;
        recoveringRef.current = false;
        sendingRef.current = false;
        setSending(false);
        setLiveTask(null);
        setRecovering(false);
        void refreshSessions();
      };
      const stillMine = () => token === recoveryTokenRef.current && session === activeSessionRef.current;
      const freshReply = (snapshot: { messages: ChatMessage[] }) =>
        snapshot.messages.some((m) => m.role === 'assistant' && m.id > input.sinceId);

      const deadline = Date.now() + 8 * 60 * 1000;
      while (stillMine() && Date.now() < deadline) {
        const snapshot = await fetchSnapshot(session);
        if (!stillMine()) return;
        if (snapshot) {
          if (freshReply(snapshot)) {
            applySnapshot(session, snapshot);
            setError('');
            finish();
            return;
          }
          // 내가 보낸 말풍선이 서버에 저장됐으면 임시 말풍선을 실제 것과 바꿔 둔다.
          applySnapshot(session, snapshot);
        }

        const running = await api
          .get<{ running: boolean }>(`/api/chat/running?session=${encodeURIComponent(session)}`)
          .catch(() => null);
        if (!stillMine()) return;

        // 진행 중 표시가 방금 끝났거나, 다른 경로(예약 실행·다른 기기)에서 돈 턴일 수 있어 상태도 본다.
        const status = await api
          .get<AgentStatus & { ok: true }>('/api/agent/status')
          .catch(() => null);
        if (!stillMine()) return;
        if (status) {
          setAgent({ state: status.state, label: status.label, detail: status.detail, startedAt: status.startedAt, lastError: status.lastError });
        }

        const decision = decideTurnOutcome({
          freshReply: false,
          running: Boolean(running?.running),
          busy: isBusyState(status?.state),
          agentError: status?.state === 'error' ? status.lastError || 'AI 응답을 받지 못했어요.' : null,
          delivered: true,
        });
        if (decision === 'wait') {
          await new Promise((resolve) => window.setTimeout(resolve, 1800));
          continue;
        }
        if (decision === 'error' && status?.state === 'error' && status.lastError) {
          // 진짜 서버 오류(API 키 오류·제공자 오류 등)만 오류 카드로 보여 준다.
          setError(status.lastError);
          finish();
          return;
        }

        // 답장 저장과 조회가 엇갈렸을 수 있어 한 번 더 확인한다.
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        if (!stillMine()) return;
        const again = await fetchSnapshot(session);
        if (!stillMine()) return;
        if (again) {
          if (freshReply(again)) {
            applySnapshot(session, again);
            setError('');
            finish();
            return;
          }
          applySnapshot(session, again);
        }

        const ended = decideTurnOutcome({
          freshReply: false,
          running: false,
          busy: false,
          agentError: status?.state === 'error' ? status.lastError || 'AI 응답을 받지 못했어요.' : null,
          delivered: Boolean(again && again.messages.some((m) => m.role === 'user' && m.id > input.sinceId)),
        });
        if (ended === 'lost') {
          // 연결이 끊겨 요청 자체가 서버에 닿지 않았다 → 입력한 글을 되살려 준다.
          if (input.prompt) setDraft(input.prompt);
          setError('연결이 잠시 끊겨 메시지가 서버에 도착하지 않았어요. 방금 쓴 내용을 되살려 두었으니 다시 보내 주세요.');
          finish();
          return;
        }
        if (ended === 'error') {
          setError(status?.lastError || 'AI 응답을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.');
          finish();
          return;
        }
        // 서버는 처리를 마쳤고 답장은 없는 상태(사용자가 중지했거나 빈 응답) — 조용히 맞춘다.
        setError('');
        finish();
        return;
      }

      if (!stillMine()) return;
      // 제한 시간 안에 끝나지 않았다. 화면은 진행 상태로 두지 않고 안내만 남긴다.
      setError('서버가 아직 이어서 작업하고 있어요. 잠시 뒤 대화를 다시 열면 결과가 나타나요.');
      finish();
    },
    [applySnapshot, fetchSnapshot, refreshSessions]
  );

  /**
   * 앱으로 돌아왔을 때·새로 열었을 때 서버와 화면을 맞춘다.
   * ① 끊긴 동안 저장된 답장이 있으면 불러오고 ② 서버가 아직 그 방을 작업 중이면 진행 UI로 이어 붙는다.
   */
  const reconcileActiveSession = useCallback(async () => {
    if (reconcilingRef.current) return;
    const session = activeSessionRef.current;
    if (!session) return;
    if (Date.now() - lastReconcileRef.current < 2000) return;
    reconcilingRef.current = true;
    lastReconcileRef.current = Date.now();
    try {
      const snapshot = await fetchSnapshot(session);
      if (session !== activeSessionRef.current) return;
      let watermark = 0;
      if (snapshot) {
        const localMax = messagesRef.current.reduce((max, m) => Math.max(max, m.id > 0 ? m.id : 0), 0);
        const serverMax = snapshot.messages.reduce((max, m) => Math.max(max, m.id), 0);
        watermark = serverMax;
        if (serverMax > localMax || !messagesLoadedRef.current) applySnapshot(session, snapshot);
      }
      if (sendingRef.current) return;
      const running = await api
        .get<{ running: boolean }>(`/api/chat/running?session=${encodeURIComponent(session)}`)
        .catch(() => null);
      if (!running?.running || session !== activeSessionRef.current || sendingRef.current) return;
      void watchServerTurn({ session, sinceId: watermark });
    } finally {
      reconcilingRef.current = false;
    }
  }, [applySnapshot, fetchSnapshot, watchServerTurn]);

  const switchSession = useCallback(
    async (id: string) => {
      if (!id || id === activeSessionRef.current) return;
      activeSessionRef.current = id;
      setActiveSession(id);
      try {
        localStorage.setItem('pomong.activeSession', id);
      } catch {
        /* ignore */
      }
      setMessages([]);
      setTaskRuns([]);
      setLiveTask(null);
      setLoginRequests([]);
      setUnlockRequests([]);
      setError('');
      recoveryTokenRef.current += 1;
      if (recoveringRef.current) {
        // 복구 대기 중에 방을 옮기면 그 화면의 진행 표시도 함께 정리한다(멈춘 점 3개 방지).
        recoveringRef.current = false;
        sendingRef.current = false;
        setSending(false);
        setLiveTask(null);
      }
      setRecovering(false);
      await loadMessages(id);
      void refreshSessions();
    },
    [loadMessages, refreshSessions]
  );

  const newSession = useCallback(async (): Promise<string | null> => {
    try {
      const r = await api.post<{ session: ChatSession }>('/api/chat/sessions', {});
      await refreshSessions();
      await switchSession(r.session.id);
      return r.session.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : '새 대화를 만들지 못했습니다.');
      return null;
    }
  }, [refreshSessions, switchSession]);

  const renameSession = useCallback(
    async (id: string, title: string) => {
      await api.patch(`/api/chat/sessions/${id}`, { title }).catch(() => undefined);
      await refreshSessions();
    },
    [refreshSessions]
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await api.del(`/api/chat/sessions/${id}`).catch(() => undefined);
      await refreshSessions();
      if (id === activeSessionRef.current) {
        // 지금 보던 방을 지웠으면 첫 방으로 돌아간다.
        activeSessionRef.current = '';
        await switchSession('default');
      }
    },
    [refreshSessions, switchSession]
  );

  /** 채팅에 떠 있던 로그인 카드(대기·최근 저장)·금고 PIN 카드와 금고 잠금 상태 */
  const loadLoginCards = useCallback(async (sessionId?: string) => {
    const id = sessionId || activeSessionRef.current;
    try {
      const r = await api.get<{
        requests: LoginRequest[];
        unlockRequests?: VaultUnlockRequest[];
        configured: boolean;
        unlocked: boolean;
      }>(`/api/vault/login-cards?session=${encodeURIComponent(id)}`);
      if (id !== activeSessionRef.current) return;
      setLoginRequests(r.requests || []);
      setUnlockRequests(r.unlockRequests || []);
      setVaultState({ configured: r.configured, unlocked: r.unlocked });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadLoginCards();
  }, [loadLoginCards, activeSession]);

  /**
   * v0.5.5: 앱으로 돌아오는 순간(visibilitychange·pageshow·online)과 첫 실행 때
   * 서버와 화면을 맞춘다. 끊긴 사이에 도착한 답장을 불러오고, 서버가 아직
   * 그 방을 작업 중이면 진행 UI로 이어 붙인다.
   */
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState === 'hidden') return;
      void reconcileActiveSession();
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('pageshow', onBack);
    window.addEventListener('online', onBack);
    // 앱을 새로 열었을 때 서버가 이미 그 방을 돌리고 있는 경우(백그라운드 실행 중)도 이어 붙는다.
    const boot = window.setTimeout(() => void reconcileActiveSession(), 1200);
    return () => {
      window.clearTimeout(boot);
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('pageshow', onBack);
      window.removeEventListener('online', onBack);
    };
  }, [reconcileActiveSession]);

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
          // 다른 대화방의 메시지가 지금 보는 방에 섮이지 않게 한다.
          const eventSession = event.data?.session ? String(event.data.session) : null;
          if (eventSession && eventSession !== activeSessionRef.current) return;
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message].sort((a, b) => a.id - b.id)));
          return;
        }
        if (event.type === 'vault_unlock_request') {
          const request = event.data?.request as VaultUnlockRequest | undefined;
          if (!request || !request.id) return;
          if (request.sessionId && request.sessionId !== activeSessionRef.current) return;
          setUnlockRequests((prev) => {
            const next = prev.some((r) => r.id === request.id)
              ? prev.map((r) => (r.id === request.id ? request : r))
              : [...prev, request];
            return next.filter((r) => r.status !== 'cancelled').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          });
          void loadLoginCards();
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
          // v0.5.3: 서버가 만든 로그인 카드를 목록까지 다시 받아 새로고침 없이 확실히 맞춘다.
          void loadLoginCards();
          return;
        }
        if (event.type === 'chat' || event.type === 'chat_message') {
          const message = event.data?.message as ChatMessage | undefined;
          // 답변에 로그인 카드 언급이 있는데 카드가 아직 화면에 없으면 목록을 다시 받는다.
          if (message && typeof message.content === 'string' && /로그인\s*카드|카드에[\s\S]{0,20}입력/.test(message.content)) {
            void loadLoginCards();
          }
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

  const send = useCallback(async (text: string, attachmentIds?: string[]) => {
    const content = text.trim();
    const ids = (attachmentIds || []).filter(Boolean);
    if ((!content && !ids.length) || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError('');
    setDraft('');
    // 끊겼을 때 "이 요청 전에 있던 마지막 메시지"를 기준점으로 삼아 새 답장을 가려낸다.
    const watermark = messagesRef.current.reduce((max, m) => Math.max(max, m.id > 0 ? m.id : 0), 0);
    const session = activeSessionRef.current;
    const optimistic: ChatMessage = {
      id: -Date.now(),
      role: 'user',
      content,
      meta: null,
      attachments: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    // 네트워크 단절로 복구 모드에 넘겼는지(그때는 finally가 진행 상태를 끄지 않는다)
    let handedOff = false;
    try {
      const res = await api.post<{ message: ChatMessage; userMessage?: ChatMessage; taskRun?: TaskRun | null }>('/api/chat/messages', {
        message: content,
        session,
        attachmentIds: ids.length ? ids : undefined,
      });
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
      if (err instanceof ApiError && err.code === 'cancelled') {
        // 사용자가 '■ 중지'를 누른 경우는 오류가 아니다.
        void loadMessages();
        return;
      }
      // v0.5.5: 아이폰에서 앱을 나가면 iOS가 fetch를 끊는다(Load failed). 서버는 계속 작업 중이므로
      // 오류 카드를 띄우지 않고, 서버가 끝낼 때까지 진행 UI를 유지하며 답장을 이어 받는다.
      if (isNetworkError(err)) {
        handedOff = true;
        setSending(true);
        void watchServerTurn({ session, sinceId: watermark, prompt: content });
        return;
      }
      if (err instanceof ApiError && err.code === 'no_provider') {
        setAiReady(false);
        await refreshModels();
      }
      setError(err instanceof Error ? err.message : '응답을 받지 못했습니다.');
      // 서버에는 내 메시지가 이미 저장돼 있을 수 있으니 실제 저장본으로 맞춘다.
      void loadMessages();
    } finally {
      if (!handedOff) {
        sendingRef.current = false;
        setSending(false);
        setLiveTask(null);
      }
      void refreshSessions();
      window.setTimeout(() => {
        api.get<AgentStatus & { ok: true }>('/api/agent/status').then((r) => setAgent({ state: r.state, label: r.label, detail: r.detail, startedAt: r.startedAt, lastError: r.lastError })).catch(() => undefined);
      }, 600);
    }
  }, [refreshModels, loadMessages, refreshSessions, watchServerTurn]);

  const clearChat = useCallback(async () => {
    await api.del(`/api/chat/messages?session=${encodeURIComponent(activeSessionRef.current)}`).catch(() => undefined);
    setMessages([]);
    setError('');
    void refreshSessions();
  }, [refreshSessions]);

  /** AI 답변·브라우저 작업 중지 (■ 중지) */
  const stop = useCallback(async () => {
    const id = activeSessionRef.current;
    // 복구 대기 중이었다면 그 루프부터 멈춘다(사용자가 중지했으니 더 기다리지 않는다).
    recoveryTokenRef.current += 1;
    recoveringRef.current = false;
    setRecovering(false);
    await api.post('/api/chat/stop', { session: id }).catch(() => undefined);
    sendingRef.current = false;
    setSending(false);
    setLiveTask(null);
    setError('');
    window.setTimeout(() => void loadMessages(id), 500);
    void refreshSessions();
  }, [loadMessages, refreshSessions]);

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

  /** v0.5.4: 금고 PIN 입력 카드 — PIN은 서버로만 보내고 저장하지 않는다. */
  const submitUnlockCard = useCallback(
    async (id: string, pin: string) => {
      try {
        await api.post(`/api/vault/unlock-card/${id}/submit`, { pin });
        setUnlockRequests((prev) => prev.map((r) => (r.id === id ? { ...r, status: 'unlocked' as const } : r)));
        setVaultState((prev) => ({ ...prev, unlocked: true }));
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'PIN을 확인하지 못했습니다.' };
      }
    },
    []
  );

  const dismissUnlockCard = useCallback(async (id: string) => {
    await api.post(`/api/vault/unlock-card/${id}/cancel`).catch(() => undefined);
    setUnlockRequests((prev) => prev.filter((r) => r.id !== id));
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
      recovering,
      error,
      aiReady,
      loginRequests,
      unlockRequests,
      vault: vaultState,
      submitLoginCard,
      dismissLoginCard,
      submitUnlockCard,
      dismissUnlockCard,
      sessions,
      activeSession,
      refreshSessions,
      switchSession,
      newSession,
      renameSession,
      deleteSession,
      stop,
      send,
      clearChat,
      draft,
      setDraft,
      agent,
      visibleState,
      keyboardOpen,
    }),
    [
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
      recovering,
      error,
      aiReady,
      loginRequests,
      unlockRequests,
      vaultState,
      submitLoginCard,
      dismissLoginCard,
      submitUnlockCard,
      dismissUnlockCard,
      sessions,
      activeSession,
      refreshSessions,
      switchSession,
      newSession,
      renameSession,
      deleteSession,
      stop,
      send,
      clearChat,
      draft,
      agent,
      visibleState,
      keyboardOpen,
    ]
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
