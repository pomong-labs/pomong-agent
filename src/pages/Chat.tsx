import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Copy,
  Download,
  FileText,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  MessageSquare,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Reply,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';
import AppHeader, { HEADER_SPACE } from '../components/AppHeader';
import Mascot, { type MascotName } from '../components/Mascot';
import ModelBar from '../components/ModelBar';
import { StatsCard, TasksCard } from '../components/Cards';
import { api, type ChatAttachment, type ChatMessage, type LoginRequest, type ChatSession, type MailDraftCard, type ReplyTarget, type TaskRun, type VaultUnlockRequest, type ApprovalRequest } from '../lib/api';
import { formatChatStamp, formatClock, formatRoomStamp, formatRoomStampFull } from '../lib/format';
import { subjectName } from '../lib/korean';
import {
  dictationErrorMessage,
  dictationSupported,
  dictationUnsupportedMessage,
  getSpeakingKey,
  isAppleWebKit,
  startDictation,
  stopSpeech,
  subscribeSpeech,
  toggleSpeech,
  type DictationHandle,
} from '../lib/speech';
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

/**
 * v0.6.12: 비서 이름에 받침 유무에 맞는 주격 조사(이/가)를 붙인다.
 * "라몽이 생각 중…", "퐁이가 생각 중…" 처럼 이름을 바꿔도 문장이 자연스럽게 읽힌다.
 */
/**
 * v0.6.18: 마크다운 코드 블록(```lang … ```)을 원터치 복사 버튼이 달린 블록으로 보여 준다.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const area = document.createElement('textarea');
      area.value = code;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="relative my-1.5 overflow-hidden rounded-xl bg-[#1E1B2B] ring-1 ring-[#2E2A3D]">
      <div className="flex items-center justify-between gap-2 border-b border-[#2E2A3D] px-3 py-1.5">
        <span className="truncate text-[10.5px] font-semibold uppercase tracking-wide text-[#9B93B8]">{lang || 'code'}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-[#C9B8FF] transition hover:bg-white/10 active:scale-95"
          aria-label="코드 복사"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? '복사됨' : '복사'}
        </button>
      </div>
      <pre className="selectable-text overflow-x-auto px-3 py-2.5 text-[12.5px] leading-[1.65] text-[#EDEAF6]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

type RichSegment = { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string };

/** 코드 펜스가 닫히지 않았어도 마지막 블록으로 읽어 준다. */
function splitRichSegments(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  const re = /```([\w+-]*)\r?\n?([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });
    out.push({ kind: 'code', lang: (match[1] || '').trim(), code: match[2].replace(/\n$/, '') });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  const open = rest.indexOf('```');
  if (open >= 0) {
    const head = rest.slice(0, open);
    if (head.trim()) out.push({ kind: 'text', text: head });
    const tail = rest.slice(open + 3);
    const [firstLine, ...body] = tail.split('\n');
    out.push({ kind: 'code', lang: firstLine.trim(), code: body.join('\n') });
  } else if (rest) {
    out.push({ kind: 'text', text: rest });
  }
  return out;
}

