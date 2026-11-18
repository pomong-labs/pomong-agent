import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCheck, Mic, Paperclip, Send, Sparkles } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import Mascot, { type MascotName } from '../components/Mascot';
import ModelBar from '../components/ModelBar';
import { StatsCard, TasksCard } from '../components/Cards';
import { type ChatMessage } from '../lib/api';
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
  } = useAppStore();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);

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
            ) : (
              <AssistantBubble key={m.id} message={m} character={profile.character} agentName={profile.agentName} />
            )
          )}

          {sending ? (
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

function AssistantBubble({ message, character, agentName }: { message: ChatMessage; character: string; agentName: string }) {
  const { models } = useAppStore();
  const answeredModel = message.model ? message.model.split(':').slice(-1)[0] : '';
  const answeredLabel = answeredModel ? models?.labels?.[answeredModel] || answeredModel : '';
  return (
    <div className="flex items-start gap-2.5 animate-fade-up lg:gap-3.5">
      <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FFF0F5] ring-1 ring-[#FFE4EE] sm:flex lg:h-11 lg:w-11">
        <Mascot name={character as MascotName} hero size={26} />
      </div>
      <div className="min-w-0 max-w-[92%] rounded-[24px] bg-white p-4 shadow-card ring-1 ring-[#F6F4FB] sm:max-w-[86%] sm:p-5 lg:max-w-[640px]">
        <RichText text={message.content} />
        {message.meta?.type === 'server_stats' && message.meta.stats ? <StatsCard stats={message.meta.stats} /> : null}
        {message.meta?.type === 'tasks' && message.meta.tasks ? <TasksCard tasks={message.meta.tasks} /> : null}
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
