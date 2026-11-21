import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, Loader2, Lock, Mic, Rocket, Send, Sparkles, X } from 'lucide-react';
import Mascot, { brandLogoUrl, type MascotName } from '../components/Mascot';
import { api, ApiError, type PublicCardInfo } from '../lib/api';
import { applyTheme } from '../lib/theme';
import { dictationErrorMessage, dictationSupported, dictationUnsupportedMessage, startDictation, type DictationHandle } from '../lib/speech';

/**
 * v0.7.2 — 공개 명함 방문자 화면 (`/c/<slug>`, 커스텀 도메인 루트)
 *
 * 주인 앱과 완전히 분리된 게스트 전용 단일 화면이다.
 *  · 사이드바 · 하단 5탭바 · 모델 선택바 · 첨부 클립 · 설정 진입점이 없다.
 *  · 서버는 이 화면에서 부르는 `/api/public/card/*` 만 허용하고,
 *    주인 API 는 인증이 필요하다(커스텀 도메인에서는 404).
 *  · 손님이 남긴 이름·연락처는 이 대화를 정리해 주인에게 전달하는 데만 쓴다.
 */

interface Bubble {
  role: 'user' | 'assistant';
  content: string;
  notice?: boolean;
}

type Phase = 'loading' | 'error' | 'pin' | 'ready';

