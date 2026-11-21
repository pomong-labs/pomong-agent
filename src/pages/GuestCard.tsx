import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Info, Loader2, Lock, Mic, Rocket, Send, ShieldCheck, Sparkles, X } from 'lucide-react';
import Mascot, { brandLogoUrl, type MascotName } from '../components/Mascot';
import { api, ApiError, type PublicCardInfo } from '../lib/api';
import { applyTheme } from '../lib/theme';
import { dictationErrorMessage, dictationSupported, dictationUnsupportedMessage, startDictation, type DictationHandle } from '../lib/speech';

/**
 * v0.7.3 — 공개 명함 방문자 화면 (`/c/<slug>`, 커스텀 도메인 루트)
 *
 * 주인 앱과 완전히 분리된 게스트 전용 단일 화면이다.
 *  · 사이드바 · 하단 5탭바 · 모델 선택바 · 첨부 클립 · 설정 진입점이 없다.
 *  · 서버는 이 화면에서 부르는 `/api/public/card/*` 만 허용하고,
 *    주인 API 는 인증이 필요하다(커스텀 도메인에서는 404).
 *  · v0.7.3: '용건·연락 남기기' 시트를 없앴다. 대화에서 받을 항목을 다 들으면
 *    서버가 완료를 확정해 요약·알림으로 전달하고, 입력창은 잠금 안내로 바뀐다.
 *  · qna_only 명함은 전달 없이 답변만 하고, 수집·처리 안내도 그에 맞게 보여 준다.
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
  /** 응답 완료(전달됨) — 새로고침해도 서버 상태로 되살린다 */
  const [completed, setCompleted] = useState(false);
  const [composerNote, setComposerNote] = useState('');
  const [noticeOpen, setNoticeOpen] = useState(false);
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
  const locked = completed;

  /* 공개 정보 불러오기 ------------------------------------------------ */
  useEffect(() => {
    let alive = true;
    setPhase('loading');
    api
      .get<{ card: PublicCardInfo }>(`/api/public/card/${encodeURIComponent(slug)}`)
      .then((res) => {
        if (!alive) return;
        setCard(res.card);
        // 1인 1회 명함에서 이미 응답을 마친 방문자면 처음부터 잠금 안내를 보여 준다.
        if (res.card.participated) setCompleted(true);
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
    // 손님 기기 설정을 따르되, 이 브라우저의 저장된 테마(주인 설정)는 건드리지 않는다.
    applyTheme(
      { theme: 'system', accentMode: 'character', accentColor: '#8B72F8', character: card?.character || 'pimong' },
      { persist: false }
    );
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
        if (res.status === 'submitted') setCompleted(true);
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
    if (card.deliveryMode === 'qna_only') return '궁금한 점을 편하게 물어보세요. 이 명함은 답변만 하고 따로 전달하지 않아요.';
    switch (card.purpose) {
      case 'meeting':
        return '가능한 시간을 안내하고, 원하시는 일정을 여쭤볼게요.';
      case 'survey':
        return '몇 가지만 여쭤보고 답을 정리해 전달드릴게요. 편하게 말씀해 주세요.';
      default:
        return '궁금한 점이나 남길 이야기를 편하게 말씀해 주세요.';
    }
  }, [card]);

  const send = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || sending || !card) return;
      if (locked) {
        setComposerNote('응답이 완료되어 대화가 종료되었습니다.');
        return;
      }
      if (closed) {
        setComposerNote('지금은 응대가 잠시 쉬고 있어요.');
        return;
      }
      if (reachedLimit) {
        setComposerNote('이 대화에서 나눌 수 있는 횟수를 다 썼어요.');
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
          completed?: boolean;
          status?: string;
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
        if (res.completed || res.status === 'submitted') setCompleted(true);
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'pin_required' || err.code === 'pin_expired')) {
          setPass('');
          setPhase('pin');
          return;
        }
        if (err instanceof ApiError && (err.code === 'completed' || err.code === 'already_participated')) {
          setCompleted(true);
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
    [card, closed, locked, pass, reachedLimit, sending, sessionId, slug, turnsLimit]
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

  const chips = card.quickPrompts.slice(0, 3).map((label, index) => ({
    label,
    icon: index === 0 ? Sparkles : Rocket,
    onClick: () => void send(label),
  }));
  const noticeLine =
    card.deliveryMode === 'collect'
      ? '대화 내용은 명함 주인에게만 전달·보관되며 외부에 공유되지 않아요'
      : '별도 전달 없이 답변 생성용으로만 쓰여요';

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
                background: closed || reachedLimit || locked ? '#B7B4C6' : '#2FBF71',
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
              <span className={`h-1.5 w-1.5 rounded-full ${closed || reachedLimit || locked ? 'bg-[#B7B4C6]' : 'animate-pulse bg-[#2FBF71]'}`} />
              {locked ? '응답 완료' : closed ? '응대 쉬는 중' : reachedLimit ? '응대 마침' : '응대 가능'}
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
            locked ? (
              <FinishedPanel agentName={card.agentName} character={card.character} />
            ) : (
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
            )
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

          {reachedLimit && !locked ? (
            <div
              className="mt-4 rounded-[18px] px-4 py-3.5 text-center"
              style={{ background: 'var(--accent-soft-weak)', border: '1px solid var(--accent-line-soft)' }}
            >
              <p className="text-[13px] leading-relaxed" style={{ color: 'var(--pa-ink)' }}>
                {closed ? '지금은 이 명함의 응대가 잠시 쉬고 있어요.' : '이 대화에서 나눌 수 있는 횟수를 다 썼어요.'}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-3 pb-[max(env(safe-area-inset-bottom),10px)] pt-1 lg:px-10 lg:pb-6">
        <div className="mx-auto w-full max-w-[720px]">
          {composerNote ? (
            <p className="mb-1.5 px-1 text-center text-[12px] font-medium" style={{ color: 'var(--pa-mute)' }} role="status">
              {composerNote}
            </p>
          ) : null}

          {locked ? (
            <div
              className="rounded-[24px] border px-4 py-4 text-center"
              style={{ borderColor: 'var(--accent-line-soft)', background: 'var(--accent-soft-weak)' }}
              role="status"
            >
              <p className="flex items-center justify-center gap-1.5 text-[13.5px] font-bold" style={{ color: 'var(--pa-ink)' }}>
                <Lock size={15} /> 응답이 완료되어 대화가 종료되었습니다
              </p>
              <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                {card.deliveryMode === 'collect'
                  ? '남겨 주신 내용은 정리되어 주인에게 전달됐어요. 참여해 주셔서 감사합니다.'
                  : '참여해 주셔서 감사합니다.'}
              </p>
            </div>
          ) : (
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
                  disabled={closed || reachedLimit}
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
                  disabled={!draft.trim() || sending || closed || reachedLimit}
                  aria-label="보내기"
                >
                  <Send size={18} />
                </button>
              </div>
            </div>
          )}

          <p className="mt-2 text-center text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute-2)' }}>
            {noticeLine}{' '}
            <button
              type="button"
              className="font-semibold underline underline-offset-2"
              style={{ color: 'var(--accent-ink)' }}
              onClick={() => setNoticeOpen(true)}
            >
              {card.deliveryMode === 'collect' ? '수집·처리 안내' : '처리 안내'}
            </button>
          </p>
        </div>
      </div>

      {noticeOpen ? <CollectionNotice card={card} onClose={() => setNoticeOpen(false)} /> : null}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 완료 안내 (이미 참여를 마친 방문자)                                  */
/* ------------------------------------------------------------------ */

function FinishedPanel({ agentName, character }: { agentName: string; character: string }) {
  return (
    <div className="flex flex-col items-center pt-6 text-center lg:pt-12">
      <Mascot name={mascotOf(character)} size={104} className="animate-float" />
      <h2 className="mt-4 text-[20px] font-bold tracking-[-0.02em]" style={{ color: 'var(--pa-ink-strong)' }}>
        이미 참여를 마치셨어요
      </h2>
      <p className="mt-2 max-w-[360px] text-[13.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
        이 명함은 1인 1회만 참여할 수 있어요. 남겨 주신 내용은 {agentName}가 주인에게 전달했어요.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 수집 및 처리 안내                                                    */
/* ------------------------------------------------------------------ */

function CollectionNotice({ card, onClose }: { card: PublicCardInfo; onClose: () => void }) {
  const purposeText: Record<string, string> = {
    intro: '소개·질문 응대, 문의 접수',
    meeting: '미팅 일정 안내·조정',
    survey: '설문 응답 수집·정리',
    custom: '명함에 적힌 범위의 문의 응대',
  };
  const collect = card.deliveryMode === 'collect';
  const fields = card.collectFields.map((field) => field.label);

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 pa-fade-in lg:items-center" role="dialog" aria-modal="true">
      <div
        className="pa-sheet-in flex w-full max-w-[520px] flex-col overflow-hidden rounded-t-[28px] lg:rounded-[28px]"
        style={{
          background: 'var(--pa-surface)',
          // v0.7.3: iOS 상태바에 제목이 가리지 않고, 홈 인디케이터 위로 확인 버튼이 뜨도록 세이프 에어리어를 더한다.
          maxHeight: 'calc(100dvh - env(safe-area-inset-top))',
          paddingTop: 'calc(env(safe-area-inset-top) + 16px)',
        }}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pb-3">
          <h2 className="flex items-center gap-2 text-[17px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
            <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
            {collect ? '수집 및 처리 안내' : '처리 안내'}
          </h2>
          <button className="flex h-8 w-8 items-center justify-center rounded-full" style={{ color: 'var(--pa-mute)' }} onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </div>

        <div className="pa-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-ink)' }}>
          <NoticeRow label={collect ? '수집 항목' : '입력하는 내용'}>
            {collect
              ? fields.length
                ? `${fields.join(', ')}, 그리고 대화 내용`
                : '대화에서 이름·연락처와 용건'
              : '대화 내용(답변 생성용)'}
          </NoticeRow>
          <NoticeRow label="접속 기록 (IP)">
            도배·악용 및 1인 1회 중복 참여 방지 목적으로만 복원 불가능한 단방향 해시값으로 처리되며, 원본 IP는 저장하지 않고
            보관 기간 경과 시 함께 영구 삭제돼요.
          </NoticeRow>
          <NoticeRow label="이용 목적">{purposeText[card.purpose] || '문의 응대'}</NoticeRow>
          <NoticeRow label="주인에게 전달">
            {collect
              ? '정해 둔 항목을 모두 들으면 정리해 명함 주인에게 알림으로 전달해요.'
              : '따로 전달하지 않아요. 주인 화면에도 이 대화가 표시되지 않고, 답변을 만드는 데만 쓰여요.'}
          </NoticeRow>
          <NoticeRow label="보관 기간">
            {card.retentionDays > 0
              ? `답변 생성을 위해 서버에 잠시 보관하며, 대화를 시작한 날로부터 ${card.retentionDays}일 뒤 자동으로 영구 삭제해요.`
              : '서버에서 삭제하지 않고 보관해요(0일 = 영구 보관 설정).'}
          </NoticeRow>
          <NoticeRow label="참여 횟수">
            {card.oncePerVisitor ? '이 명함은 1인 1회만 참여할 수 있어요.' : '원할 때 여러 번 참여할 수 있어요.'}
          </NoticeRow>
          <NoticeRow label="AI 처리">
            답변을 만들기 위해 대화 내용이 서버에 연결된 AI 서비스로 전송돼요. 명함 주인 외에는 공유하지 않아요.
          </NoticeRow>
          <NoticeRow label="문의">수집·보관에 대해 궁금한 점은 명함 주인에게 알려 주세요.</NoticeRow>

          <div
            className="flex items-start gap-2 rounded-[16px] px-3.5 py-3 text-[11.5px] leading-relaxed"
            style={{ background: 'var(--accent-soft-weak)', color: 'var(--pa-ink)' }}
          >
            <Info size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
            <span>
              {collect
                ? '대화 내용은 이 명함의 주인에게만 전달·보관되며 외부에 공유되지 않아요. 보관 기간이 지나면 서버에서 실제로 삭제돼요.'
                : '이 명함은 답변만 제공하며, 남긴 내용을 주인에게 전달하거나 보관하지 않아요.'}
            </span>
          </div>
        </div>

        <div className="shrink-0 px-5 pt-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
          <button className="pa-btn-primary w-full py-3.5" onClick={onClose}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

function NoticeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-[14px] px-3 py-2.5" style={{ background: 'var(--pa-surface-3)' }}>
      <span className="w-[76px] shrink-0 font-semibold" style={{ color: 'var(--pa-mute)' }}>
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
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
