import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bell, CheckCheck, Mic, MoreVertical, Paperclip, RotateCcw, Send, Sparkles } from 'lucide-react';
import Mascot from '../components/Mascot';
import { StatsCard, TasksCard } from '../components/Cards';
import { api, ApiError, type ChatMessage, type SystemStats } from '../lib/api';
import { formatClock } from '../lib/format';
import { t } from '../lib/i18n';

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [aiReady, setAiReady] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .get<{ messages: ChatMessage[] }>('/api/chat/messages')
      .then((r) => setMessages(r.messages))
      .catch(() => undefined);
    api
      .get<{ aiConfigured: boolean }>('/api/auth/me')
      .then((r) => setAiReady(r.aiConfigured))
      .catch(() => undefined);
    const load = () =>
      api
        .get<{ stats: SystemStats }>('/api/monitor/stats')
        .then((r) => setStats(r.stats))
        .catch(() => undefined);
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    setError('');
    setSending(true);
    setInput('');
    const optimistic: ChatMessage = {
      id: -Date.now(),
      role: 'user',
      content,
      meta: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await api.post<{ message: ChatMessage }>('/api/chat/messages', { message: content });
      setMessages((prev) => [...prev, res.message]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_provider') setAiReady(false);
      setError(err instanceof Error ? err.message : '응답을 받지 못했습니다.');
    } finally {
      setSending(false);
    }
  };

  const clearChat = async () => {
    if (!window.confirm('대화 기록을 모두 지울까요?')) return;
    await api.del('/api/chat/messages').catch(() => undefined);
    setMessages([]);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-[#F4F2FA] px-4 py-3.5 lg:gap-4 lg:px-10 lg:py-6">
        <div className="relative shrink-0">
          <div className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-white shadow-[0_6px_18px_rgba(120,100,200,0.14)] ring-1 ring-[#F4F0FF] lg:h-[62px] lg:w-[62px]">
            <Mascot name="pimong" hero size={44} className="lg:hidden" />
            <Mascot name="pimong" hero size={52} className="hidden lg:block" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[21px] font-bold tracking-[-0.02em] lg:text-[26px]">Pomong</h1>
          </div>
          <div className="mt-1 hidden items-center gap-1.5 text-[13.5px] font-medium text-[#8A8A9A] lg:flex">
            <span className="h-2 w-2 rounded-full bg-[#22C55E]" />
            {t.status.online} · <span className="text-[#12B886]">{t.status.standby}</span>
          </div>
          <div className="mt-1 lg:hidden">
            <MobileStatusPill stats={stats} />
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-xl p-2.5 text-[#6B677A] transition hover:bg-[#F7F5FF]" onClick={clearChat} aria-label="대화 지우기">
            <RotateCcw size={19} />
          </button>
          <button className="hidden rounded-xl p-2.5 text-[#6B677A] transition hover:bg-[#F7F5FF] lg:block" aria-label="알림">
            <Bell size={20} />
          </button>
          <button className="rounded-xl p-2.5 text-[#6B677A] transition hover:bg-[#F7F5FF]" aria-label="더보기">
            <MoreVertical size={20} />
          </button>
        </div>
      </header>

      {/* messages */}
      <div ref={scrollRef} className="pa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-10 lg:py-8">
        <div className="mx-auto w-full max-w-[880px] space-y-5 lg:space-y-6">
          {!aiReady ? (
            <div className="rounded-2xl border border-[#FFE7C7] bg-[#FFF9F0] px-4 py-3.5 text-[13.5px] text-[#A9762A]">
              AI Provider가 연결되지 않았어요. 설정에서 API 키를 연결하면 대화할 수 있습니다.
            </div>
          ) : null}

          {messages.length === 0 ? <EmptyState onPick={(t) => send(t)} /> : null}

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
              <div key={m.id} className="flex items-start gap-2.5 animate-fade-up lg:gap-3.5">
                <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FFF0F5] ring-1 ring-[#FFE4EE] sm:flex lg:h-11 lg:w-11">
                  <Mascot name="pimong" hero size={26} />
                </div>
                <div className="min-w-0 max-w-[92%] rounded-[24px] bg-white p-4 shadow-card ring-1 ring-[#F6F4FB] sm:max-w-[86%] sm:p-5 lg:max-w-[640px]">
                  <RichText text={m.content} />
                  {m.meta?.type === 'server_stats' && m.meta.stats ? <StatsCard stats={m.meta.stats} /> : null}
                  {m.meta?.type === 'tasks' && m.meta.tasks ? <TasksCard tasks={m.meta.tasks} /> : null}
                  <div className="mt-2.5 flex items-center gap-1 text-[11.5px] text-[#C0BCCD]">{formatClock(m.createdAt)}</div>
                </div>
              </div>
            )
          )}

          {sending ? (
            <div className="flex items-start gap-2.5 lg:gap-3.5">
              <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FFF0F5] ring-1 ring-[#FFE4EE] sm:flex lg:h-11 lg:w-11">
                <Mascot name="pimong-think" size={26} />
              </div>
              <div className="flex items-center gap-1.5 rounded-[24px] bg-white px-5 py-4 shadow-card ring-1 ring-[#F6F4FB]">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
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
      <div className="px-3 pb-2 pt-1 lg:px-10 lg:pb-7 lg:pt-2">
        <div className="mx-auto w-full max-w-[860px]">
          <div className="rounded-[24px] border border-[#EEEDF5] bg-white p-2.5 shadow-[0_10px_30px_rgba(90,80,160,0.08)] lg:p-3">
            <div className="flex items-end gap-2">
              <button
                className="mb-0.5 hidden h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[#EFEDF6] text-[#8A8A9A] transition hover:bg-[#FAF9FF] sm:flex"
                title="파일 첨부 (v0.2에서 지원)"
                aria-label="첨부"
              >
                <Paperclip size={19} />
              </button>
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(140, el.scrollHeight)}px`;
                }}
                onKeyDown={onKeyDown}
                placeholder={aiReady ? '피몽에게 물어보세요…' : 'AI 키를 먼저 연결해 주세요'}
                className="pa-scroll max-h-[140px] min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2.5 text-[15px] leading-relaxed placeholder:text-[#B7B4C6] focus:outline-none"
              />
              <button
                className="mb-0.5 hidden h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#EFEDF6] text-[#8A8A9A] sm:flex"
                title="음성 입력 (v0.3에서 지원)"
                aria-label="음성"
              >
                <Mic size={18} />
              </button>
              <button
                className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow-float transition active:scale-95 disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg,#A88BFF,#8B72F8)' }}
                onClick={() => send()}
                disabled={sending || !input.trim()}
                aria-label="보내기"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
          <p className="mt-2 hidden text-center text-[11.5px] text-[#C0BCCD] lg:block">
            응답은 선택한 Provider에 저장된 API 키로 생성됩니다 · Enter 전송 / Shift+Enter 줄바꿈
          </p>
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

function MobileStatusPill({ stats }: { stats: SystemStats | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EAFBF1] px-2.5 py-1 text-[12px] font-semibold text-[#12B886]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E]" />
      {t.common.cpu} {stats ? Math.round(stats.cpu) : '–'}% · {stats?.status === 'healthy' ? t.status.healthy : t.status.checkNeeded}
    </span>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const picks = ['지금 서버 상태 어때?', '오늘 할 일 알려줘', '이 서버에 대해 알려줘'];
  return (
    <div className="flex flex-col items-center gap-5 pt-6 text-center lg:pt-16">
      <div className="relative">
        <div className="absolute inset-0 -z-10 rounded-full bg-[#FFEAF1] blur-2xl" />
        <Mascot name="pimong-cheer" size={120} className="animate-float" />
      </div>
      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.02em] lg:text-[26px]">안녕하세요, 저는 포몽이에요!</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-pomong-sub lg:text-[15px]">
          서버 상태부터 오늘 할 일까지, 무엇이든 편하게 물어보세요.
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
    </div>
  );
}
