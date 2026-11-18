import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, CheckCheck, CheckCircle2, ChevronDown, CircleDashed, Clock3, Globe, KeyRound, Loader2, Mic, Paperclip, Send, ShieldCheck, Sparkles, X, XCircle } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import Mascot, { type MascotName } from '../components/Mascot';
import ModelBar from '../components/ModelBar';
import { StatsCard, TasksCard } from '../components/Cards';
import { type ChatMessage, type LoginRequest, type TaskRun } from '../lib/api';
import { formatClock } from '../lib/format';
import { useAppStore } from '../lib/store';

function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={`${keyPrefix}-b-${i}`} className="font-semibold text-[#1F1D2B]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={`${keyPrefix}-c-${i}`} className="rounded-md bg-[#F5F3FB] px-1.5 py-0.5 font-mono text-[13px] text-[#7C63F6]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-t-${i}`}>{part}</span>;
  });
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-1.5 text-[15px] leading-[1.75] text-[#2A2A35] sm:text-[16px]">
      {text.split('\n').map((line, i) => {
        const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#C9B8FF]" />
              <span className="flex-1">{renderInline(bullet[1], `l${i}`)}</span>
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <p key={i}>{renderInline(line, `p${i}`)}</p>;
      })}
    </div>
  );
}

export default function Chat() {
  const {
    messages,
    sending,
    error,
    aiReady,
    send,
    clearChat,
    draft,
    setDraft,
    profile,
    keyboardOpen,
    visibleState,
    liveTask,
    taskRuns,
    loginRequests,
    vault,
    submitLoginCard,
    dismissLoginCard,
  } = useAppStore();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);

  /** 작업 카드는 실제 도구가 한 번이라도 돈 경우에만 보여 준다(빈 0단계 카드 숨김). */
  const hasWork = (run: TaskRun | null | undefined): run is TaskRun =>
    Boolean(run && ((run.items?.length || 0) > 0 || run.steps > 0));
  const shownRuns = taskRuns.filter((r) => hasWork(r));
  const shownLive = hasWork(liveTask) ? liveTask : null;
  const requestsOf = (messageId: number) => loginRequests.filter((r) => r.messageId === messageId);
  const floatingRequests = loginRequests.filter((r) => !r.messageId);

  /** 대화 목록을 맨 아래(최신 메시지)에 붙인다. */
  const pinToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollHeight - el.clientHeight;
    if (behavior === 'smooth') el.scrollTo({ top, behavior });
    else el.scrollTop = top;
  }, []);

  // 새 메시지/응답 대기 → 맨 아래로. (이미지·폰트가 늦게 로드돼 높이가 늘어나는 경우 한 번 더)
  useEffect(() => {
    pinToBottom('smooth');
    const raf = requestAnimationFrame(() => pinToBottom('auto'));
    const t = window.setTimeout(() => pinToBottom('auto'), 140);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [messages, sending, pinToBottom]);

  // 키보드가 열리거나 닫힐 때: 셸 높이가 줄어드는 동안 스크롤이 위로 튀지 않게 즉시 고정하고,
  // 키보드 애니메이션이 끝날 때까지 몇 번 더 붙인다.
  useEffect(() => {
    pinToBottom('auto');
    const raf = requestAnimationFrame(() => pinToBottom('auto'));
    const timers = [80, 180, 320, 480].map((ms) => window.setTimeout(() => pinToBottom('auto'), ms));
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [keyboardOpen, pinToBottom]);

  const submit = () => {
    if (!draft.trim() || sending) return;
    void send(draft);
  };

  const onClear = () => {
    if (!window.confirm('대화 기록을 모두 지울까요?')) return;
    void clearChat();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const pendingLabel = visibleState === 'working' ? '포몽이 작업 중…' : '포몽이 생각 중…';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppHeader onClear={onClear} onMore={() => navigate('/more')} />

      {/* messages */}
      <div ref={scrollRef} className="pa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-10 lg:py-8">
        <div className="mx-auto w-full max-w-[880px] space-y-5 lg:space-y-6">
          {!aiReady ? (
            <div className="flex items-start gap-3 rounded-2xl border border-[#FFE7C7] bg-[#FFF9F0] px-4 py-3.5 text-[13.5px] text-[#A9762A]">
              <span className="min-w-0 flex-1">선택한 AI의 키가 아직 연결되지 않았어요. 아래 모델 바에서 다른 모델을 고르거나 설정에서 키를 연결해 주세요.</span>
              <button className="shrink-0 rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-[#A9762A] ring-1 ring-[#F3DFC0]" onClick={() => navigate('/settings')}>
                설정
              </button>
            </div>
          ) : null}

          {messages.length === 0 ? <EmptyState agentName={profile.agentName} character={profile.character} onPick={(t) => void send(t)} /> : null}

          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex flex-col items-end gap-1.5 animate-fade-up">
                <div className="flex max-w-[85%] items-end gap-2.5">
                  <div
                    className="rounded-[22px] rounded-br-lg px-4 py-3 text-[15px] leading-relaxed text-[#2A2A35] shadow-[0_2px_10px_rgba(120,100,200,0.05)] sm:text-[16px]"
                    style={{ background: 'linear-gradient(135deg,#EFE8FF,#E7DFFC)' }}
                  >
                    {m.content}
                  </div>
                  <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#EDE7FC] text-[#8B72F6] sm:flex">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                      <circle cx="12" cy="8.5" r="3.6" />
                      <path d="M4.8 20c.6-3.7 3.6-5.7 7.2-5.7s6.6 2 7.2 5.7" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 pr-1 text-[12px] text-[#A8A5B8]">
                  {formatClock(m.createdAt)}
                  <CheckCheck size={13} className="text-[#B9A8FF]" />
                </div>
              </div>
            ) : m.meta?.type === 'notice' ? (
              <NoticeBubble key={m.id} message={m} character={profile.character} />
            ) : (
              <AssistantBubble
                key={m.id}
                message={m}
                character={profile.character}
                agentName={profile.agentName}
                taskRun={shownRuns.find((r) => r.messageId === m.id) || null}
                loginRequests={requestsOf(m.id)}
                vault={vault}
                onLoginSubmit={submitLoginCard}
                onLoginDismiss={dismissLoginCard}
              />
            )
          )}

          {/* 아직 답변 말풍선이 붙지 않은 로그인 카드(이번 턴 진행 중) */}
          {floatingRequests.map((request) => (
            <LoginCard
              key={request.id}
              request={request}
              vault={vault}
              onSubmit={submitLoginCard}
              onDismiss={dismissLoginCard}
            />
          ))}

          {sending ? (
            <div className="space-y-2.5">
              {shownLive ? <TaskCard run={shownLive} live /> : null}
              <div className="flex items-start gap-2.5 lg:gap-3.5">
              <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FFF0F5] ring-1 ring-[#FFE4EE] sm:flex lg:h-11 lg:w-11">
                <Mascot name="pimong-think" size={26} />
              </div>
              <div className="flex items-center gap-3 rounded-[24px] bg-white px-5 py-4 shadow-card ring-1 ring-[#F6F4FB]">
                <span className="flex items-center gap-1.5">
                  <Dot delay="0ms" />
                  <Dot delay="150ms" />
                  <Dot delay="300ms" />
                </span>
                <span className="text-[12.5px] font-medium text-[#9B98AB]">{pendingLabel}</span>
              </div>
            </div>
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-3 rounded-2xl bg-[#FFF1F1] px-4 py-3.5">
              <Mascot name="pimong-surprised" size={40} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-[#E5484D]">앗, 응답을 받지 못했어요</p>
                <p className="mt-1 break-words text-[13px] font-medium leading-relaxed text-[#C25459]">{error}</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* composer */}
      <div className={`shrink-0 px-3 pt-1 lg:px-10 ${keyboardOpen ? 'pb-1.5' : 'pb-2 lg:pb-6'}`}>
        <div className="mx-auto w-full max-w-[860px]">
          <div className="mb-1.5 px-0.5">
            <ModelBar />
          </div>
          <div className={`rounded-[24px] border border-[#EEEDF5] bg-white shadow-[0_10px_30px_rgba(90,80,160,0.08)] ${keyboardOpen ? 'p-1.5' : 'p-2.5 lg:p-3'}`}>
            <div className="flex items-end gap-2">
              <button
                className="mb-0.5 hidden h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[#EFEDF6] text-[#8A8A9A] transition hover:bg-[#FAF9FF] sm:flex"
                title="파일 첨부 (준비 중)"
                aria-label="첨부"
              >
                <Paperclip size={19} />
              </button>
              <textarea
                rows={1}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(140, el.scrollHeight)}px`;
                }}
                onKeyDown={onKeyDown}
                onFocus={() => {
                  // 키보드가 올라오기 시작한 직후에도 최신 메시지가 가려지지 않게
                  pinToBottom('auto');
                  window.setTimeout(() => pinToBottom('auto'), 260);
                }}
                enterKeyHint="send"
                placeholder={aiReady ? `${profile.agentName || '포몽'}에게 물어보세요…` : 'AI 키를 먼저 연결해 주세요'}
                className="pa-scroll max-h-[140px] min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2.5 text-[16px] leading-relaxed placeholder:text-[#B7B4C6] focus:outline-none"
              />
              <button
                className="mb-0.5 hidden h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#EFEDF6] text-[#8A8A9A] sm:flex"
                title="음성 입력 (준비 중)"
                aria-label="음성"
              >
                <Mic size={18} />
              </button>
              <button
                className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow-float transition active:scale-95 disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg,#A88BFF,#8B72F8)' }}
                onClick={submit}
                disabled={sending || !draft.trim()}
                aria-label="보내기"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
          {!keyboardOpen ? (
            <p className="mt-2 hidden text-center text-[11.5px] text-[#C0BCCD] lg:block">
              Enter 전송 / Shift+Enter 줄바꿈 · 선택한 모델로 응답합니다
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BrowserCard({ sessionId }: { sessionId: string | null }) {
  const navigate = useNavigate();
  if (!sessionId) return null;
  return (
    <button
      onClick={() => navigate('/browser')}
      className="mt-2.5 flex w-full items-center gap-3 rounded-[16px] bg-[#F7F5FF] px-3.5 py-3 text-left ring-1 ring-[#EAE3FF] transition active:scale-[0.99]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-[#7C63F6] shadow-sm">
        <Globe size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-bold text-[#3A2F7A]">브라우저 화면 보기</span>
        <span className="block text-[11.5px] text-[#8A8A9A]">AI가 연 화면을 그대로 보고, 로그인·결제는 직접 할 수 있어요.</span>
      </span>
      <span className="shrink-0 text-[12px] font-bold text-[#7C63F6]">열기 →</span>
    </button>
  );
}

function AssistantBubble({
  message,
  character,
  agentName,
  taskRun,
  loginRequests = [],
  vault,
  onLoginSubmit,
  onLoginDismiss,
}: {
  message: ChatMessage;
  character: string;
  agentName: string;
  taskRun?: TaskRun | null;
  loginRequests?: LoginRequest[];
  vault: { configured: boolean; unlocked: boolean };
  onLoginSubmit: (id: string, input: { username: string; password: string; masterPin?: string }) => Promise<{ ok: boolean; message?: string }>;
  onLoginDismiss: (id: string) => Promise<void>;
}) {
  const { models } = useAppStore();
  const answeredModel = message.model ? message.model.split(':').slice(-1)[0] : '';
  const answeredLabel = answeredModel ? models?.labels?.[answeredModel] || answeredModel : '';
  return (
    <div className="flex items-start gap-2.5 animate-fade-up lg:gap-3.5">
      <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FFF0F5] ring-1 ring-[#FFE4EE] sm:flex lg:h-11 lg:w-11">
        <Mascot name={character as MascotName} hero size={26} />
      </div>
      <div className="min-w-0 max-w-[92%] sm:max-w-[86%] lg:max-w-[640px]">
        {taskRun ? <TaskCard run={taskRun} /> : null}
        <div className="rounded-[24px] bg-white p-4 shadow-card ring-1 ring-[#F6F4FB] sm:p-5">
        <RichText text={message.content} />
        {message.meta?.type === 'server_stats' && message.meta.stats ? <StatsCard stats={message.meta.stats} /> : null}
        {message.meta?.type === 'tasks' && message.meta.tasks ? <TasksCard tasks={message.meta.tasks} /> : null}
        {message.meta?.type === 'browser' ? <BrowserCard sessionId={message.meta.browserSession || null} /> : null}
        {loginRequests.map((request) => (
          <LoginCard
            key={request.id}
            request={request}
            vault={vault}
            onSubmit={onLoginSubmit}
            onDismiss={onLoginDismiss}
          />
        ))}
        <div className="mt-2.5 flex items-center gap-1 text-[11.5px] text-[#C0BCCD]">
          {formatClock(message.createdAt)}
          {answeredLabel ? (
            <span className="ml-1 rounded-full bg-[#FAF9FD] px-1.5 py-0.5 text-[10.5px] font-medium text-[#B4B1C2]" title="실제 응답한 모델">
              {answeredLabel}
            </span>
          ) : null}
          {message.meta?.tools?.length ? (
            <span className="ml-1 rounded-full bg-[#F7F5FF] px-1.5 py-0.5 text-[10.5px] font-medium text-[#9B98AB]">
              도구 {message.meta.tools.length}회
            </span>
          ) : null}
          <span className="sr-only">{agentName}</span>
        </div>
        </div>
      </div>
    </div>
  );
}

/** 작업 중 먼저 도착하는 짧은 안내 말풍선(chat_notify) */
function NoticeBubble({ message, character }: { message: ChatMessage; character: string }) {
  return (
    <div className="flex items-start gap-2.5 animate-fade-up lg:gap-3.5">
      <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F1ECFF] ring-1 ring-[#EAE3FF] sm:flex lg:h-11 lg:w-11">
        <Mascot name={character as MascotName} size={24} />
      </div>
      <div className="min-w-0 max-w-[88%] rounded-[20px] rounded-tl-md bg-[#F8F5FF] px-4 py-3 ring-1 ring-[#EFE7FF] sm:max-w-[76%]">
        <p className="text-[14.5px] leading-[1.65] text-[#4B3FA6]">{message.content}</p>
        <span className="mt-1 block text-[11px] text-[#B4A9DA]">{formatClock(message.createdAt)}</span>
      </div>
    </div>
  );
}

/** 채팅 안에서 계정을 받는 보안 로그인 카드 (v0.5.1) */
function LoginCard({
  request,
  vault,
  onSubmit,
  onDismiss,
}: {
  request: LoginRequest;
  vault: { configured: boolean; unlocked: boolean };
  onSubmit: (id: string, input: { username: string; password: string; masterPin?: string }) => Promise<{ ok: boolean; message?: string }>;
  onDismiss: (id: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitted = request.status === 'submitted';
  const needsPin = !vault.unlocked;

  const submit = async () => {
    if (busy) return;
    if (!username.trim() || !password) {
      setError('아이디와 비밀번호를 모두 입력해 주세요.');
      return;
    }
    if (needsPin && !/^\d{4,12}$/.test(pin.trim())) {
      setError(vault.configured ? '금고 PIN을 입력해 주세요.' : '금고를 만들 PIN(4~12자리 숫자)을 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    const res = await onSubmit(request.id, {
      username: username.trim(),
      password,
      masterPin: pin.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || '저장하지 못했어요.');
      return;
    }
    // 저장되면 화면에서도 바로 지운다.
    setPassword('');
    setPin('');
  };

  if (submitted) {
    return (
      <div className="mt-2.5 flex items-center gap-2.5 rounded-[16px] bg-[#EAFBF1] px-3.5 py-2.5 ring-1 ring-[#D6F3E3] animate-fade-up">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-[#0F9668]">
          <Check size={15} strokeWidth={3} />
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[#0B7B57]">
          <b>{request.service}</b> 계정을 금고에 암호화 저장했어요. 이어서 로그인하는 중…
        </p>
        <Loader2 size={14} className="shrink-0 animate-spin text-[#0F9668]" />
      </div>
    );
  }

  return (
    <div className="mt-2.5 overflow-hidden rounded-[18px] bg-[#FBFAFF] ring-1 ring-[#E7DFFF] animate-fade-up">
      <div className="flex items-center gap-2.5 border-b border-[#EFE9FF] px-3.5 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white text-[#7C63F6] shadow-sm">
          <KeyRound size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-bold text-[#3A2F7A]">{request.service} 로그인 정보</span>
          <span className="block truncate text-[11px] text-[#8A82B8]">{request.siteHost || request.loginUrl}</span>
        </span>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#A8A5B8] transition hover:bg-white"
          onClick={() => void onDismiss(request.id)}
          aria-label="카드 닫기"
        >
          <X size={15} />
        </button>
      </div>

      <div className="space-y-2 px-3.5 py-3">
        {request.note ? <p className="text-[11.5px] leading-relaxed text-[#7E78A8]">{request.note}</p> : null}
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold text-[#5B5866]">아이디 / 이메일</span>
          <input
            className="w-full rounded-xl border border-[#E7E5F0] bg-white px-3 py-2.5 text-[15px] text-[#2A2A35] outline-none focus:border-[#C9B8FF]"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="example@email.com"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="email"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold text-[#5B5866]">비밀번호</span>
          <input
            className="w-full rounded-xl border border-[#E7E5F0] bg-white px-3 py-2.5 text-[15px] text-[#2A2A35] outline-none focus:border-[#C9B8FF]"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호"
            autoComplete="current-password"
          />
        </label>
        {needsPin ? (
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-semibold text-[#5B5866]">
              {vault.configured ? '금고 PIN' : '금고 PIN 만들기 (4~12자리 숫자)'}
            </span>
            <input
              className="w-full rounded-xl border border-[#E7E5F0] bg-white px-3 py-2.5 text-[15px] text-[#2A2A35] outline-none focus:border-[#C9B8FF]"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
              placeholder={vault.configured ? '금고 잠금을 풀 PIN' : '새 금고 PIN'}
              inputMode="numeric"
              autoComplete="off"
            />
          </label>
        ) : null}

        {error ? <p className="text-[11.5px] font-medium text-[#E5484D]">{error}</p> : null}

        <button
          className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[13.5px] font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg,#A88BFF,#8B72F8)' }}
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
          {busy ? '저장하는 중…' : '저장하고 로그인하기'}
        </button>
        <p className="flex items-start gap-1 text-[10.5px] leading-relaxed text-[#A8A5B8]">
          <ShieldCheck size={11} className="mt-0.5 shrink-0" />
          비밀번호는 암호화되어 서버 금고에만 저장되고 대화 기록에는 남지 않아요. 저장하면 제가 바로 로그인해 드려요.
        </p>
      </div>
    </div>
  );
}

/** 채팅 말풍선에 붙는 실시간 작업 카드 */
function TaskCard({ run, live = false }: { run: TaskRun; live?: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  const meta =
    run.status === 'running'
      ? { label: '진행 중', color: '#7C63F6', bg: '#F1ECFF' }
      : run.status === 'failed'
        ? { label: '실패', color: '#E5484D', bg: '#FFF1F1' }
        : run.status === 'partial'
          ? { label: '일부 완료', color: '#C08A16', bg: '#FFF8E7' }
          : { label: '완료', color: '#0F9668', bg: '#EAFBF1' };
  const seconds = run.items.reduce((sum, item) => sum + (item.durationMs || 0), 0) / 1000;
  return (
    <div className="mb-2 overflow-hidden rounded-[18px] bg-white/95 shadow-[0_4px_14px_rgba(90,80,160,0.06)] ring-1 ring-[#EFEBFA]">
      <button className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#F5F1FF] text-[#7C63F6]">
          {run.status === 'running' ? (
            <CircleDashed size={15} className="animate-spin" />
          ) : run.status === 'failed' ? (
            <XCircle size={15} />
          ) : (
            <CheckCircle2 size={15} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-bold text-[#3B3947]">{run.title}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-[#A8A5B8]">
            <Clock3 size={10} /> {run.steps}단계{seconds > 0 ? ` · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}초` : ''}
          </span>
        </span>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: meta.bg, color: meta.color }}>
          {meta.label}
        </span>
        <ChevronDown size={14} className={`shrink-0 text-[#B4B1C2] transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="space-y-1 border-t border-[#F4F2FA] px-3 py-2">
          {run.items.map((item) => (
            <div key={item.id} className="flex items-start gap-2">
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  item.status === 'running' ? 'bg-[#B9A8FF]' : item.status === 'failed' ? 'bg-[#F76A6A]' : 'bg-[#9FDCC4]'
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] font-semibold text-[#5B5866]">
                  {item.label}
                  <span className="ml-1.5 font-normal text-[#B4B1C2]">
                    {item.durationMs !== null ? `${(item.durationMs / 1000).toFixed(1)}초` : '…'}
                  </span>
                </p>
                {item.summary ? <p className="truncate text-[11px] text-[#9B98AB]">{item.summary}</p> : null}
              </div>
            </div>
          ))}
          {!run.items.length ? <p className="text-[11.5px] text-[#B4B1C2]">도구를 준비하는 중…</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-2 w-2 animate-bounce rounded-full bg-[#D8CDF7]"
      style={{ animationDelay: delay, animationDuration: '1s' }}
    />
  );
}

function EmptyState({ agentName, character, onPick }: { agentName: string; character: string; onPick: (text: string) => void }) {
  const picks = [`${agentName || '너'}는 뭘 할 수 있어?`, '오늘 할 일 알려줘', '지금 서버 상태 어때?', '내일 오후 3시에 약 먹기 추가해줘'];
  return (
    <div className="flex flex-col items-center gap-5 pt-6 text-center lg:pt-14">
      <div className="relative">
        <div className="absolute inset-0 -z-10 rounded-full bg-[#FFEAF1] blur-2xl" />
        <Mascot name="pimong-cheer" size={116} className="animate-float" />
      </div>
      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.02em] lg:text-[26px]">
          안녕하세요, 저는 {agentName || '포몽'}이에요!
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-pomong-sub lg:text-[15px]">
          할 일 정리부터 서버 상태, 금고 목록까지 편하게 물어보세요.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {picks.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="flex items-center gap-1.5 rounded-full border border-[#EDEAF7] bg-white px-4 py-2.5 text-[13.5px] font-medium text-[#5B5866] shadow-[0_2px_10px_rgba(90,80,160,0.05)] transition hover:border-[#D9D0F8] hover:bg-[#FBFAFF]"
          >
            <Sparkles size={14} className="text-[#B9A8FF]" />
            {p}
          </button>
        ))}
      </div>
      <span className="sr-only">{character}</span>
    </div>
  );
}
