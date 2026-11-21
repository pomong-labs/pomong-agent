import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  type ChatAttachment,
  type ChatMessage,
  type ReplyTarget,
  type ChatSession,
  type LoginRequest,
  type ModelsResponse,
  type Profile,
  type TaskRun,
  type ApprovalRequest,
  type VaultUnlockRequest,
} from './api';
import { decideTurnOutcome, isBusyState, isNetworkError } from './network';
import { applyStoredTheme, applyTheme, watchSystemTheme } from './theme';
import { applyBold, applyFont, readStoredBold, readStoredFont } from './font';
import { mergeMessages, mergeTaskRuns } from './chat-merge';

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
  /** 이번 턴이 시작된 시각(ms) — 채팅방마다 따로 센다 */
  turnStart: number | null;
  error: string;
  aiReady: boolean;
  /** 채팅에 떠 있는 로그인 카드 (금고에 계정이 없을 때) */
  loginRequests: LoginRequest[];
  /** 채팅에 떠 있는 금고 PIN 입력 카드 (v0.5.4) */
  unlockRequests: VaultUnlockRequest[];
  /** v0.6.18: 되돌리기 어려운 작업의 승인 카드 */
  approvals: ApprovalRequest[];
  approveTask: (id: string) => Promise<{ ok: boolean; message?: string }>;
  cancelApproval: (id: string) => Promise<void>;
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
  send: (text: string, attachmentIds?: string[], replyTo?: ReplyTarget | null, attachmentViews?: ChatAttachment[]) => Promise<void>;
  clearChat: () => Promise<void>;
  draft: string;
  setDraft: (value: string) => void;
  agent: AgentStatus;
  visibleState: AgentState;
  keyboardOpen: boolean;
  /**
   * v0.6.4: 화면을 앱 셸 바깥까지 꽉 채우는 모드(브라우저 VNC 전체화면 등).
   * 켜져 있으면 하단 탭바를 숨겨 전체화면 위에 겹치지 않게 한다.
   */
  immersive: boolean;
  setImmersive: (value: boolean) => void;
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
  // v0.6.4: 첫 페인트에 이미 칠해 둔 글꼴에서 시작해, 프로필을 받아 오기 전에 되돌아가지 않게 한다.
  font: readStoredFont(),
  // v0.6.18: 첫 페인트에 이미 칠해 둔 볼드체에서 시작
  bold: readStoredBold(),
};

/**
 * v0.6.4: 대화방(sessionId)마다 따로 들고 있는 진행 상태.
 * 예전에는 진행 상태가 전역에 하나뿐이라 A방에서 작업 중 B방으로 옮기면
 * 작업 카드가 B방에 따라오고, A방으로 돌아오면 사라져 있었다.
 */
interface SessionRuntime {
  sending: boolean;
  recovering: boolean;
  liveTask: TaskRun | null;
  startedAt: number | null;
  error: string;
}