export function RichText({ text }: { text: string }) {
  const segments = splitRichSegments(text);
  return (
    <div className="space-y-1.5 text-[15px] leading-[1.75] text-[#2A2A35] sm:text-[16px]">
      {segments.map((segment, index) => {
        if (segment.kind === 'code') return <CodeBlock key={`code-${index}`} code={segment.code} lang={segment.lang} />;
        return (
          <div key={`text-${index}`} className="space-y-1.5">
            {segment.text.split('\n').map((line, i) => {
              const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
              if (bullet) {
                return (
                  <div key={i} className="flex gap-2 pl-1">
                    <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#C9B8FF]" />
                    <span className="flex-1">{renderInline(bullet[1], `l${index}-${i}`)}</span>
                  </div>
                );
              }
              if (!line.trim()) return <div key={i} className="h-1" />;
              return <p key={i}>{renderInline(line, `p${index}-${i}`)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * v0.6.18: 모바일 말풍선을 옆으로 밀어 답장(인용)하기.
 *
 * - 가로로 임계값(56px)까지 끌면 손을 뗄 때 답장 입력이 열린다.
 * - 세로로 움직이기 시작하면(스크롤) 끼어들지 않고 바로 놓아 준다.
 * - `touch-action: pan-y` 로 세로 스크롤은 브라우저에 그대로 맡긴다.
 */
function SwipeReply({
  onReply,
  align = 'start',
  children,
}: {
  onReply: () => void;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const THRESHOLD = 56;
  const MAX = 84;
  const [dx, setDx] = useState(0);
  const dxRef = useRef(0);
  const tracker = useRef<{ x: number; y: number; locked: boolean; dead: boolean } | null>(null);

  const moveTo = (value: number) => {
    dxRef.current = value;
    setDx(value);
  };

  const reset = () => {
    tracker.current = null;
    moveTo(0);
  };

  return (
    <div
      className="relative"
      style={{ touchAction: 'pan-y' }}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        if (!touch) return;
        tracker.current = { x: touch.clientX, y: touch.clientY, locked: false, dead: false };
      }}
      onTouchMove={(e) => {
        const gesture = tracker.current;
        const touch = e.touches[0];
        if (!gesture || !touch || gesture.dead) return;
        const moveX = touch.clientX - gesture.x;
        const moveY = touch.clientY - gesture.y;
        if (!gesture.locked) {
          // 세로 움직임이 더 크면 스크롤이다 — 손대지 않는다.
          if (Math.abs(moveY) > Math.abs(moveX) + 8) {
            gesture.dead = true;
            moveTo(0);
            return;
          }
          if (Math.abs(moveX) < 12) return;
          gesture.locked = true;
        }
        if (moveX > 0) moveTo(Math.min(moveX, MAX));
        else moveTo(0);
      }}
      onTouchEnd={() => {
        const passed = dxRef.current >= THRESHOLD;
        reset();
        if (passed) onReply();
      }}
      onTouchCancel={reset}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-[#F1ECFF] text-[#7C63F6] transition-opacity ${
          align === 'end' ? 'right-0' : 'left-0'
        }`}
        style={{ opacity: Math.min(1, dx / THRESHOLD) }}
      >
        <Reply size={15} />
      </div>
      <div
        style={{
          transform: dx ? `translateX(${dx}px)` : undefined,
          transition: dx ? 'none' : 'transform 180ms ease',
          willChange: dx ? 'transform' : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default function Chat() {
  /** 터치 기기(아이폰 등)인지 — 엔터를 줄바꿈으로 쓸지 결정한다 (v0.6.2) */
  const [touchKeyboard, setTouchKeyboard] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(pointer: coarse)').matches || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => setTouchKeyboard(query.matches || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent));
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  const {
    messages,
    messagesLoaded,
    sending,
    /** v0.7.0: 실시간 스트리밍 미리보기 */
    streamText,
    /** v0.7.0: 서버가 중단된 턴을 알려 오면 이어서 하기 제안 */
    resumable,
    resumeTurn,
    dismissResume,
    recovering,
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
    unlockRequests,
    approvals,
    approveTask,
    cancelApproval,
    vault,
    submitLoginCard,
    dismissLoginCard,
    submitUnlockCard,
    dismissUnlockCard,
    sessions,
    activeSession,
    switchSession,
    newSession,
    renameSession,
    deleteSession,
    stop,
    turnStart,
  } = useAppStore();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** v0.7.1: 푸시 알림 딥링크(?room=&msg=&approval=) 처리 */
  const [searchParams, setSearchParams] = useSearchParams();
  const [approvalFocus, setApprovalFocus] = useState<string | null>(null);
  const activeSessionNow = useRef(activeSession);
  activeSessionNow.current = activeSession;
  const deepLinkKey = useRef<string>('');
  /** v0.6.5: 보낸 뒤 입력창 높이를 기본 1줄로 되돌리는 데 쓴다 */
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resetComposerHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
  }, []);

  // v0.6.5: 입력이 비면(전송·지우기) 늘어났던 입력창을 항상 1줄 높이로 되돌린다.
  useEffect(() => {
    if (draft === '') resetComposerHeight();
  }, [draft, resetComposerHeight]);

  /** v0.5.2: 아직 보내지 않은 첨부(사진·파일) */
  const [pending, setPending] = useState<{ id: string; view: ChatAttachment; preview?: string }[]>([]);
  const [uploading, setUploading] = useState(0);
  const [attachError, setAttachError] = useState('');
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  /* v0.6.4: 이번 턴 시작 시각은 방마다 따로 센다(store가 들고 있다). */
  const [turnSeconds, setTurnSeconds] = useState(0);
  /** v0.6.4: 파일을 끌어다 놓는 동안 입력창을 표시한다 */
  const [dragOver, setDragOver] = useState(false);

  /** v0.6.3: 답장(인용) 대상 — 입력창 위에 미리보기를 띄운다 */
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);

  const MAX_FILES = 6;
  const MAX_BYTES = 15 * 1024 * 1024;

  const uploadFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setAttachError('');
    const picked = Array.from(files);
    const room = Math.max(0, MAX_FILES - pending.length);
    const list = picked.slice(0, room);
    if (picked.length > room) setAttachError(`한 번에 최대 ${MAX_FILES}개까지 첨부할 수 있어요.`);
    for (const file of list) {
      if (file.size > MAX_BYTES) {
        setAttachError(`'${file.name}'은 15MB를 넘어 첨부하지 못했어요.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const params = new URLSearchParams({ name: file.name, session: activeSession });
        const res = await fetch(`/api/chat/upload?${params.toString()}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; attachment?: ChatAttachment; message?: string } | null;
        if (!res.ok || !data?.attachment) throw new Error(data?.message || '업로드하지 못했어요.');
        const view = data.attachment;
        setPending((prev) => [
          ...prev,
          { id: view.id, view, preview: view.kind === 'image' ? view.url : undefined },
        ]);
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : '업로드하지 못했어요.');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }, [pending.length, activeSession]);

  const removePending = (id: string) => setPending((prev) => prev.filter((p) => p.id !== id));

  /* ---------------- v0.5.5: 음성 입력 · 답변 읽어주기 ---------------- */
  const [listening, setListening] = useState(false);
  const [voiceHint, setVoiceHint] = useState('');
  const dictationRef = useRef<DictationHandle | null>(null);
  const dictationBaseRef = useRef('');
  /** 사용자가 직접 마이크를 꺼서 끝난 것인지 (WebKit 자동 종료 안내를 구분) */
  const dictationManualStopRef = useRef(false);
  const voiceHintTimer = useRef<number | null>(null);

  const flashVoiceHint = useCallback((message: string) => {
    if (!message) return;
    setVoiceHint(message);
    if (voiceHintTimer.current) window.clearTimeout(voiceHintTimer.current);
    voiceHintTimer.current = window.setTimeout(() => setVoiceHint(''), 6500);
  }, []);

  const stopDictation = useCallback(() => {
    dictationManualStopRef.current = true;
    dictationRef.current?.stop();
    dictationRef.current = null;
    setListening(false);
  }, []);

  const toggleDictation = useCallback(() => {
    if (dictationRef.current) {
      stopDictation();
      return;
    }
    if (!dictationSupported()) {
      flashVoiceHint(dictationUnsupportedMessage());
      return;
    }
    dictationBaseRef.current = draft.trim();
    dictationManualStopRef.current = false;
    const handle = startDictation({
      onText: (finalText, interim) => {
        const spoken = [finalText, interim].filter(Boolean).join(' ');
        const base = dictationBaseRef.current;
        setDraft([base, spoken].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
      },
      onError: (code, message) => {
        if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
          dictationRef.current = null;
          setListening(false);
        }
        flashVoiceHint(message || dictationErrorMessage(code));
      },
      onEnd: () => {
        const manual = dictationManualStopRef.current;
        dictationManualStopRef.current = false;
        dictationRef.current = null;
        setListening(false);
        // 아이폰(WebKit)은 한 번 말할 때마다 인식기가 새로 만들어지므로,
        // 저절로 끝난 경우에는 "마이크를 다시 눌러 이어서 말하라"고 알려 준다.
        if (!manual && isAppleWebKit()) {
          flashVoiceHint('받아쓰기를 마쳤어요. 이어서 말하려면 마이크를 다시 눌러 주세요.');
        }
      },
    });
    if (!handle) {
      flashVoiceHint(dictationUnsupportedMessage());
      return;
    }
    dictationRef.current = handle;
    setListening(true);
    flashVoiceHint('듣고 있어요. 말씀을 마치면 마이크를 한 번 더 눌러 주세요.');
  }, [draft, flashVoiceHint, stopDictation, setDraft]);

  // 화면을 떠날 때 마이크·읽어주기를 정리한다.
  useEffect(() => {
    return () => {
      dictationRef.current?.abort();
      dictationRef.current = null;
      if (voiceHintTimer.current) window.clearTimeout(voiceHintTimer.current);
      stopSpeech();
    };
  }, []);


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

  /** v0.6.3: 응답을 기다리는 동안 실제 경과 시간을 센다(작업 카드·대기 말풍선에 표시). */
  useEffect(() => {
    if (!sending) setTurnSeconds(0);
  }, [sending]);

  useEffect(() => {
    if (!sending || !turnStart) return;
    const update = () => setTurnSeconds(Math.max(0, Math.round((Date.now() - turnStart) / 1000)));
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [sending, turnStart]);

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
    if ((!draft.trim() && !pending.length) || sending || uploading) return;
    if (dictationRef.current) stopDictation();
    const ids = pending.map((p) => p.id);
    // v0.6.12: 낙관적 말풍선에 사진·파일을 바로 그리도록 첨부 뷰를 함께 넘긴다.
    void send(draft, ids, replyTo, pending.map((p) => p.view));
    setReplyTo(null);
    setPending([]);
    setAttachError('');
    // v0.6.5: 여러 줄을 쓰고 보낸 뒤에도 입력창이 늘어난 채로 남지 않게 한다.
    resetComposerHeight();
  };

  /** v0.6.3: 인용된 원본 메시지로 이동해 잠깐 강조한다. */
  const jumpToMessage = (id: number) => {
    setHighlight(id);
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setHighlight(null), 2200);
  };

  /**
   * v0.7.1: 알림을 눌러 들어온 딥링크(?room=<방>&msg=<메시지>&approval=<승인카드>).
   * 방을 바꾼 뒤 해당 지점으로 부드럽게 내려가 잠깐 강조하고, 주소의 쿼리는 지운다.
   */
  useEffect(() => {
    const room = searchParams.get('room');
    const msgRaw = Number(searchParams.get('msg') || 0);
    const approval = searchParams.get('approval');
    if (!room && !msgRaw && !approval) return;
    const key = `${room || ''}|${msgRaw || ''}|${approval || ''}`;
    if (deepLinkKey.current === key) return;
    deepLinkKey.current = key;
    let cancelled = false;

    const scrollToTarget = (tries: number) => {
      if (cancelled) return;
      const targetId = msgRaw ? `msg-${msgRaw}` : approval ? `approval-${approval}` : '';
      const element = targetId ? document.getElementById(targetId) : null;
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (msgRaw) {
          setHighlight(msgRaw);
          window.setTimeout(() => setHighlight(null), 2600);
        }
        if (approval) {
          setApprovalFocus(approval);
          window.setTimeout(() => setApprovalFocus(null), 3200);
        }
        return;
      }
      if (tries < 10) window.setTimeout(() => scrollToTarget(tries + 1), 260);
    };

    const enter = async () => {
      const switching = Boolean(room && room !== activeSessionNow.current);
      if (switching && room) {
        try {
          await switchSession(room);
        } catch {
          /* 방이 사라졌으면 지금 방에 그대로 둔다 */
        }
      }
      window.setTimeout(() => scrollToTarget(0), switching ? 460 : 90);
      // 쿼리는 한 번 처리하면 지운다(새로고침·뒤로가기에서 다시 내려가지 않게).
      setSearchParams({}, { replace: true });
    };
    void enter();
    return () => {
      cancelled = true;
    };
  }, [searchParams, setSearchParams, switchSession]);

  const onClear = () => {
    if (!window.confirm('대화 기록을 모두 지울까요?')) return;
    void clearChat();
  };

  /**
   * v0.6.2: 엔터 키 동작을 기기별로 나눈다.
   *   · 모바일(터치 기기): 엔터 = 줄바꿈, 전송은 오른쪽 전송 버튼으로만
   *   · PC: 엔터 = 전송, Shift+Enter = 줄바꿈
   * 한글 조합 중(isComposing)의 엔터는 조합 확정이라 전송하지 않는다.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (touchKeyboard) return; // 모바일: 기본 동작(줄바꿈)
    if (e.shiftKey) return; // PC: Shift+Enter 줄바꿈
    e.preventDefault();
    submit();
  };

  const agentName = profile.agentName || '포몽';
  const pendingLabel = recovering
    ? '연결을 다시 잇는 중…'
    : visibleState === 'working'
      ? `${subjectName(agentName)} 작업 중…`
      : `${subjectName(agentName)} 생각 중…`;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* v0.6.5: 상단바는 채팅 위에 겹쳐 뜨는 플로팅 오버레이다(아래 패딩으로 첫 메시지 가림만 막는다) */}
      <AppHeader
        onMenu={() => setDrawer(true)}
        onSearch={() => setSearchOpen(true)}
        onClear={onClear}
        onMore={() => navigate('/more')}
      />

      {/* messages */}
      <div
        ref={scrollRef}
        className="pa-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-8 lg:px-10 lg:pb-10"
        style={{ paddingTop: keyboardOpen ? HEADER_SPACE.compact : HEADER_SPACE.normal }}
      >
        <div className="mx-auto w-full max-w-[880px] space-y-5 lg:space-y-6">
          {!aiReady ? (
            <div className="flex items-start gap-3 rounded-2xl border border-[#FFE7C7] bg-[#FFF9F0] px-4 py-3.5 text-[13.5px] text-[#A9762A]">
              <span className="min-w-0 flex-1">선택한 AI의 키가 아직 연결되지 않았어요. 아래 모델 바에서 다른 모델을 고르거나 설정에서 키를 연결해 주세요.</span>
              <button className="shrink-0 rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-[#A9762A] ring-1 ring-[#F3DFC0]" onClick={() => navigate('/settings')}>
                설정
              </button>
            </div>
          ) : null}

          {/* v0.6.4: 대화를 아직 받아오는 중이면 빈 화면 대신 부드러운 로딩 자리표시자를 보여 준다 */}
          {messages.length === 0 && !messagesLoaded ? (
            <div className="space-y-3 pt-2" aria-hidden>
              <div className="h-14 w-[62%] animate-pulse rounded-[22px] bg-[#F3F1FA] dark:bg-[#242130]" />
              <div className="ml-auto h-11 w-[46%] animate-pulse rounded-[22px] bg-[#F3F1FA] dark:bg-[#242130]" />
              <div className="h-20 w-[70%] animate-pulse rounded-[22px] bg-[#F3F1FA] dark:bg-[#242130]" />
            </div>
          ) : null}

          {messages.length === 0 && messagesLoaded ? (
            <EmptyState agentName={profile.agentName} character={profile.character} onPick={(t) => void send(t)} />
          ) : null}

          {messages.map((m) => (
            <div
              key={m.id}
              id={`msg-${m.id}`}
              className={`scroll-mt-24 transition ${
                highlight === m.id ? '-m-1 rounded-[26px] bg-[#FBF8FF] p-1 ring-2 ring-[#C9B8FF]' : ''
              }`}
            >
              {m.role === 'user' ? (
                <div className="group flex flex-col items-end gap-1.5 animate-fade-up">
                  <div className="flex max-w-[85%] flex-col items-end gap-2">
                    {m.attachments?.length ? (
                      <MessageAttachments items={m.attachments} onPreview={setPreview} />
                    ) : null}
                    {m.replyTo ? (
                      <button
                        type="button"
                        onClick={() => jumpToMessage(m.replyTo!.id)}
                        className="max-w-[85%] rounded-[14px] border-l-[3px] border-[#B9A8FF] bg-[#F7F5FF] px-3 py-2 text-left transition active:scale-[0.99] dark:bg-[#221E30]"
                        title="원본 메시지로 이동"
                      >
                        <span className="block text-[11px] font-bold text-[#7C63F6]">
                          {m.replyTo.role === 'user' ? '나에게 답장' : `${agentName}에게 답장`}
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] text-[#6B677A]">
                          {m.replyTo.content.replace(/\s+/g, ' ').slice(0, 90)}
                        </span>
                      </button>
                    ) : null}
                    {m.content ? (
                      <SwipeReply
                        align="end"
                        onReply={() =>
                          setReplyTo({ id: m.id, role: 'user', content: m.content || '(첨부 파일)', createdAt: m.createdAt })
                        }
                      >
                        <div
                          className="selectable-text rounded-[22px] rounded-br-lg px-4 py-3 text-[15px] leading-relaxed text-[#2A2A35] shadow-[0_2px_10px_rgba(120,100,200,0.05)] sm:text-[16px]"
                          style={{ background: 'var(--bubble-user)' }}
                        >
                          {m.content}
                        </div>
                      </SwipeReply>
                    ) : null}
                    {/* v0.6.15: 비서가 남긴 이모지 리액션 — 말풍선 아래에 작은 뱃지로 */}
                    {m.reactions?.length ? (
                      <div className="-mt-2 mr-2">
                        <ReactionBadges items={m.reactions} />
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5 pr-1 text-[12px] text-[#A8A5B8]">
                    <button
                      type="button"
                      onClick={() =>
                        setReplyTo({ id: m.id, role: 'user', content: m.content || '(첨부 파일)', createdAt: m.createdAt })
                      }
                      className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-[#B4B1C2] transition hover:bg-[#F7F5FF] hover:text-[#7C63F6] active:scale-95"
                      aria-label="이 메시지에 답장"
                    >
                      <Reply size={11} /> 답장
                    </button>
                    {formatChatStamp(m.createdAt)}
                    <CheckCheck size={13} className="text-[#B9A8FF]" />
                  </div>
                </div>
              ) : m.meta?.type === 'notice' ? (
                <NoticeBubble message={m} character={profile.character} />
              ) : (
                <SwipeReply
                  onReply={() => setReplyTo({ id: m.id, role: 'assistant', content: m.content, createdAt: m.createdAt })}
                >
                  <AssistantBubble
                  message={m}
                  character={profile.character}
                  agentName={profile.agentName}
                  taskRun={shownRuns.find((r) => r.messageId === m.id) || null}
                  loginRequests={requestsOf(m.id)}
                  unlockRequests={unlockRequests.filter((r) => r.messageId === m.id)}
                  vault={vault}
                  onLoginSubmit={submitLoginCard}
                  onLoginDismiss={dismissLoginCard}
                  onUnlockSubmit={submitUnlockCard}
                  onUnlockDismiss={dismissUnlockCard}
                  onPreview={setPreview}
                  onReply={() =>
                    setReplyTo({ id: m.id, role: 'assistant', content: m.content, createdAt: m.createdAt })
                  }
                />
                </SwipeReply>
              )}
            </div>
          ))}

          {/* 아직 답변 말풍선이 붙지 않은 금고 PIN 카드(이번 턴 진행 중) */}
          {unlockRequests
            .filter((r) => !r.messageId && r.status === 'pending')
            .map((request) => (
              <VaultPinCard
                key={request.id}
                request={request}
                onSubmit={submitUnlockCard}
                onDismiss={dismissUnlockCard}
              />
            ))}

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

          {/* v0.6.18: 되돌리기 어려운 작업의 승인 카드 */}
          {approvals.map((request) => (
            <div
              key={request.id}
              id={`approval-${request.id}`}
              className={`scroll-mt-24 rounded-[24px] transition ${
                approvalFocus === request.id ? 'ring-2 ring-[#F0A32B] ring-offset-2' : ''
              }`}
            >
              <ApprovalCard request={request} onApprove={approveTask} onCancel={cancelApproval} />
            </div>
          ))}

          {/* v0.7.0: 서버가 재시작되어 중단된 작업 — 이어서 하기 제안 */}
          {resumable && !sending ? (
            <div className="animate-fade-up rounded-[22px] bg-[#FFFBF2] px-4 py-3.5 ring-1 ring-[#F6E5C8]">
              <p className="text-[13.5px] font-bold text-[#9A6B1E]">중단된 작업이 있어요</p>
              <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-[#8A7350]">
                “{resumable.userPrompt.replace(/\s+/g, ' ').slice(0, 90)}” · {resumable.step}단계까지 진행했어요. 서버가 다시 시작되어 잠시 멈췄는데, 그 지점에서 이어서 할까요?
              </p>
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded-full bg-[#F0A93B] px-3 py-2 text-[12.5px] font-bold text-white transition active:scale-[0.99]"
                  onClick={() => void resumeTurn()}
                >
                  이어서 하기
                </button>
                <button
                  type="button"
                  className="rounded-full bg-white px-3 py-2 text-[12.5px] font-semibold text-[#9A6B1E] ring-1 ring-[#F0DDBB] transition active:scale-[0.99]"
                  onClick={dismissResume}
                >
                  그만두기
                </button>
              </div>
            </div>
          ) : null}

          {sending ? (
            <div className="space-y-2.5">
              {shownLive ? <TaskCard run={shownLive} live startMs={turnStart ?? undefined} /> : null}
              {streamText ? (
                <div className="flex items-start gap-2.5 lg:gap-3.5">
                  <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FFF0F5] ring-1 ring-[#FFE4EE] sm:flex lg:h-11 lg:w-11">
                    <Mascot name="pimong-think" size={26} />
                  </div>
                  <div className="min-w-0 max-w-[86%]">
                    <div className="selectable-text whitespace-pre-wrap break-words rounded-[24px] rounded-bl-lg bg-white px-4 py-3 text-[15px] leading-relaxed text-[#2A2A35] shadow-card ring-1 ring-[#F6F4FB] sm:text-[16px]">
                      {streamText}
                      <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse rounded-full bg-[#B9A8FF] align-baseline" />
                    </div>
                    <p className="mt-1 pl-1 text-[11.5px] font-medium text-[#B4B1C2]">
                      답변을 쓰는 중{turnSeconds > 0 ? ` · ${turnSeconds}초` : ''}
                    </p>
                  </div>
                </div>
              ) : (
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
                <span className="text-[12.5px] font-medium text-[#9B98AB]">
                  {pendingLabel}
                  {turnSeconds > 0 ? ` · ${turnSeconds}초` : ''}
                </span>
                {recovering ? (
                  <span className="hidden text-[11px] font-medium text-[#C0BCCD] sm:block">앱을 나갔다 와도 답장은 이어서 도착해요</span>
                ) : null}
              </div>
            </div>
              )}
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
          {replyTo ? (
            <div className="mb-1.5 flex items-start gap-2 rounded-[16px] border-l-[3px] border-[#B9A8FF] bg-[#F7F5FF] px-3 py-2 shadow-[0_2px_10px_rgba(120,100,200,0.06)] dark:bg-[#221E30]">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-[#7C63F6]">
                  {replyTo.role === 'user' ? '나에게 답장' : `${agentName}에게 답장`}
                </p>
                <p className="truncate text-[12.5px] text-[#6B677A]">
                  {replyTo.content.replace(/\s+/g, ' ').slice(0, 120) || '(첨부 파일)'}
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-full p-1 text-[#A8A5B8] transition hover:bg-white/60 hover:text-[#E5484D] active:scale-90"
                onClick={() => setReplyTo(null)}
                aria-label="답장 취소"
                title="답장 취소"
              >
                <X size={15} />
              </button>
            </div>
          ) : null}
          {(pending.length || uploading > 0 || attachError) && (
            <div className="mb-1.5 rounded-[18px] border border-[#EFEDF6] bg-[#FBFAFF] px-2.5 py-2 dark:bg-[#1E1B29]">
              <div className="flex flex-wrap items-center gap-1.5">
                {pending.map((p) => (
                  <div key={p.id} className="relative">
                    {p.preview ? (
                      <img
                        src={p.preview}
                        alt={p.view.filename}
                        className="h-14 w-14 rounded-xl object-cover ring-1 ring-[#EAE6F6]"
                      />
                    ) : (
                      <div className="flex h-14 max-w-[190px] items-center gap-2 rounded-xl bg-white px-2.5 ring-1 ring-[#EAE6F6]">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F5F1FF] text-[#7C63F6]">
                          <FileText size={15} />
                        </span>
                        <span className="min-w-0">
                          <span className="block max-w-[120px] truncate text-[11.5px] font-semibold text-[#3B3947]">
                            {p.view.filename}
                          </span>
                          <span className="block text-[10px] text-[#A8A5B8]">{fileSize(p.view.size)}</span>
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removePending(p.id)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#3B3947] text-white shadow-sm transition active:scale-90"
                      aria-label={`${p.view.filename} 빼기`}
                      title="빼기"
                    >
                      <X size={11} strokeWidth={3} />
                    </button>
                  </div>
                ))}
                {uploading > 0 ? (
                  <span className="flex h-14 items-center gap-1.5 rounded-xl bg-white px-3 text-[11.5px] font-semibold text-[#7C63F6] ring-1 ring-[#EAE6F6]">
                    <Loader2 size={13} className="animate-spin" /> 올리는 중…
                  </span>
                ) : null}
                <span className="ml-auto self-end pb-0.5 text-[10.5px] text-[#B4B1C2]">
                  {pending.length}/{MAX_FILES}
                </span>
              </div>
              {attachError ? (
                <p className="mt-1.5 flex items-start gap-1 text-[11.5px] font-medium text-[#E5484D]" role="alert">
                  <AlertCircleIcon />
                  <span className="min-w-0 flex-1">{attachError}</span>
                </p>
              ) : null}
            </div>
          )}
          <div className="mb-1.5 px-0.5">
            <ModelBar />
          </div>
          <div
            className={`rounded-[24px] border bg-white shadow-[0_10px_30px_rgba(90,80,160,0.08)] transition ${
              dragOver ? 'border-[#B9A8FF] ring-2 ring-[#E4DBFF]' : 'border-[#EEEDF5]'
            } ${keyboardOpen ? 'p-1.5' : 'p-2.5 lg:p-3'}`}
            onDragOver={(e) => {
              if (!e.dataTransfer?.types.includes('Files')) return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              if (!e.dataTransfer?.files?.length) return;
              e.preventDefault();
              setDragOver(false);
              void uploadFiles(e.dataTransfer.files);
            }}
          >
            <div className="flex items-end gap-2">
              <button
                type="button"
                className="relative mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[#EFEDF6] text-[#8A8A9A] transition hover:bg-[#FAF9FF] active:scale-95"
                title="사진·파일 첨부"
                aria-label="사진·파일 첨부"
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip size={19} />
                {pending.length ? (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#7C63F6] px-1 text-[10px] font-bold text-white">
                    {pending.length}
                  </span>
                ) : null}
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.html,.css,.xml,.yaml,.yml,audio/*,.m4a,.mp3,.wav,.ogg,.webm,.aac,.flac"
                className="hidden"
                onChange={(e) => {
                  void uploadFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(140, el.scrollHeight)}px`;
                }}
                onKeyDown={onKeyDown}
                onPaste={(e) => {
                  // 클립보드에 복사한 이미지는 바로 첨부한다(스크린숫·사진 복붙).
                  const files = Array.from(e.clipboardData?.files || []);
                  if (!files.length) return;
                  e.preventDefault();
                  void uploadFiles(files);
                }}
                onFocus={() => {
                  // 키보드가 올라오기 시작한 직후에도 최신 메시지가 가려지지 않게
                  pinToBottom('auto');
                  window.setTimeout(() => pinToBottom('auto'), 260);
                }}
                enterKeyHint={touchKeyboard ? 'enter' : 'send'}
                placeholder={aiReady ? `${profile.agentName || '포몽'}에게 물어보세요…` : 'AI 키를 먼저 연결해 주세요'}
                className="pa-scroll max-h-[140px] min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2.5 text-[16px] leading-relaxed placeholder:text-[#B7B4C6] focus:outline-none"
              />
              <button
                className={`relative mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition active:scale-95 ${
                  listening
                    ? 'border-[#FFD3E2] bg-[#FFEFF3] text-[#E2568B] shadow-[0_0_0_4px_rgba(226,86,139,0.12)]'
                    : 'border-[#EFEDF6] text-[#8A8A9A] hover:bg-[#FAF9FF]'
                }`}
                onClick={toggleDictation}
                title={listening ? '음성 입력 멈추기' : '음성으로 말하기'}
                aria-label={listening ? '음성 입력 멈추기' : '음성 입력'}
                aria-pressed={listening}
              >
                {listening ? <span className="absolute h-11 w-11 animate-ping rounded-full bg-[#FFE0EA]/60" /> : null}
                <Mic size={18} className={listening ? 'relative animate-pulse' : 'relative'} />
              </button>
              {sending ? (
                <button
                  className="mb-0.5 flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#E5484D] px-3.5 text-[13px] font-bold text-white shadow-float transition active:scale-95"
                  onClick={() => void stop()}
                  aria-label="AI 답장 중지"
                  title="AI 답장 중지"
                >
                  <Square size={12} fill="currentColor" strokeWidth={0} />
                  중지
                </button>
              ) : (
                <button
                  className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow-float transition active:scale-95 disabled:opacity-40"
                  style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
                  onClick={submit}
                  disabled={!draft.trim() && !pending.length}
                  aria-label="보내기"
                >
                  <Send size={18} />
                </button>
              )}
            </div>
          </div>
          {listening || voiceHint ? (
            <p
              className={`mt-1.5 flex items-start justify-center gap-1.5 rounded-xl px-2 py-1 text-center text-[11.5px] font-medium ${
                listening ? 'text-[#E2568B]' : 'text-[#8A82B8]'
              }`}
              role="status"
              aria-live="polite"
            >
              {listening ? <span className="mt-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#E2568B]" /> : null}
              <span className="min-w-0">{listening ? '듣고 있어요 · 말씀을 마치면 마이크를 한 번 더 누르세요' : null}</span>
              {voiceHint ? <span className={listening ? 'hidden' : 'min-w-0'}>{voiceHint}</span> : null}
            </p>
          ) : null}
          {!keyboardOpen && !listening && !voiceHint ? (
            <p className={`mt-2 text-center text-[11.5px] text-[#C0BCCD] ${touchKeyboard ? '' : 'hidden lg:block'}`}>
              {touchKeyboard
                ? '엔터는 줄바꿈이에요 · 보내기는 오른쪽 버튼'
                : 'Enter 전송 / Shift+Enter 줄바꿈 · 사진·파일도 붙여서 보낼 수 있어요'}
            </p>
          ) : null}
        </div>
      </div>

      <RoomDrawer open={drawer} onClose={() => setDrawer(false)} />

      <MessageSearch
        open={searchOpen}
        sessionId={activeSession}
        onClose={() => setSearchOpen(false)}
        onPick={async (sessionId, messageId) => {
          setSearchOpen(false);
          if (sessionId !== activeSession) await switchSession(sessionId);
          setHighlight(messageId);
          window.setTimeout(() => {
            document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, sessionId !== activeSession ? 420 : 60);
          window.setTimeout(() => setHighlight(null), 2600);
        }}
      />

      {/* 사진 크게 보기 */}
      {preview ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreview(null)}
          role="button"
          aria-label="사진 닫기"
        >
          <img src={preview.url} alt={preview.name} className="max-h-[86vh] max-w-full rounded-2xl object-contain" />
          <button
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white"
            onClick={() => setPreview(null)}
            aria-label="닫기"
          >
            <X size={20} />
          </button>
        </div>
      ) : null}
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

/**
 * v0.6.3: 메일 발송 확인 카드
 * AI가 mail_send로 만든 초안을 보여 주고, 사용자가 「보내기」를 눌렀을 때만 발송한다.
 */
function MailDraftCardView({ draft }: { draft: MailDraftCard }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [note, setNote] = useState('');

  const send = async () => {
    setState('sending');
    setNote('');
    try {
      const res = await api.post<{ ok: boolean; draft?: { sentAt?: string } }>('/api/mail/send', { draftId: draft.id });
      if (!res.ok) throw new Error('보내지 못했어요.');
      setState('sent');
      setNote('메일을 보냈어요.');
    } catch (err) {
      setState('error');
      setNote(err instanceof Error ? err.message : '보내지 못했어요.');
    }
  };

  const discard = async () => {
    await api.post('/api/mail/discard', { draftId: draft.id }).catch(() => undefined);
    setState('sent');
    setNote('보내지 않고 취소했어요.');
  };

  return (
    <div className="mt-3 rounded-[18px] border border-[#E7E2FA] bg-[#FBFAFF] p-3.5 dark:bg-[#1E1B29]">
      <div className="flex items-center gap-1.5 text-[12px] font-bold text-[#5B4BC4]">
        <Mail size={13} /> 메일 발송 확인
      </div>
      <dl className="mt-2 space-y-1 text-[12.5px]">
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-[#8A8A9A]">받는 사람</dt>
          <dd className="min-w-0 flex-1 break-all font-medium text-[#3B3947]">{draft.to.join(', ')}</dd>
        </div>
        {draft.cc?.length ? (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-[#8A8A9A]">참조</dt>
            <dd className="min-w-0 flex-1 break-all font-medium text-[#3B3947]">{draft.cc.join(', ')}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-[#8A8A9A]">제목</dt>
          <dd className="min-w-0 flex-1 font-semibold text-[#2A2A35]">{draft.subject}</dd>
        </div>
      </dl>
      <p className="pa-scroll mt-2 max-h-[132px] overflow-y-auto whitespace-pre-wrap rounded-xl bg-white px-3 py-2 text-[12.5px] leading-[1.65] text-[#4B4856] ring-1 ring-[#F1EEFB] dark:bg-[#17151F]">
        {draft.text}
      </p>
      <p className="mt-1.5 text-[11px] text-[#A8A5B8]">보내는 계정: {draft.accountEmail}</p>
      {state === 'sent' ? (
        <p className="mt-2 rounded-xl bg-[#EAFBF1] px-3 py-2 text-[12.5px] font-semibold text-[#12B886]">{note}</p>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <button className="pa-btn-ghost flex-1 py-2.5 text-[13px]" onClick={() => void discard()} disabled={state === 'sending'}>
            취소
          </button>
          <button className="pa-btn-primary flex-1 py-2.5 text-[13px]" onClick={() => void send()} disabled={state === 'sending'}>
            {state === 'sending' ? '보내는 중…' : '보내기'}
          </button>
        </div>
      )}
      {state === 'error' && note ? <p className="mt-1.5 text-[11.5px] text-[#E5484D]">{note}</p> : null}
    </div>
  );
}

function AssistantBubble({
  message,
  character,
  agentName,
  taskRun,
  loginRequests = [],
  unlockRequests = [],
  vault,
  onLoginSubmit,
  onLoginDismiss,
  onUnlockSubmit,
  onUnlockDismiss,
  onPreview,
  onReply,
}: {
  message: ChatMessage;
  character: string;
  agentName: string;
  taskRun?: TaskRun | null;
  loginRequests?: LoginRequest[];
  unlockRequests?: VaultUnlockRequest[];
  vault: { configured: boolean; unlocked: boolean };
  onLoginSubmit: (id: string, input: { username: string; password: string; masterPin?: string }) => Promise<{ ok: boolean; message?: string }>;
  onLoginDismiss: (id: string) => Promise<void>;
  onUnlockSubmit: (id: string, pin: string) => Promise<{ ok: boolean; message?: string }>;
  onUnlockDismiss: (id: string) => Promise<void>;
  onPreview: (p: { url: string; name: string }) => void;
  /** v0.6.3: 이 답변에 답장(인용)하기 */
  onReply?: () => void;
}) {
  const { models } = useAppStore();
  /**
   * v0.6.18: 긴 답변은 처음엔 접어 두고 '더 보기'로 펼친다(대화 흐름이 길어지지 않게).
   * 첫 말풍선은 9줄·560자까지만 보여 주고, 그림자가 아니라 부드러 로 끝을 흐린다.
   */
  const [expanded, setExpanded] = useState(false);
  const contentLines = message.content.split('\n');
  const isLong = message.content.length > 640 || contentLines.length > 14;
  const previewText = `${contentLines.slice(0, 9).join('\n').slice(0, 560).trimEnd()}\n…`;
  const shownText = isLong && !expanded ? previewText : message.content;
  // v0.5.4: 답변 복사 (한 번 누르면 원문 그대로 클립보드로)
  const [copied, setCopied] = useState(false);
  // v0.5.5: 답변 읽어주기 — 다른 말풍선을 읽는 중이면 자동으로 멈추고 이 답변을 읽는다.
  const speechKey = `msg-${message.id}`;
  const speaking = useSyncExternalStore(subscribeSpeech, getSpeakingKey, () => null) === speechKey;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      // 클립보드 API가 막힌 환경(구형 iOS) 폴백
      const area = document.createElement('textarea');
      area.value = message.content;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
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
        <div className="relative selectable-text">
          <RichText text={shownText} />
          {isLong && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-[20px] bg-gradient-to-t from-white to-transparent dark:from-[#1B1923]" />
          ) : null}
        </div>
        {isLong ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="mt-1.5 flex items-center gap-1 rounded-full bg-[#F7F5FF] px-2.5 py-1 text-[11.5px] font-semibold text-[#7C63F6] transition active:scale-95"
            aria-expanded={expanded}
          >
            <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            {expanded ? '접기' : `더 보기 (${contentLines.length}줄)`}
          </button>
        ) : null}
        {message.meta?.mailDraft ? <MailDraftCardView draft={message.meta.mailDraft as MailDraftCard} /> : null}
        {message.attachments?.length ? (
          <div className="mt-2.5 flex justify-start">
            <MessageAttachments items={message.attachments} onPreview={onPreview} />
          </div>
        ) : null}
        {message.reactions?.length ? (
          <div className="mt-2">
            <ReactionBadges items={message.reactions} align="start" />
          </div>
        ) : null}
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
        {unlockRequests
          .filter((request) => request.status === 'pending')
          .map((request) => (
            <VaultPinCard
              key={request.id}
              request={request}
              onSubmit={onUnlockSubmit}
              onDismiss={onUnlockDismiss}
            />
          ))}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-[11.5px] text-[#C0BCCD]">
          <span className="shrink-0 whitespace-nowrap">{formatChatStamp(message.createdAt)}</span>
          {answeredLabel ? (
            <span className="ml-1 hidden shrink-0 whitespace-nowrap rounded-full bg-[#FAF9FD] px-1.5 py-0.5 text-[10.5px] font-medium text-[#B4B1C2] sm:inline-block" title="실제 응답한 모델">
              {answeredLabel}
            </span>
          ) : null}
          {message.meta?.tools?.length ? (
            <span className="ml-1 shrink-0 whitespace-nowrap rounded-full bg-[#F7F5FF] px-1.5 py-0.5 text-[10.5px] font-medium text-[#9B98AB]">
              도구 {message.meta.tools.length}회
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {onReply ? (
              <button
                className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-medium text-[#B4B1C2] transition hover:bg-[#F7F5FF] hover:text-[#7C63F6] active:scale-95"
                onClick={onReply}
                aria-label="이 답변에 답장"
                title="이 답변에 답장"
              >
                <Reply size={11} /> 답장
              </button>
            ) : null}
            <button
              className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-medium transition ${
                speaking
                  ? 'bg-[#F1ECFF] text-[#7C63F6]'
                  : 'text-[#B4B1C2] hover:bg-[#F7F5FF] hover:text-[#7C63F6]'
              }`}
              onClick={() => toggleSpeech(speechKey, message.content)}
              aria-label={speaking ? '읽어주기 멈춤' : '답변 읽어주기'}
              title={speaking ? '읽어주기 멈춤' : '답변 읽어주기'}
              aria-pressed={speaking}
            >
              {speaking ? <Square size={10} fill="currentColor" strokeWidth={0} /> : <Volume2 size={11} />}
              {speaking ? '멈춤' : '듣기'}
            </button>
            <button
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-medium text-[#B4B1C2] transition hover:bg-[#F7F5FF] hover:text-[#7C63F6]"
              onClick={() => void copy()}
              aria-label="답변 복사"
              title="답변 복사"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? '복사됨' : '복사'}
            </button>
          </div>
          <span className="sr-only">{agentName}</span>
        </div>
        </div>
      </div>
    </div>
  );
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * v0.6.15: 비서가 남긴 말풍선 이모지 리액션.
 * 말풍선에 살짝 겹치도록 작고 둥글게 — 라이트/다크 모두 배경과 구분되게 흰 캡슐 + 옅은 테두리.
 */
function ReactionBadges({ items, align = 'end' }: { items: string[]; align?: 'start' | 'end' }) {
  return (
    <div className={`flex flex-wrap items-center gap-1 ${align === 'start' ? 'justify-start' : 'justify-end'}`}>
      {items.map((emoji) => (
        <span
          key={emoji}
          title="비서가 남긴 리액션"
          className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-white px-1.5 text-[13px] leading-none shadow-[0_2px_8px_rgba(120,100,200,0.16)] ring-1 ring-[#ECE7F8] dark:bg-[#2B2838] dark:ring-[#3C3849]"
        >
          {emoji}
        </span>
      ))}
    </div>
  );
}

/** 말풍선에 붙은 사진 썸네일과 파일 칩 (v0.5.2) */
function MessageAttachments({
  items,
  onPreview,
}: {
  items: ChatAttachment[];
  onPreview: (p: { url: string; name: string }) => void;
}) {
  const images = items.filter((i) => i.kind === 'image');
  const files = items.filter((i) => i.kind !== 'image');
  return (
    <div className="flex flex-col items-end gap-1.5">
      {images.length ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((img) => (
            <img
              key={img.id}
              src={img.url}
              alt={img.filename}
              loading="lazy"
              className="h-28 w-28 cursor-zoom-in rounded-2xl object-cover shadow-sm ring-1 ring-[#E9E3FA] sm:h-32 sm:w-32"
              onClick={() => onPreview({ url: img.url, name: img.filename })}
            />
          ))}
        </div>
      ) : null}
      {files.map((file) => (
        <a
          key={file.id}
          href={file.downloadUrl}
          className="flex max-w-[280px] items-center gap-2 rounded-xl bg-white px-2.5 py-2 shadow-sm ring-1 ring-[#EAE6F6] transition active:scale-[0.99]"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#F5F1FF] text-[#7C63F6]">
            <FileText size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-[#3B3947]">{file.filename}</span>
            <span className="block text-[10.5px] text-[#A8A5B8]">
              {fileSize(file.size)} · {file.kind === 'pdf' ? 'PDF' : file.kind === 'text' ? '텍스트' : '파일'} 내려받기
            </span>
          </span>
          <Download size={13} className="shrink-0 text-[#B4B1C2]" />
        </a>
      ))}
    </div>
  );
}

/** 작업 중 먼저 도착하는 짧은 안내 말풍선(chat_notify) */
function NoticeBubble({ message, character }: { message: ChatMessage; character: string }) {
  const automation = message.meta?.automation;
  return (
    <div className="flex items-start gap-2.5 animate-fade-up lg:gap-3.5">
      <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F1ECFF] ring-1 ring-[#EAE3FF] sm:flex lg:h-11 lg:w-11">
        <Mascot name={character as MascotName} size={24} />
      </div>
      <div className="min-w-0 max-w-[88%] rounded-[20px] rounded-tl-md bg-[#F8F5FF] px-4 py-3 ring-1 ring-[#EFE7FF] sm:max-w-[76%]">
        {automation ? (
          <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[10.5px] font-bold text-[#7C63F6] ring-1 ring-[#EAE3FF]">
          {automation === 'job' ? '예약 실행 결과' : automation === 'parcel' ? '택배 알림' : '워치 알림'}
          </span>
        ) : null}
        <p className="whitespace-pre-line text-[14.5px] leading-[1.65] text-[#4B3FA6]">{message.content}</p>
        <span className="mt-1 block text-[11px] text-[#B4A9DA]">{formatClock(message.createdAt)}</span>
      </div>
    </div>
  );
}

/** 채팅 안에서 계정을 받는 보안 로그인 카드 (v0.5.1) */
/**
 * v0.6.18: 되돌리기 어려운 작업(도커 중지·재시작 등) 실행 전 승인 카드.
 * [승인]을 누르면 서버가 그 도구를 실제로 실행하고 결과를 채팅에 남긴다.
 */
function ApprovalCard({
  request,
  onApprove,
  onCancel,
}: {
  request: ApprovalRequest;
  onApprove: (id: string) => Promise<{ ok: boolean; message?: string }>;
  onCancel: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<'approve' | 'cancel' | null>(null);
  const [error, setError] = useState('');

  const approve = async () => {
    setBusy('approve');
    setError('');
    const result = await onApprove(request.id);
    setBusy(null);
    if (!result.ok) setError(result.message || '승인한 작업을 실행하지 못했어요.');
  };

  const cancel = async () => {
    setBusy('cancel');
    setError('');
    await onCancel(request.id);
    setBusy(null);
  };

  return (
    <div className="rounded-[24px] border-[1.5px] border-[#FFE4B8] bg-[#FFFBF2] p-4 shadow-card dark:border-[#4A3B22] dark:bg-[#241F17]">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FFF1D6] text-[#B97A11] dark:bg-[#3A2E1B]">
          <ShieldCheck size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-[#8A5B0B] dark:text-[#F0C77E]">승인을 기다리고 있어요</p>
          <p className="mt-1 text-[14px] font-semibold leading-[1.5] text-[#3B3947] dark:text-[#EDEAF6]">{request.title}</p>
          <p className="mt-1 break-words text-[12.5px] leading-[1.6] text-[#6B677A] dark:text-[#B7B2C6]">{request.detail}</p>
          {request.reason ? (
            <p className="mt-1.5 text-[11.5px] leading-[1.5] text-[#A9762A] dark:text-[#D8B47A]">{request.reason}</p>
          ) : null}
          {error ? <p className="mt-2 text-[11.5px] font-semibold text-[#E5484D]">{error}</p> : null}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={busy !== null}
              className="flex-1 rounded-xl bg-white py-2.5 text-[13px] font-semibold text-[#6B677A] ring-1 ring-[#E9E5F0] transition active:scale-[0.99] disabled:opacity-60 dark:bg-transparent dark:text-[#C9C5D6] dark:ring-[#3C3849]"
            >
              {busy === 'cancel' ? '취소 중…' : '취소'}
            </button>
            <button
              type="button"
              onClick={() => void approve()}
              disabled={busy !== null}
              className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-[#F0A32B] py-2.5 text-[13px] font-bold text-white transition active:scale-[0.99] disabled:opacity-60"
            >
              {busy === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {busy === 'approve' ? '실행 중…' : '승인'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
          <span className="block truncate text-[11px] text-[#8A82B8]">{request.loginUrl}</span>
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
          style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
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
function TaskCard({ run, live = false, startMs }: { run: TaskRun; live?: boolean; startMs?: number }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  /** v0.6.3: 단계별 duration 합 대신, 작업 시작 시각부터의 실제 경과 시간을 실시간으로 보여 준다. */
  const [now, setNow] = useState(() => Date.now());
  const active = live && (run.status === 'running' || !run.endedAt);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [active]);
  const meta =
    run.status === 'running'
      ? { label: '진행 중', color: '#7C63F6', bg: '#F1ECFF' }
      : run.status === 'failed'
        ? { label: '실패', color: '#E5484D', bg: '#FFF1F1' }
        : run.status === 'partial'
          ? { label: '일부 완료', color: '#C08A16', bg: '#FFF8E7' }
          : { label: '완료', color: '#0F9668', bg: '#EAFBF1' };
  const startedAt = new Date(run.startedAt).getTime();
  const begin = Number.isFinite(startedAt) ? (startMs ? Math.min(startMs, startedAt) : startedAt) : now;
  const finishedAt = run.endedAt ? new Date(run.endedAt).getTime() : null;
  const end = finishedAt && Number.isFinite(finishedAt) ? finishedAt : active ? now : Date.now();
  const elapsedMs = Math.max(0, end - begin);
  const elapsedLabel =
    elapsedMs < 10_000 ? `${(elapsedMs / 1000).toFixed(1)}초` : `${Math.round(elapsedMs / 1000)}초`;
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
          <span className="flex items-center gap-1.5 text-[11px] text-[#A8A5B8]" aria-live={active ? 'polite' : 'off'}>
            <Clock3 size={10} /> {run.steps}단계 · {elapsedLabel}
            {active ? <span className="h-1 w-1 animate-pulse rounded-full bg-[#B9A8FF]" /> : null}
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

/** 첨부 오류 줄 앞의 작은 경고 아이콘 (lucide 아이콘을 추가로 들이지 않는다) */
function AlertCircleIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-[3px] shrink-0"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
    </svg>
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


/* ------------------------------------------------------------------ */
/* v0.5.4: 금고 PIN 입력 카드                                          */
/* PIN은 입력 즉시 서버로만 보내고, 화면·기록 어디에도 남기지 않는다.      */
/* ------------------------------------------------------------------ */

function VaultPinCard({
  request,
  onSubmit,
  onDismiss,
}: {
  request: VaultUnlockRequest;
  onSubmit: (id: string, pin: string) => Promise<{ ok: boolean; message?: string }>;
  onDismiss: (id: string) => Promise<void>;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = request.status === 'unlocked';

  const submit = async () => {
    if (busy) return;
    if (!/^\d{4,12}$/.test(pin.trim())) {
      setError('PIN은 4~12자리 숫자입니다.');
      return;
    }
    setBusy(true);
    setError('');
    const res = await onSubmit(request.id, pin.trim());
    setBusy(false);
    setPin('');
    if (!res.ok) setError(res.message || 'PIN을 확인하지 못했어요.');
  };

  if (done) {
    return (
      <div className="mt-2.5 flex items-center gap-2.5 rounded-[16px] bg-[#EAFBF1] px-3.5 py-2.5 ring-1 ring-[#D6F3E3] animate-fade-up">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-[#0F9668]">
          <Check size={15} strokeWidth={3} />
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[#0B7B57]">
          금고 잠금을 풀었어요. 이어서 작업하는 중…
        </p>
        <Loader2 size={14} className="shrink-0 animate-spin text-[#0F9668]" />
      </div>
    );
  }

  return (
    <div className="mt-2.5 overflow-hidden rounded-[18px] bg-[#FFFBF3] ring-1 ring-[#F6E3BE] animate-fade-up">
      <div className="flex items-center gap-2.5 border-b border-[#F6E9CF] px-3.5 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white text-[#C08A16] shadow-sm">
          <Lock size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-bold text-[#8A6412]">금고 잠금 해제</span>
          <span className="block truncate text-[11px] text-[#A98B52]">
            {request.service ? `${request.service} · ` : ''}PIN을 넣으면 이어서 로그인할게요
          </span>
        </span>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#B4A184] transition hover:bg-white"
          onClick={() => void onDismiss(request.id)}
          aria-label="카드 닫기"
        >
          <X size={15} />
        </button>
      </div>
      <div className="space-y-2 px-3.5 py-3">
        <p className="text-[11.5px] leading-relaxed text-[#9A7C45]">
          {request.note || '금고가 잠겨 있어 자동 로그인을 시작하지 못했어요.'} PIN은 암호화 검증에만 쓰이고
          어디에도 저장되지 않아요.
        </p>
        <input
          className="w-full rounded-xl border border-[#EFE1C4] bg-white px-3 py-2.5 text-center text-[17px] tracking-[0.3em] text-[#2A2A35] outline-none focus:border-[#E5C77E]"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="••••"
          aria-label="금고 PIN"
        />
        {error ? <p className="text-[11.5px] font-medium text-[#E5484D]">{error}</p> : null}
        <button
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#E9B949] py-2.5 text-[13.5px] font-bold text-[#4A3608] transition active:scale-[0.99] disabled:opacity-50"
          onClick={() => void submit()}
          disabled={busy || pin.length < 4}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
          {busy ? '확인하는 중…' : 'PIN 넣고 이어서 로그인'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* v0.5.4: 대화방 드로어 (좌측 햄버거)                                  */
/* ------------------------------------------------------------------ */

function RoomDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { sessions, activeSession, switchSession, newSession, renameSession, deleteSession, clearChat } = useAppStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const startRename = (room: ChatSession) => {
    setEditing(room.id);
    setTitle(room.title);
  };

  const saveRename = async (id: string) => {
    if (!title.trim()) {
      setEditing(null);
      return;
    }
    await renameSession(id, title.trim());
    setEditing(null);
  };

  const remove = async (room: ChatSession) => {
    const message = room.isDefault
      ? `'${room.title}' 방의 대화를 모두 지울까요? (방은 남습니다)`
      : `'${room.title}' 방과 그 대화를 지울까요?`;
    if (!window.confirm(message)) return;
    await deleteSession(room.id);
  };

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-label="대화방 목록">
      <div className="absolute inset-0 bg-[#1F1D2B]/35 backdrop-blur-sm" onClick={onClose} />
      <aside
        className="relative flex h-full w-[86%] max-w-[330px] flex-col bg-[#FCFCFE] shadow-2xl animate-slide-right"
        style={{
          // v0.6.11: 드로어 상단 헤더가 iOS 상태바(시계·배터리) 흐림 영역에 닿지 않게 안전영역 안쪽으로 내린다.
          // v0.6.12: +12px 여백까지 더해 헤더가 너무 아래로 내려가 보여(IMG_3654), 상태바 아래 딱 붙는
          // max(12px, safe-area-inset-top) 로 줄였다(약 12px 위로 올림).
          paddingTop: 'max(12px, env(safe-area-inset-top, 0px))',
        }}
      >
        <div className="flex items-center justify-between border-b border-[#F1EFF8] px-4 py-3.5">
          <span className="flex items-center gap-2 text-[15px] font-bold text-[#1F1D2B]">
            <MessageSquare size={17} className="text-[#7C63F6]" /> 대화방
          </span>
          <button className="rounded-xl p-1.5 text-[#A8A5B8]" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </div>

        <div className="px-3 pt-3">
          <button
            className="flex w-full items-center justify-center gap-1.5 rounded-[14px] py-2.5 text-[13.5px] font-bold text-white transition active:scale-[0.99] disabled:opacity-60"
            style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const id = await newSession();
              setBusy(false);
              if (id) onClose();
            }}
          >
            <Plus size={16} /> 새 대화
          </button>
        </div>

        <div className="pa-scroll mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sessions.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-[#A8A5B8]">대화방이 없어요.</p>
          ) : null}
          {sessions.map((room) => {
            const active = room.id === activeSession;
            return (
              <div
                key={room.id}
                className={`group mb-1 rounded-[14px] px-2.5 py-2 transition ${
                  active ? 'bg-[#F3EEFF] ring-1 ring-[#E4DBFF]' : 'hover:bg-[#F8F7FC]'
                }`}
              >
                {editing === room.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      className="pa-input h-8 flex-1 py-1 text-[13px]"
                      value={title}
                      autoFocus
                      onChange={(e) => setTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename(room.id);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                    <button
                      className="rounded-lg bg-[#7C63F6] px-2 py-1 text-[11.5px] font-bold text-white"
                      onClick={() => void saveRename(room.id)}
                    >
                      저장
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start gap-1.5">
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={async () => {
                        await switchSession(room.id);
                        onClose();
                      }}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className={`min-w-0 flex-1 truncate text-[13.5px] font-semibold ${active ? 'text-[#5B4BC4]' : 'text-[#3B3947]'}`}>
                          {room.title}
                        </span>
                        {/* v0.6.3: 마지막 대화 시각 — 오늘이 아니면 날짜(어제·11월 19일)로 표시 */}
                        <span className="shrink-0 text-[10.5px] font-medium text-[#B4B1C2]" title={new Date(room.updatedAt).toLocaleString('ko-KR')}>
                          {formatRoomStampFull(room.updatedAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-[#A8A5B8]">
                        {room.messageCount ? `${room.messageCount}개 · ${room.preview}` : '아직 대화가 없어요'}
                      </span>
                    </button>
                    <button
                      className="rounded-lg p-1 text-[#C9C5D6] hover:text-[#7C63F6]"
                      onClick={() => startRename(room)}
                      aria-label="이름 바꾸기"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="rounded-lg p-1 text-[#D9D5E4] hover:text-[#E5484D]"
                      onClick={() => void remove(room)}
                      aria-label="방 지우기"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-[#F1EFF8] px-3 py-3">
          <button
            className="flex w-full items-center justify-center gap-1.5 rounded-[12px] bg-[#FAF9FD] py-2.5 text-[12.5px] font-semibold text-[#6B677A]"
            onClick={async () => {
              if (!window.confirm('지금 대화의 메시지를 모두 지울까요?')) return;
              await clearChat();
              onClose();
            }}
          >
            <RotateCcwIcon /> 이 대화 비우기
          </button>
        </div>
      </aside>
    </div>
  );
}

function RotateCcwIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* v0.5.4: 채팅 메시지 검색                                            */
/* ------------------------------------------------------------------ */

function MessageSearch({
  open,
  sessionId,
  onClose,
  onPick,
}: {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  onPick: (sessionId: string, messageId: number) => void | Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [allRooms, setAllRooms] = useState(false);
  const [results, setResults] = useState<{ id: number; sessionId: string; sessionTitle: string; role: string; snippet: string; createdAt: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setQ('');
      setResults([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) {
      setResults([]);
      return;
    }
    let alive = true;
    setBusy(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: term });
      if (!allRooms) params.set('session', sessionId);
      api
        .get<{ results: typeof results }>(`/api/chat/search?${params.toString()}`)
        .then((r) => {
          if (alive) setResults(r.results || []);
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setBusy(false);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [q, open, allRooms, sessionId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-[#1F1D2B]/30 px-3 pt-[8vh] backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-[22px] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[#F1EFF8] px-3.5 py-3">
          <Search size={17} className="shrink-0 text-[#B7B4C6]" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[#B7B4C6]"
            placeholder="대화 내용 검색"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="rounded-lg p-1 text-[#A8A5B8]" onClick={onClose} aria-label="닫기">
            <X size={17} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 px-3.5 py-2">
          <button
            className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${!allRooms ? 'bg-[#F3EEFF] text-[#7C63F6]' : 'bg-[#FAF9FD] text-[#8A8A9A]'}`}
            onClick={() => setAllRooms(false)}
          >
            이 대화방
          </button>
          <button
            className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${allRooms ? 'bg-[#F3EEFF] text-[#7C63F6]' : 'bg-[#FAF9FD] text-[#8A8A9A]'}`}
            onClick={() => setAllRooms(true)}
          >
            모든 대화방
          </button>
          {busy ? <Loader2 size={13} className="ml-auto animate-spin text-[#B9A8FF]" /> : null}
        </div>
        <div className="pa-scroll max-h-[52vh] overflow-y-auto px-2 pb-3">
          {q.trim() && !results.length && !busy ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-[#A8A5B8]">검색 결과가 없어요.</p>
          ) : null}
          {results.map((item) => (
            <button
              key={`${item.sessionId}-${item.id}`}
              className="mb-1 flex w-full items-start gap-2.5 rounded-[14px] px-2.5 py-2.5 text-left transition hover:bg-[#F8F7FC]"
              onClick={() => void onPick(item.sessionId, item.id)}
            >
              <span
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                  item.role === 'user' ? 'bg-[#F3EEFF] text-[#7C63F6]' : 'bg-[#FFF0F5] text-[#E2568B]'
                }`}
              >
                {item.role === 'user' ? <MessageSquare size={13} /> : <Sparkles size={13} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-semibold text-[#A8A5B8]">
                  {item.sessionTitle} · {formatRoomStamp(item.createdAt)}
                </span>
                <span className="mt-0.5 block line-clamp-2 text-[13px] leading-[1.5] text-[#3B3947]">{item.snippet}</span>
              </span>
              <ChevronRight size={14} className="mt-2 shrink-0 text-[#C9C5D6]" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