export default function GuestCard() {
  const { slug = '' } = useParams();
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState('');
  const [card, setCard] = useState<PublicCardInfo | null>(null);
  const [pass, setPass] = useState<string>(() => readStore(`pomong.cardPass.${slug}`) || '');
  const [sessionId, setSessionId] = useState<string>(() => readStore(`pomong.cardSession.${slug}`) || '');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** 이번 세션에서 이미 쓴 턴 수 — 새로고침해도 유지(서버가 최종 판단) */
  const [usedTurns, setUsedTurns] = useState(0);
  const [composerNote, setComposerNote] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const dictationRef = useRef<DictationHandle | null>(null);
  const dictationBaseRef = useRef('');
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 새로고침 뒤 서버에 남아 있는 내 대화를 한 번만 되살린다 */
  const restoredRef = useRef(false);

  const turnsLimit = card?.turnsLimit || 20;
  const turnsLeft = Math.max(0, turnsLimit - usedTurns);
  const closed = Boolean(card && (!card.enabled || card.expired || card.dailyExhausted));
  const reachedLimit = turnsLeft <= 0;

  /* 공개 정보 불러오기 ------------------------------------------------ */
  useEffect(() => {
    let alive = true;
    setPhase('loading');
    api
      .get<{ card: PublicCardInfo }>(`/api/public/card/${encodeURIComponent(slug)}`)
      .then((res) => {
        if (!alive) return;
        setCard(res.card);
        setPhase(res.card.pinRequired && !readStore(`pomong.cardPass.${slug}`) ? 'pin' : 'ready');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof ApiError ? err.message : '명함을 불러오지 못했어요.');
        setPhase('error');
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  /* 테마 — 손님 기기 설정(라이트/다크)을 따르고, 포인트 컬러는 이 명함 캐릭터 색 */
  useEffect(() => {
    applyTheme({ theme: 'system', accentMode: 'character', accentColor: '#8B72F8', character: card?.character || 'pimong' });
  }, [card?.character]);

  useEffect(() => {
    document.title = card ? `${card.title} · ${card.agentName}` : 'Pomong Agent';
  }, [card]);

  /* 새로고침해도 이 브라우저의 대화는 이어서 보인다(세션 id 는 이 기기에만 있다) */
  useEffect(() => {
    if (phase !== 'ready' || !sessionId || restoredRef.current) return;
    restoredRef.current = true;
    const saved = sessionId;
    api
      .get<{ turnCount: number; status: string; messages: { role: 'user' | 'assistant'; content: string }[] }>(
        `/api/public/card/${encodeURIComponent(slug)}/session/${encodeURIComponent(saved)}`
      )
      .then((res) => {
        if (res.messages.length) setBubbles(res.messages.map((m) => ({ role: m.role, content: m.content })));
        setUsedTurns(res.turnCount);
      })
      .catch(() => {
        // 서버에서 사라진 세션이면 조용히 새 대화로 시작한다.
        writeStore(`pomong.cardSession.${slug}`, '');
      });
  }, [phase, sessionId, slug]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [bubbles, sending]);

  const greeting = useMemo(() => {
    if (!card) return '';
    const bio = card.bioText.trim().split('\n')[0]?.trim() || '';
    if (bio) return bio.length > 90 ? `${bio.slice(0, 90)}…` : bio;
    switch (card.purpose) {
      case 'meeting':
        return '가능한 시간을 안내하고, 원하시는 일정을 받아 두었다가 전달드릴게요.';
      case 'survey':
        return '몇 가지만 여쭤보고 답을 정리해 전달드릴게요. 편하게 말씀해 주세요.';
      default:
        return '궁금한 점이나 남길 용건을 편하게 말씀해 주세요.';
    }
  }, [card]);

  const send = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || sending || !card) return;
      if (closed) {
        setComposerNote('지금은 응대가 잠시 쉬고 있어요.');
        return;
      }
      if (reachedLimit) {
        setSheetOpen(true);
        return;
      }
      setComposerNote('');
      setDraft('');
      setBubbles((prev) => [...prev, { role: 'user', content: value }]);
      setSending(true);
      try {
        const res = await api.post<{
          ok: boolean;
          sessionId?: string;
          reply?: string;
          turnsLeft?: number;
          turnsUsed?: number;
          blocked?: boolean;
          code?: string;
          message?: string;
        }>(`/api/public/card/${encodeURIComponent(slug)}/chat`, {
          sessionId: sessionId || undefined,
          message: value,
          pass: pass || undefined,
        });
        if (res.sessionId) {
          setSessionId(res.sessionId);
          writeStore(`pomong.cardSession.${slug}`, res.sessionId);
        }
        if (typeof res.turnsUsed === 'number') setUsedTurns(res.turnsUsed);
        else if (typeof res.turnsLeft === 'number') setUsedTurns(Math.max(0, turnsLimit - res.turnsLeft));
        if (res.reply) setBubbles((prev) => [...prev, { role: 'assistant', content: res.reply as string, notice: res.blocked }]);
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'pin_required' || err.code === 'pin_expired')) {
          setPass('');
          setPhase('pin');
          return;
        }
        const message =
          err instanceof ApiError
            ? err.message
            : '연결이 잠시 끊겼어요. 같은 내용을 다시 보내 주세요.';
        setBubbles((prev) => [...prev, { role: 'assistant', content: message, notice: true }]);
      } finally {
        setSending(false);
      }
    },
    [card, closed, pass, reachedLimit, sending, sessionId, slug, turnsLimit]
  );

  const verifyPin = async () => {
    if (!/^\d{4,12}$/.test(pin.trim()) || pinBusy) {
      setPinError('PIN은 4~12자리 숫자예요.');
      return;
    }
    setPinBusy(true);
    setPinError('');
    try {
      const res = await api.post<{ ok: boolean; pass: string }>(`/api/public/card/${encodeURIComponent(slug)}/verify-pin`, {
        pin: pin.trim(),
      });
      setPass(res.pass);
      writeStore(`pomong.cardPass.${slug}`, res.pass);
      setPin('');
      setPhase('ready');
    } catch (err) {
      setPinError(err instanceof ApiError ? err.message : 'PIN을 확인하지 못했어요.');
    } finally {
      setPinBusy(false);
    }
  };

  const toggleDictation = () => {
    if (dictationRef.current) {
      dictationRef.current.stop();
      dictationRef.current = null;
      setListening(false);
      return;
    }
    if (!dictationSupported()) {
      setComposerNote(dictationUnsupportedMessage());
      return;
    }
    dictationBaseRef.current = draft.trim();
    const handle = startDictation({
      onText: (finalText, interim) => {
        const spoken = [finalText, interim].filter(Boolean).join(' ');
        setDraft([dictationBaseRef.current, spoken].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
      },
      onError: (code, message) => {
        if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
          dictationRef.current = null;
          setListening(false);
        }
        setComposerNote(message || dictationErrorMessage(code));
      },
      onEnd: () => {
        dictationRef.current = null;
        setListening(false);
      },
    });
    if (!handle) {
      setComposerNote(dictationUnsupportedMessage());
      return;
    }
    dictationRef.current = handle;
    setListening(true);
  };

  useEffect(
    () => () => {
      dictationRef.current?.abort();
    },
    []
  );

  /* ------------------------------------------------------------------ */
  /* 화면                                                               */
  /* ------------------------------------------------------------------ */

  if (phase === 'loading') {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <Mascot name="pimong" hero size={96} className="animate-float" />
          <p className="text-[14px]" style={{ color: 'var(--pa-mute)' }}>
            명함을 펼치는 중…
          </p>
        </div>
      </Shell>
    );
  }

  if (phase === 'error' || !card) {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <Mascot name="pimong-surprised" size={96} />
          <h1 className="text-[21px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
            명함을 찾을 수 없어요
          </h1>
          <p className="max-w-[320px] text-[14px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
            {loadError || '주소가 바뀌었거나 공개가 끝난 명함이에요. 주인에게 새 링크를 받아 주세요.'}
          </p>
        </div>
      </Shell>
    );
  }

  if (phase === 'pin') {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6">
          <div className="relative">
            <div className="absolute inset-0 -z-10 rounded-full bg-[#FFEAF1] blur-2xl" />
            <Mascot name="pimong" hero size={104} className="animate-float" />
          </div>
          <div className="text-center">
            <h1 className="text-[21px] font-bold tracking-[-0.02em]" style={{ color: 'var(--pa-ink-strong)' }}>
              {card.title}
            </h1>
            <p className="mt-1.5 text-[14px]" style={{ color: 'var(--pa-mute)' }}>
              주인에게 받은 PIN을 넣어 주세요.
            </p>
          </div>
          <div className="w-full max-w-[300px] space-y-2.5">
            <div className="relative">
              <Lock size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2" style={{ color: 'var(--pa-mute-2)' }} />
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void verifyPin();
                }}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder="••••"
                aria-label="명함 PIN"
                className="pa-input py-3.5 pl-11 text-center tracking-[0.35em]"
              />
            </div>
            {pinError ? (
              <p className="text-center text-[12.5px] font-medium text-[#E5484D]" role="alert">
                {pinError}
              </p>
            ) : null}
            <button className="pa-btn-primary w-full py-3.5" onClick={() => void verifyPin()} disabled={pinBusy || pin.length < 4}>
              {pinBusy ? <Loader2 size={17} className="animate-spin" /> : <Lock size={17} />}
              {pinBusy ? '확인하는 중…' : '명함 열기'}
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  const chips = [
    ...card.quickPrompts.slice(0, 2).map((label, index) => ({
      label,
      icon: index === 0 ? Sparkles : Rocket,
      onClick: () => void send(label),
    })),
    { label: '용건 · 연락 남기기', icon: CalendarDays, onClick: () => setSheetOpen(true) },
  ];

  return (
    <Shell>
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-start gap-2 px-4 pb-2 pt-[max(env(safe-area-inset-top),16px)] lg:px-7 lg:pt-5">
        <div className="hidden min-w-0 items-center gap-2.5 lg:flex">
          <img src={brandLogoUrl()} alt="" className="h-6 w-auto dark:hidden" draggable={false} />
          <img src={brandLogoUrl(true)} alt="" className="hidden h-6 w-auto dark:block" draggable={false} />
          <span
            className="rounded-full px-2.5 py-1 text-[11.5px] font-bold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}
          >
            공개 명함
          </span>
        </div>

        <div className="col-start-2 flex flex-col items-center">
          <div className="relative">
            <span
              className="pointer-events-none absolute rounded-full border"
              style={{ inset: -4, borderColor: 'color-mix(in srgb, var(--pa-line) 55%, transparent)' }}
              aria-hidden
            />
            <Mascot name={mascotOf(card.character)} size={42} className="rounded-full" />
            <span
              className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full"
              style={{
                background: closed || reachedLimit ? '#B7B4C6' : '#2FBF71',
                boxShadow: '0 0 0 2.5px var(--pa-surface)',
              }}
              aria-hidden
            />
          </div>
          <div
            className="pa-glass mt-1.5 flex items-center gap-2 rounded-full px-3 py-1"
            style={{ boxShadow: '0 6px 18px color-mix(in srgb, var(--pa-surface) 45%, transparent), 0 1px 3px rgba(40,30,80,0.07)' }}
          >
            <h1 className="max-w-[46vw] truncate text-[14.5px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
              {card.agentName}
            </h1>
            <span className="h-3.5 w-px shrink-0" style={{ background: 'color-mix(in srgb, var(--pa-line) 90%, transparent)' }} aria-hidden />
            <span
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#EAFBF1] px-2 py-[2px] text-[11.5px] font-bold text-[#0F9668] dark:bg-[#123026] dark:text-[#6FE3B4]"
              aria-live="polite"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${closed || reachedLimit ? 'bg-[#B7B4C6]' : 'animate-pulse bg-[#2FBF71]'}`} />
              {closed ? '응대 쉬는 중' : reachedLimit ? '응대 마침' : '응대 가능'}
            </span>
          </div>
        </div>

        <div className="col-start-3 flex justify-end">
          <span
            className="whitespace-nowrap rounded-full px-2.5 py-1.5 text-[11px] font-semibold lg:px-3 lg:text-[11.5px]"
            style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-mute)', boxShadow: '0 1px 3px rgba(40,30,80,0.05)' }}
            title="이 대화에서 남은 응대 횟수"
          >
            공개 명함 · {turnsLeft}/{turnsLimit}
          </span>
        </div>
      </header>

      <div ref={scrollerRef} className="pa-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4 lg:px-10">
        <div className="mx-auto flex w-full max-w-[720px] flex-col">
          {bubbles.length === 0 ? (
            <div className="flex flex-col items-center pt-4 text-center lg:pt-10">
              <div className="relative">
                <div className="absolute inset-0 -z-10 rounded-full bg-[#FFEAF1] blur-2xl dark:bg-[#3A2430]" />
                <Mascot name="pimong-cheer" size={116} className="animate-float" />
              </div>
              <h2 className="mt-4 text-[22px] font-bold leading-snug tracking-[-0.02em] lg:text-[26px]" style={{ color: 'var(--pa-ink-strong)' }}>
                안녕하세요, 비서{' '}
                <span style={{ color: 'var(--accent-ink)' }}>{card.agentName}</span>이에요!
              </h2>
              <p className="mt-2 max-w-[420px] text-[13.5px] leading-relaxed lg:text-[15px]" style={{ color: 'var(--pa-mute)' }}>
                {greeting}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {chips.map((chip) => (
                  <button
                    key={chip.label}
                    onClick={chip.onClick}
                    className="flex items-center gap-1.5 rounded-full border px-4 py-2.5 text-[13px] font-medium transition active:scale-[0.98]"
                    style={{ borderColor: 'var(--pa-line)', background: 'var(--pa-surface)', color: 'var(--pa-ink)' }}
                  >
                    <chip.icon size={14} style={{ color: 'var(--accent)' }} />
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-4 space-y-3">
            {bubbles.map((bubble, index) =>
              bubble.role === 'user' ? (
                <div key={index} className="flex justify-end">
                  <div
                    className="max-w-[82%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-[6px] px-4 py-2.5 text-[15px] leading-relaxed lg:max-w-[74%]"
                    style={{ background: 'var(--bubble-user)', color: 'var(--pa-ink-strong)' }}
                  >
                    {bubble.content}
                  </div>
                </div>
              ) : (
                <div key={index} className="flex items-start gap-2">
                  <Mascot name={mascotOf(card.character)} size={28} className="mt-0.5 shrink-0" />
                  <div
                    className="max-w-[84%] whitespace-pre-wrap break-words rounded-[20px] rounded-tl-[6px] px-4 py-2.5 text-[15px] leading-relaxed lg:max-w-[76%]"
                    style={{
                      background: bubble.notice ? 'var(--accent-soft-weak)' : 'var(--pa-surface-3)',
                      color: 'var(--pa-ink)',
                      boxShadow: '0 1px 2px rgba(40,30,80,0.04)',
                    }}
                  >
                    {bubble.content}
                  </div>
                </div>
              )
            )}
            {sending ? (
              <div className="flex items-center gap-2">
                <Mascot name="pimong-think" size={28} className="shrink-0" />
                <div className="flex items-center gap-1.5 rounded-[20px] rounded-tl-[6px] px-4 py-3" style={{ background: 'var(--pa-surface-3)' }}>
                  <Dot delay="0ms" />
                  <Dot delay="140ms" />
                  <Dot delay="280ms" />
                </div>
              </div>
            ) : null}
          </div>

          {reachedLimit || closed ? (
            <div
              className="mt-4 rounded-[18px] px-4 py-3.5 text-center"
              style={{ background: 'var(--accent-soft-weak)', border: '1px solid var(--accent-line-soft)' }}
            >
              <p className="text-[13px] leading-relaxed" style={{ color: 'var(--pa-ink)' }}>
                {closed ? '지금은 이 명함의 응대가 잠시 쉬고 있어요.' : '이 대화에서 나눌 수 있는 횟수를 다 썼어요.'}
                <br />
                이름과 연락처를 남겨 주시면 주인이 이어서 연락드려요.
              </p>
              <button className="pa-btn-primary mt-3 px-5 py-2.5 text-[13.5px]" onClick={() => setSheetOpen(true)} disabled={closed}>
                <Send size={14} /> 용건 · 연락 남기기
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-3 pb-[max(env(safe-area-inset-bottom),10px)] pt-1 lg:px-10 lg:pb-6">
        <div className="mx-auto w-full max-w-[720px]">
          {bubbles.length ? (
            <div className="mb-1.5 flex justify-center">
              <button
                className="flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium"
                style={{ color: 'var(--accent-ink)', background: 'var(--accent-soft-weak)' }}
                onClick={() => setSheetOpen(true)}
              >
                <CalendarDays size={13} /> 용건 · 연락 남기기 <ArrowUpRight size={12} />
              </button>
            </div>
          ) : null}
          {composerNote ? (
            <p className="mb-1.5 px-1 text-center text-[12px] font-medium" style={{ color: 'var(--pa-mute)' }} role="status">
              {composerNote}
            </p>
          ) : null}
          <div
            className="rounded-[24px] border p-2.5 lg:p-3"
            style={{ borderColor: 'var(--pa-line)', background: 'var(--pa-surface)', boxShadow: '0 10px 30px rgba(90,80,160,0.08)' }}
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  const el = e.target;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(120, el.scrollHeight)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                enterKeyHint="send"
                placeholder={`${card.agentName}에게 궁금한 걸 물어보세요…`}
                maxLength={500}
                className="pa-scroll max-h-[120px] min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2.5 text-[16px] leading-relaxed focus:outline-none"
                style={{ color: 'var(--pa-ink)' }}
                disabled={closed}
              />
              <button
                className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition active:scale-95"
                style={{
                  borderColor: listening ? 'var(--accent-line)' : 'var(--pa-line)',
                  background: listening ? 'var(--accent-soft)' : 'var(--pa-surface)',
                  color: listening ? 'var(--accent-ink)' : 'var(--pa-mute)',
                }}
                onClick={toggleDictation}
                aria-label={listening ? '음성 입력 멈추기' : '음성 입력'}
                aria-pressed={listening}
                title={listening ? '음성 입력 멈추기' : '음성으로 말하기'}
              >
                <Mic size={18} className={listening ? 'animate-pulse' : ''} />
              </button>
              <button
                className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow-float transition active:scale-95 disabled:opacity-40"
                style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
                onClick={() => void send(draft)}
                disabled={!draft.trim() || sending || closed}
                aria-label="보내기"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute-2)' }}>
            이 대화는 {card.agentName}가 응대하며, 남긴 내용은 주인에게 전달돼요.
            <br className="lg:hidden" /> 개인정보는 용건을 전달하는 데만 쓰여요.
          </p>
        </div>
      </div>

      {sheetOpen ? (
        <ContactSheet
          card={card}
          slug={slug}
          pass={pass}
          sessionId={sessionId}
          onClose={() => setSheetOpen(false)}
          onSent={(newSessionId) => {
            if (newSessionId) {
              setSessionId(newSessionId);
              writeStore(`pomong.cardSession.${slug}`, newSessionId);
            }
          }}
        />
      ) : null}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 껍데기 — 모바일은 꽉 채우고, PC 는 가운데 둥근 카드                    */
/* ------------------------------------------------------------------ */

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: 'var(--pa-bg)' }}>
      <div
        className="mx-auto flex h-full w-full max-w-[1120px] flex-col overflow-hidden lg:my-3 lg:h-[calc(100%-1.5rem)] lg:rounded-[30px] lg:shadow-[0_18px_60px_rgba(90,80,160,0.12)]"
        style={{ background: 'var(--pa-surface)' }}
      >
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 용건 · 연락 남기기 시트                                              */
/* ------------------------------------------------------------------ */

function ContactSheet({
  card,
  slug,
  pass,
  sessionId,
  onClose,
  onSent,
}: {
  card: PublicCardInfo;
  slug: string;
  pass: string;
  sessionId: string;
  onClose: () => void;
  onSent: (sessionId?: string) => void;
}) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const fields = card.collectFields.filter((field) => field.key !== 'name' && field.key !== 'contact');
  const nameField = card.collectFields.find((field) => field.key === 'name');
  const contactField = card.collectFields.find((field) => field.key === 'contact');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ ok: boolean; message: string; sessionId?: string }>(
        `/api/public/card/${encodeURIComponent(slug)}/submit`,
        {
          sessionId: sessionId || undefined,
          name,
          contact,
          note,
          fields: values,
          pass: pass || undefined,
        }
      );
      setDone(true);
      onSent(res.sessionId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '전달하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/35 pa-fade-in lg:items-center" role="dialog" aria-modal="true">
      <div
        className="pa-sheet-in max-h-[88vh] w-full max-w-[520px] overflow-y-auto pa-scroll rounded-t-[28px] px-5 pb-[max(env(safe-area-inset-bottom),16px)] pt-4 lg:rounded-[28px]"
        style={{ background: 'var(--pa-surface)' }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[17px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
            {done ? '전달했어요' : '용건 · 연락 남기기'}
          </h2>
          <button className="flex h-8 w-8 items-center justify-center rounded-full" style={{ color: 'var(--pa-mute)' }} onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="pb-2 text-center">
            <Mascot name="pimong-cheer" size={86} className="mx-auto animate-float" />
            <p className="mt-3 text-[14px] leading-relaxed" style={{ color: 'var(--pa-ink)' }}>
              주인에게 잘 전달했어요.
              <br />
              확인하면 남겨 주신 연락처로 답을 드릴게요.
            </p>
            <button className="pa-btn-primary mt-5 w-full py-3.5" onClick={onClose}>
              닫기
            </button>
          </div>
        ) : (
          <div className="space-y-3 pb-2">
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
              남겨 주시면 {card.agentName}가 대화 내용과 함께 주인에게 정리해 전달해요.
            </p>
            <Field label={nameField?.label || '이름'} required={nameField?.required}>
              <input className="pa-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="이름 또는 닉네임" maxLength={40} />
            </Field>
            <Field label={contactField?.label || '연락처'} required={contactField?.required} hint={contactField?.hint}>
              <input
                className="pa-input"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="이메일 · 전화번호 · 인스타 등"
                maxLength={120}
              />
            </Field>
            {fields.map((field) => (
              <Field key={field.key} label={field.label} required={field.required} hint={field.hint}>
                {field.kind === 'longtext' ? (
                  <textarea
                    className="pa-input min-h-[80px] resize-none"
                    value={values[field.key] || ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    maxLength={400}
                  />
                ) : (
                  <input
                    className="pa-input"
                    type={field.kind === 'date' ? 'date' : 'text'}
                    value={values[field.key] || ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    maxLength={400}
                  />
                )}
              </Field>
            ))}
            <Field label="남길 말 (선택)">
              <textarea
                className="pa-input min-h-[76px] resize-none"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="하고 싶으신 이야기를 자유롭게 적어 주세요"
                maxLength={1000}
              />
            </Field>
            {error ? (
              <p className="text-[12.5px] font-medium text-[#E5484D]" role="alert">
                {error}
              </p>
            ) : null}
            <button className="pa-btn-primary w-full py-3.5" onClick={() => void submit()} disabled={busy}>
              {busy ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
              {busy ? '전달하는 중…' : '주인에게 전달하기'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
        {label}
        {required ? <span style={{ color: 'var(--accent)' }}> *</span> : null}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--pa-mute-2)' }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-2 w-2 animate-bounce rounded-full"
      style={{ background: 'var(--accent-muted)', animationDelay: delay, animationDuration: '1s' }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* 작은 도우미                                                         */
/* ------------------------------------------------------------------ */

const MASCOT_NAMES: MascotName[] = ['pimong', 'pongi', 'poding', 'lamong', 'mello', 'minti'];

function mascotOf(character: string): MascotName {
  return (MASCOT_NAMES as string[]).includes(character) ? (character as MascotName) : 'pimong';
}

function readStore(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 사파리 프라이빗 모드 등 저장이 막힌 경우는 그냥 넘어간다 */
  }
}