const EMPTY_RUNTIME: SessionRuntime = {
  sending: false,
  recovering: false,
  liveTask: null,
  startedAt: null,
  error: '',
};

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_RUNS: TaskRun[] = [];

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
      // v0.6.7: 화면이 실제로 밀린 경우에만 셸을 translate 한다(평상시 transform은 iOS PWA 상태바에 흰 띠를 만든다).
      root.classList.toggle('pa-shifted', Math.abs(offsetTop) >= 1 || Math.abs(offsetLeft) >= 1);
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
  /* v0.6.4: 대화는 방마다 따로 보관한다(방을 오가도 섞이지 않게). */
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [taskRunsBySession, setTaskRunsBySession] = useState<Record<string, TaskRun[]>>({});
  const [loadedBySession, setLoadedBySession] = useState<Record<string, boolean>>({});
  const [runtimeBySession, setRuntimeBySession] = useState<Record<string, SessionRuntime>>({});
  const [loginRequests, setLoginRequests] = useState<LoginRequest[]>([]);
  /** v0.6.18: 승인 대기 카드 */
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
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
  const [immersive, setImmersiveState] = useState(false);
  const [aiReady, setAiReady] = useState(true);
  const [draft, setDraft] = useState('');
  const [agent, setAgent] = useState<AgentStatus>({ state: 'idle', label: '대기 중', detail: '', startedAt: null, lastError: null });

  /* 지금 보고 있는 방의 상태 — 화면은 이 값을 그대로 쓴다. */
  const messages = messagesBySession[activeSession] ?? EMPTY_MESSAGES;
  const taskRuns = taskRunsBySession[activeSession] ?? EMPTY_RUNS;
  const runtime = runtimeBySession[activeSession] ?? EMPTY_RUNTIME;
  const messagesLoaded = Boolean(loadedBySession[activeSession]);
  const liveTask = runtime.liveTask;
  const sending = runtime.sending;
  const recovering = runtime.recovering;
  const turnStart = runtime.startedAt;
  const error = runtime.error;

  /** 전송 요청이 실제로 진행 중인 방 — 화면 반영(렌더) 전에 연타를 막는 동기 가드 */
  const inFlightRef = useRef<Set<string>>(new Set());
  const runtimeRef = useRef(runtimeBySession);
  runtimeRef.current = runtimeBySession;
  const messagesRef = useRef(messagesBySession);
  messagesRef.current = messagesBySession;
  /** messagesLoaded의 최신값(이벤트 핸들러에서 읽는다) */
  const messagesLoadedRef = useRef(loadedBySession);
  messagesLoadedRef.current = loadedBySession;

  /** 그 방의 메시지만 골라 바꾼다(다른 방은 그대로). */
  const patchMessages = useCallback((session: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessagesBySession((prev) => {
      const current = prev[session] ?? EMPTY_MESSAGES;
      const next = updater(current);
      return next === current ? prev : { ...prev, [session]: next };
    });
  }, []);

  const patchRuns = useCallback((session: string, updater: (prev: TaskRun[]) => TaskRun[]) => {
    setTaskRunsBySession((prev) => {
      const current = prev[session] ?? EMPTY_RUNS;
      const next = updater(current);
      return next === current ? prev : { ...prev, [session]: next };
    });
  }, []);

  const patchRuntime = useCallback((session: string, patch: Partial<SessionRuntime>) => {
    setRuntimeBySession((prev) => ({ ...prev, [session]: { ...(prev[session] ?? EMPTY_RUNTIME), ...patch } }));
  }, []);

  const markLoaded = useCallback((session: string) => {
    setLoadedBySession((prev) => (prev[session] ? prev : { ...prev, [session]: true }));
  }, []);

  /** 그 방이 지금 작업 중인지(전역 1개가 아니라 방별) */
  const isSending = useCallback(
    (session: string) => inFlightRef.current.has(session) || Boolean(runtimeRef.current[session]?.sending),
    []
  );

  const setImmersive = useCallback((value: boolean) => setImmersiveState(value), []);
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

  // v0.6.4: 글꼴도 저장된 값을 따르고, 첫 페인트에 이미 칠해 둔 값을 화면과 맞춘다.
  // v0.6.5: 서버 프로필에 글꼴이 아직 없거나 기본값인데 이 기기에서 고른 글꼴이 있으면
  //         화면 글꼴을 기본으로 되돌리지 않고 이 기기 값을 유지한 뒤 서버에 한 번 올려 맞춘다.
  //         (예전 서버가 PUT에서 font를 빠뜨렸을 때 고른 글꼴이 사라지던 문제 보완)
  useEffect(() => {
    const stored = readStoredFont();
    const next = profile.font === 'default' && stored !== 'default' ? stored : profile.font || stored;
    applyFont(next);
    if (next !== profile.font) {
      api.put('/api/settings/profile', { font: next }).catch(() => undefined);
    }
  }, [profile.font]);

  /**
   * v0.6.18: 글씨 굵게(볼드체) — 서버 프로필이 최종값이지만,
   * 아직 서버에 저장 전(구버전 프로필)이면 이 기기(localStorage) 값을 유지한다.
   */
  useEffect(() => {
    const stored = readStoredBold();
    const next = typeof profile.bold === 'boolean' ? profile.bold : stored;
    applyBold(next);
    if (typeof profile.bold !== 'boolean' && next) {
      api.put('/api/settings/profile', { bold: next }).catch(() => undefined);
    }
  }, [profile.bold]);

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
        const boot = activeSessionRef.current;
        patchMessages(boot, (prev) => mergeMessages(prev, r.messages || []));
        patchRuns(boot, (prev) => mergeTaskRuns(prev, r.taskRuns || []));
      })
      .catch(() => undefined)
      .finally(() => markLoaded(activeSessionRef.current));
    // v0.5.4: 대화방 목록
    api
      .get<{ sessions: ChatSession[] }>('/api/chat/sessions')
      .then((r) => setSessions(r.sessions || []))
      .catch(() => undefined);
    api
      .get<{ aiConfigured: boolean }>('/api/auth/me')
      .then((r) => setAiReady(r.aiConfigured))
      .catch(() => undefined);
  }, [refreshModels, patchMessages, patchRuns, markLoaded]);

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
    const id = window.setInterval(load, sending ? 1500 : 6000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [sending]);

  const loadMessages = useCallback(
    async (sessionId?: string) => {
      const id = sessionId || activeSessionRef.current;
      try {
        const r = await api.get<{ messages: ChatMessage[]; taskRuns?: TaskRun[] }>(
          `/api/chat/messages?session=${encodeURIComponent(id)}`
        );
        // v0.6.4: 늦게 도착한 응답이라도 **그 방의 칸**에만 쌓는다. 보고 있는 방이면 바로 반영되고,
        // 다른 방이면 그 방으로 돌아올 때 최신 상태로 보인다(다른 방 화면을 덮지 않는다).
        patchMessages(id, (prev) => mergeMessages(prev, r.messages || []));
        patchRuns(id, (prev) => mergeTaskRuns(prev, r.taskRuns || []));
      } catch {
        /* not signed in yet */
      } finally {
        markLoaded(id);
        messagesLoadedRef.current = { ...messagesLoadedRef.current, [id]: true };
      }
    },
    [markLoaded, patchMessages, patchRuns]
  );

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
      // v0.6.4: 보고 있는 방이 아니어도 그 방의 칸에만 쌓아 둔다(돌아오면 그대로 보인다).
      patchMessages(session, (prev) => mergeMessages(prev, snapshot.messages || []));
      patchRuns(session, (prev) => mergeTaskRuns(prev, snapshot.taskRuns || []));
      markLoaded(session);
      messagesLoadedRef.current = { ...messagesLoadedRef.current, [session]: true };
    },
    [markLoaded, patchMessages, patchRuns]
  );

  /** 연결이 끊긴 뒤 서버 작업을 지켜보고, 끝나면 답장을 화면에 붙인다. */
  const watchServerTurn = useCallback(
    async (input: { session: string; sinceId: number; prompt?: string }) => {
      const session = input.session;
      const token = ++recoveryTokenRef.current;
      const active = () => activeSessionRef.current === session;
      patchRuntime(session, { recovering: true, sending: true, startedAt: Date.now(), error: '' });

      const finish = (error = '') => {
        if (token !== recoveryTokenRef.current) return;
        patchRuntime(session, { recovering: false, sending: false, liveTask: null, startedAt: null, error });
        void refreshSessions();
      };
      const stillMine = () => token === recoveryTokenRef.current;
      const freshReply = (snapshot: { messages: ChatMessage[] }) =>
        snapshot.messages.some((m) => m.role === 'assistant' && m.id > input.sinceId);

      const deadline = Date.now() + 8 * 60 * 1000;
      while (stillMine() && Date.now() < deadline) {
        const snapshot = await fetchSnapshot(session);
        if (!stillMine()) return;
        if (snapshot) {
          applySnapshot(session, snapshot);
          if (freshReply(snapshot)) {
            finish();
            return;
          }
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
        if (status && active()) {
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
          finish(status.lastError);
          return;
        }

        // 답장 저장과 조회가 엇갈렸을 수 있어 한 번 더 확인한다.
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        if (!stillMine()) return;
        const again = await fetchSnapshot(session);
        if (!stillMine()) return;
        if (again) {
          applySnapshot(session, again);
          if (freshReply(again)) {
            finish();
            return;
          }
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
          if (input.prompt && active()) setDraft(input.prompt);
          finish('연결이 잠시 끊겨 메시지가 서버에 도착하지 않았어요. 방금 쓴 내용을 되살려 두었으니 다시 보내 주세요.');
          return;
        }
        if (ended === 'error') {
          finish(status?.lastError || 'AI 응답을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.');
          return;
        }
        // 서버는 처리를 마쳤고 답장은 없는 상태(사용자가 중지했거나 빈 응답) — 조용히 맞춘다.
        finish();
        return;
      }

      if (!stillMine()) return;
      // 제한 시간 안에 끝나지 않았다. 화면은 진행 상태로 두지 않고 안내만 남긴다.
      finish('서버가 아직 이어서 작업하고 있어요. 잠시 뒤 대화를 다시 열면 결과가 나타나요.');
    },
    [applySnapshot, fetchSnapshot, patchRuntime, refreshSessions, setDraft]
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
      const local = messagesRef.current[session] ?? EMPTY_MESSAGES;
      if (snapshot) {
        const localMax = local.reduce((max, m) => Math.max(max, m.id > 0 ? m.id : 0), 0);
        const serverMax = snapshot.messages.reduce((max, m) => Math.max(max, m.id), 0);
        watermark = serverMax;
        if (serverMax > localMax || !messagesLoadedRef.current[session]) applySnapshot(session, snapshot);
      }
      if (isSending(session)) return;
      const running = await api
        .get<{ running: boolean }>(`/api/chat/running?session=${encodeURIComponent(session)}`)
        .catch(() => null);
      if (!running?.running || session !== activeSessionRef.current || isSending(session)) return;
      void watchServerTurn({ session, sinceId: watermark });
    } finally {
      reconcilingRef.current = false;
    }
  }, [applySnapshot, fetchSnapshot, isSending, watchServerTurn]);

  /**
   * v0.6.4: 방을 옮길 때 그 방의 진행 상태를 서버에서 다시 확인한다.
   * A방에서 작업을 걸어두고 B방으로 갔다가 돌아오면, 진행 중 작업 카드가 그대로 이어진다.
   */
  const syncSessionRuntime = useCallback(
    async (id: string) => {
      try {
        const r = await api.get<{ running: boolean; startedAt: string | null; taskRun: TaskRun | null }>(
          `/api/chat/sessions/${encodeURIComponent(id)}/active`
        );
        if (r.running) {
          const started = r.startedAt ? new Date(r.startedAt).getTime() : null;
          patchRuntime(id, {
            sending: true,
            recovering: false,
            liveTask: r.taskRun || runtimeRef.current[id]?.liveTask || null,
            startedAt: started && Number.isFinite(started) ? started : Date.now(),
            error: '',
          });
        } else {
          const current = runtimeRef.current[id];
          // 서버가 이미 끝났으면 남아 있던 진행 표시를 정리한다(멈춘 점 3개 방지).
          if (current?.sending && !current.recovering) {
            patchRuntime(id, { sending: false, liveTask: null, startedAt: null });
          }
        }
      } catch {
        /* 오래된 서버(0.6.3 이하)면 이 확인을 건너뛴다 */
      }
    },
    [patchRuntime]
  );

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
      // v0.6.4: 방마다 들고 있는 메시지·작업 카드·진행 상태를 그대로 살린다.
      // (예전처럼 [] 로 비우지 않는다 → 돌아오면 보던 그대로)
      setLoginRequests([]);
      setUnlockRequests([]);
      await loadMessages(id);
      void syncSessionRuntime(id);
      void refreshSessions();
    },
    [loadMessages, refreshSessions, syncSessionRuntime]
  );

  const newSession = useCallback(async (): Promise<string | null> => {
    try {
      const r = await api.post<{ session: ChatSession }>('/api/chat/sessions', {});
      await refreshSessions();
      await switchSession(r.session.id);
      return r.session.id;
    } catch (err) {
      patchRuntime(activeSessionRef.current, {
        error: err instanceof Error ? err.message : '새 대화를 만들지 못했습니다.',
      });
      return null;
    }
  }, [patchRuntime, refreshSessions, switchSession]);

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
        /** v0.6.18: 승인 카드 */
        approvals?: ApprovalRequest[];
        configured: boolean;
        unlocked: boolean;
      }>(`/api/vault/login-cards?session=${encodeURIComponent(id)}`);
      if (id !== activeSessionRef.current) return;
      setLoginRequests(r.requests || []);
      setUnlockRequests(r.unlockRequests || []);
      setApprovals(r.approvals || []);
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
          if (run) {
            // v0.6.4: 작업 카드도 그 방(sessionId)의 칸에만 붙인다.
            const runSession = run.sessionId || activeSessionRef.current;
            patchRuntime(runSession, { liveTask: run });
            if (run.endedAt || run.status !== 'running') {
              patchRuns(runSession, (prev) => mergeTaskRuns(prev, [run]));
            }
          }
          return;
        }
        if (event.type === 'chat_message' || event.type === 'chat') {
          const message = event.data?.message as ChatMessage | undefined;
          if (!message || typeof message.id !== 'number') return;
          // 다른 대화방의 메시지는 그 방의 칸에만 쌓는다(보고 있는 방을 덮지 않는다).
          const eventSession = event.data?.session ? String(event.data.session) : activeSessionRef.current;
          patchMessages(eventSession, (prev) => (prev.some((m) => m.id === message.id) ? prev : mergeMessages(prev, [message])));
          return;
        }
        if (event.type === 'chat_reaction') {
          // v0.6.15: 비서가 단 말풍선 리액션을 바로 반영한다(새로고침 없이).
          const messageId = Number(event.data?.messageId);
          const emojiList = Array.isArray(event.data?.reactions) ? (event.data?.reactions as string[]) : [];
          if (!Number.isFinite(messageId) || messageId <= 0) return;
          const eventSession = event.data?.session ? String(event.data.session) : activeSessionRef.current;
          patchMessages(eventSession, (prev) =>
            prev.some((m) => m.id === messageId)
              ? prev.map((m) => (m.id === messageId ? { ...m, reactions: emojiList } : m))
              : prev
          );
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
  }, [loadLoginCards, patchMessages, patchRuns, patchRuntime]);

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
        patchRuntime(activeSessionRef.current, { error: '' });
        return { ok: true, message: `${r.active.model}` };
      } catch (err) {
        const needsKey = err instanceof ApiError && err.code === 'provider_not_connected';
        return { ok: false, message: err instanceof Error ? err.message : '모델을 바꾸지 못했습니다.', needsKey };
      }
    },
    [patchRuntime, refreshModels]
  );

  const send = useCallback(
    async (text: string, attachmentIds?: string[], replyTo?: ReplyTarget | null, attachmentViews?: ChatAttachment[]) => {
      const content = text.trim();
      const ids = (attachmentIds || []).filter(Boolean);
      const session = activeSessionRef.current;
      if ((!content && !ids.length) || isSending(session)) return;
      inFlightRef.current.add(session);
      patchRuntime(session, { sending: true, recovering: false, startedAt: Date.now(), error: '' });
      setDraft('');
      // 끊겼을 때 "이 요청 전에 있던 마지막 메시지"를 기준점으로 삼아 새 답장을 가려낸다.
      const sessionMessages = messagesRef.current[session] ?? EMPTY_MESSAGES;
      const watermark = sessionMessages.reduce((max, m) => Math.max(max, m.id > 0 ? m.id : 0), 0);
      const optimistic: ChatMessage = {
        id: -Date.now(),
        role: 'user',
        content,
        meta: null,
        // v0.6.12: 낙관적 말풍선에도 보낸 첨부를 바로 넣는다. 예전에는 비워 두어 AI 답장이 끝나고
        // 서버 메시지로 바뀔 때까지 사진·파일이 내 말풍선에 보이지 않았다(IMG_3649 → IMG_3650).
        attachments: attachmentViews ?? [],
        replyTo: replyTo ? { id: replyTo.id, role: replyTo.role, content: replyTo.content, createdAt: replyTo.createdAt } : null,
        createdAt: new Date().toISOString(),
      };
      patchMessages(session, (prev) => [...prev, optimistic]);
      // 네트워크 단절로 복구 모드에 넘겼는지(그때는 finally가 진행 상태를 끄지 않는다)
      let handedOff = false;
      try {
        const res = await api.post<{ message: ChatMessage; userMessage?: ChatMessage; taskRun?: TaskRun | null }>('/api/chat/messages', {
          message: content,
          session,
          attachmentIds: ids.length ? ids : undefined,
          replyToId: replyTo ? replyTo.id : undefined,
        });
        // 서버가 저장한 내 메시지(userMessage)로 임시 메시지를 바꾸고, AI 답변을 뒤에 붙인다.
        // v0.6.4: 통째로 비우고 다시 붙이지 않고 id 기준으로 합친다(말풍선이 잠깐 사라지는 깜빡임 방지).
        const mine: ChatMessage = res.userMessage ?? { ...optimistic, id: res.message.id - 1 };
        patchMessages(session, (prev) => mergeMessages(prev.filter((m) => m.id !== optimistic.id), [mine, res.message]));
        if (res.taskRun) {
          const run = res.taskRun;
          patchRuns(session, (prev) => mergeTaskRuns(prev, [run]));
          // 끝난 작업 카드로 바꿔치기되는 순간 카드가 사라지지 않게 진행 카드를 곧바로 내린다.
          if (run.endedAt || run.status !== 'running') patchRuntime(session, { liveTask: null });
        }
        setAiReady(true);
        /** v0.6.18: 이번 턴에 생긴 승인 카드·로그인 카드를 바로 보여 준다. */
        void loadLoginCards(session);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'cancelled') {
          // 사용자가 '■ 중지'를 누른 경우는 오류가 아니다.
          void loadMessages(session);
          return;
        }
        // v0.5.5: 아이폰에서 앱을 나가면 iOS가 fetch를 끊는다(Load failed). 서버는 계속 작업 중이므로
        // 오류 카드를 띄우지 않고, 서버가 끝낼 때까지 진행 UI를 유지하며 답장을 이어 받는다.
        if (isNetworkError(err)) {
          handedOff = true;
          patchRuntime(session, { sending: true });
          void watchServerTurn({ session, sinceId: watermark, prompt: content });
          return;
        }
        if (err instanceof ApiError && err.code === 'no_provider') {
          setAiReady(false);
          await refreshModels();
        }
        patchRuntime(session, { error: err instanceof Error ? err.message : '응답을 받지 못했습니다.' });
        // 서버에는 내 메시지가 이미 저장돼 있을 수 있으니 실제 저장본으로 맞춘다.
        void loadMessages(session);
      } finally {
        inFlightRef.current.delete(session);
        if (!handedOff) {
          patchRuntime(session, { sending: false, recovering: false, liveTask: null, startedAt: null });
        }
        void refreshSessions();
        window.setTimeout(() => {
          api.get<AgentStatus & { ok: true }>('/api/agent/status').then((r) => setAgent({ state: r.state, label: r.label, detail: r.detail, startedAt: r.startedAt, lastError: r.lastError })).catch(() => undefined);
        }, 600);
      }
    },
    [isSending, loadMessages, loadLoginCards, patchMessages, patchRuns, patchRuntime, refreshModels, refreshSessions, setDraft, watchServerTurn]
  );

  const clearChat = useCallback(async () => {
    const session = activeSessionRef.current;
    await api.del(`/api/chat/messages?session=${encodeURIComponent(session)}`).catch(() => undefined);
    patchMessages(session, () => EMPTY_MESSAGES);
    patchRuns(session, () => EMPTY_RUNS);
    patchRuntime(session, { error: '', liveTask: null, sending: false, startedAt: null });
    void refreshSessions();
  }, [patchMessages, patchRuns, patchRuntime, refreshSessions]);

  /** AI 답변·브라우저 작업 중지 (■ 중지) */
  const stop = useCallback(async () => {
    const id = activeSessionRef.current;
    // 복구 대기 중이었다면 그 루프부터 멈춘다(사용자가 중지했으니 더 기다리지 않는다).
    recoveryTokenRef.current += 1;
    patchRuntime(id, { sending: false, recovering: false, liveTask: null, startedAt: null, error: '' });
    await api.post('/api/chat/stop', { session: id }).catch(() => undefined);
    window.setTimeout(() => void loadMessages(id), 500);
    void refreshSessions();
  }, [loadMessages, patchRuntime, refreshSessions]);

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

  /**
   * v0.6.18: 승인 카드 — [승인]은 서버가 그 도구를 실제로 실행하고 결과를 채팅에 남긴다.
   * 실행 뒤에는 대화를 다시 불러와 결과 말풍선을 바로 보여 준다.
   */
  const approveTask = useCallback(
    async (id: string) => {
      try {
        await api.post(`/api/approvals/${id}/approve`);
        setApprovals((prev) => prev.filter((r) => r.id !== id));
        await loadMessages();
        return { ok: true };
      } catch (err) {
        setApprovals((prev) => prev.filter((r) => r.id !== id));
        await loadMessages();
        return { ok: false, message: err instanceof Error ? err.message : '승인한 작업을 실행하지 못했습니다.' };
      }
    },
    [loadMessages]
  );

  const cancelApproval = useCallback(async (id: string) => {
    await api.post(`/api/approvals/${id}/cancel`).catch(() => undefined);
    setApprovals((prev) => prev.filter((r) => r.id !== id));
    await loadMessages();
  }, [loadMessages]);

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
      turnStart,
      error,
      aiReady,
      loginRequests,
      unlockRequests,
      approvals,
      approveTask,
      cancelApproval,
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
      immersive,
      setImmersive,
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
      turnStart,
      error,
      aiReady,
      loginRequests,
      unlockRequests,
      approvals,
      approveTask,
      cancelApproval,
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
      immersive,
      setImmersive,
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
