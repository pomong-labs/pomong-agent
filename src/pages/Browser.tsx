import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Globe,
  Loader2,
  Lock,
  MoreVertical,
  MousePointerClick,
  Play,
  RotateCw,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import Mascot, { type MascotName } from '../components/Mascot';
import { api, type BrowserAction, type BrowserSession } from '../lib/api';
import { relativeTime, timeLabel, useAppEvents } from '../lib/events';
import { useAppStore } from '../lib/store';

const VIEW_W = 1280;
const VIEW_H = 800;

/** 모바일 상태 pill에 들어갈 짧은 사유 표기 */
const REASON_SHORT: Record<string, string> = {
  login: '로그인',
  otp: '인증번호',
  captcha: '캡차',
  payment: '결제',
  identity: '본인인증',
  manual: '수동',
};

export default function Browser() {
  const { profile } = useAppStore();
  const navigate = useNavigate();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [status, setStatus] = useState<{ enabled: boolean; connected: boolean } | null>(null);
  const [error, setError] = useState('');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actions, setActions] = useState<BrowserAction[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [address, setAddress] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  const [typed, setTyped] = useState('');
  const [hint, setHint] = useState('');
  const frameRef = useRef<string | null>(null);
  const etagRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await api.get<{ enabled: boolean; connected: boolean; sessions: BrowserSession[] }>('/api/browser/status');
      setStatus({ enabled: res.enabled, connected: res.connected });
      const current = res.sessions[0] || null;
      setSession(current);
      if (current?.url) setAddress(current.url);
      setError('');
    } catch (err) {
      setStatus({ enabled: false, connected: false });
      setError(err instanceof Error ? err.message : '브라우저 상태를 읽지 못했어요.');
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 4000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  useAppEvents((event) => {
    if (event.type === 'handover' || event.type === 'browser') void loadStatus();
  });

  const loadActions = useCallback(async (id: string) => {
    const res = await api.get<{ actions: BrowserAction[] }>(`/api/browser/sessions/${id}/actions`).catch(() => ({ actions: [] }));
    setActions(res.actions);
  }, []);

  useEffect(() => {
    if (!session) {
      setActions([]);
      return;
    }
    if (showLog) void loadActions(session.id);
  }, [session, showLog, loadActions]);

  /* 화면 스트림: 0.7초마다 최신 프레임을 받아 교체한다(같은 화면이면 204). */
  const streamId = session?.id;
  const streamAlive = session?.alive;

  useEffect(() => {
    if (!streamId || !streamAlive) {
      if (frameRef.current) {
        URL.revokeObjectURL(frameRef.current);
        frameRef.current = null;
        setFrameUrl(null);
      }
      return;
    }
    let stopped = false;
    let failures = 0;

    const tick = async () => {
      while (!stopped) {
        try {
          const res = await fetch(`/api/browser/sessions/${streamId}/frame?t=${Date.now()}`, {
            credentials: 'same-origin',
            headers: etagRef.current ? { 'If-None-Match': etagRef.current } : undefined,
          });
          if (res.status === 304) {
            failures = 0;
          } else if (res.ok) {
            etagRef.current = res.headers.get('ETag');
            const blob = await res.blob();
            const next = URL.createObjectURL(blob);
            if (frameRef.current) URL.revokeObjectURL(frameRef.current);
            frameRef.current = next;
            setFrameUrl(next);
            failures = 0;
            setError('');
          } else {
            failures += 1;
            if (failures === 3) {
              const data = (await res.json().catch(() => null)) as { message?: string } | null;
              setError(data?.message || '화면을 불러오지 못했어요. 브라우저 워커가 켜져 있는지 확인해 주세요.');
            }
          }
        } catch {
          failures += 1;
        }
        await new Promise((resolve) => window.setTimeout(resolve, failures > 2 ? 3000 : 700));
      }
    };
    void tick();

    return () => {
      stopped = true;
      if (frameRef.current) {
        URL.revokeObjectURL(frameRef.current);
        frameRef.current = null;
      }
      setFrameUrl(null);
    };
  }, [streamId, streamAlive]);

  const startSession = async () => {
    setStarting(true);
    setError('');
    try {
      const res = await api.post<{ session: BrowserSession }>('/api/browser/sessions', {});
      setSession(res.session);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '브라우저를 열지 못했어요.');
    } finally {
      setStarting(false);
    }
  };

  const sendInput = async (payload: Record<string, unknown>) => {
    if (!session) return;
    try {
      await api.post(`/api/browser/sessions/${session.id}/input`, payload);
      setHint('');
    } catch (err) {
      setHint(err instanceof Error ? err.message : '입력을 전달하지 못했어요.');
    }
  };

  const takeControl = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await api.post(`/api/browser/sessions/${session.id}/handover`, { reason: session.handoverReason || 'manual', detail: '내가 직접 조작할게요' });
      await loadStatus();
    } catch (err) {
      setHint(err instanceof Error ? err.message : '제어권을 받지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  const giveBack = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await api.post(`/api/browser/sessions/${session.id}/resume`);
      await loadStatus();
      inputRef.current?.blur();
    } catch (err) {
      setHint(err instanceof Error ? err.message : '넘기지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  const closeSession = async () => {
    if (!session) return;
    await api.del(`/api/browser/sessions/${session.id}`).catch(() => undefined);
    setSession(null);
    await loadStatus();
  };

  const onFrameClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!session) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * VIEW_W);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * VIEW_H);
    if (session.controlOwner !== 'user') {
      setHint('AI가 조작 중이에요. 「제어권: 나」를 누르면 직접 누를 수 있어요.');
      return;
    }
    void sendInput({ type: 'click', x, y });
  };

  const onTypeKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (session?.controlOwner !== 'user') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendInput({ type: 'key', key: 'Enter' });
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      void sendInput({ type: 'key', key: 'Backspace' });
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      void sendInput({ type: 'key', key: 'Tab' });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      void sendInput({ type: 'text', text: event.key });
    }
  };

  const userControl = session?.controlOwner === 'user';
  const remaining = session?.leaseExpiresAt ? Math.max(0, Math.round((new Date(session.leaseExpiresAt).getTime() - Date.now()) / 60000)) : 0;

  return (
    <div className="pa-scroll flex h-full min-h-0 flex-col overflow-y-auto px-4 pb-28 pt-4 lg:px-10 lg:pt-7 lg:pb-8">
      <div className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col">
        {/* ---------- 모바일 헤더 ---------- */}
        <header className="flex items-center gap-2.5 lg:hidden">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white shadow-[0_6px_18px_rgba(120,100,200,0.14)] ring-1 ring-[#F4F0FF]">
            <Mascot name={profile.character as MascotName} hero size={30} />
          </span>
          <h1 className="min-w-0 flex-1 truncate text-[19px] font-bold tracking-[-0.02em]">Pomong Browser</h1>
          <span
            className={`rounded-full px-2.5 py-1 text-[11.5px] font-bold ${
              userControl ? 'bg-[#FFE9EF] text-[#E2568B]' : 'bg-[#EAFBF1] text-[#0F9668]'
            }`}
          >
            {userControl ? `직접 조작 중 · ${session?.handoverReason ? REASON_SHORT[session.handoverReason] || '수동' : '수동'}` : 'AI 조작 중'}
          </span>
        </header>

        {/* ---------- PC 헤더 ---------- */}
        <div className="hidden items-center justify-between gap-3 lg:flex">
          <div>
            <h1 className="text-[30px] font-bold tracking-[-0.02em]">자율 브라우저</h1>
            <p className="mt-1 text-[14.5px] text-pomong-sub">
              AI가 직접 눌러 보고, 로그인·결제는 내가 이어받아요 · {status?.connected ? '브라우저 연결됨' : '브라우저 대기'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {session ? (
              <button className="pa-btn-ghost px-4 py-2 text-[13px]" onClick={closeSession}>
                세션 닫기
              </button>
            ) : null}
            <button className="pa-btn-ghost px-4 py-2 text-[13px]" onClick={() => navigate('/automation')}>
              자동화
            </button>
          </div>
        </div>

        {/* ---------- 세션 없음 ---------- */}
        {!session ? (
          <div className="mt-5 rounded-[22px] bg-white p-6 shadow-card ring-1 ring-[#F6F4FB]">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#F1ECFF] text-[#7C63F6]">
                <Globe size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[16px] font-bold text-[#1F1D2B]">아직 브라우저 화면이 없어요</h2>
                <p className="mt-1 text-[13px] leading-[1.6] text-[#6B677A]">
                  채팅에서 “이 사이트 열어서 확인해줘”라고 하거나, 아래 버튼으로 직접 세션을 열 수 있어요.
                  로그인·결제 화면은 자동으로 내게 넘어와요.
                </p>
              </div>
            </div>
            {error ? <p className="mt-3 rounded-[12px] bg-[#FFF6F6] px-3 py-2 text-[12.5px] text-[#B2373B]">{error}</p> : null}
            <button className="pa-btn-primary mt-4 w-full py-3 lg:w-auto lg:px-6" onClick={startSession} disabled={starting}>
              {starting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} 브라우저 열기
            </button>
            {status && !status.enabled ? (
              <p className="mt-2 text-[11.5px] text-[#A8A5B8]">이 서버는 브라우저 기능이 꺼져 있어요(BROWSER_ENABLED=0).</p>
            ) : null}
          </div>
        ) : null}

        {/* ---------- 세션 있음 ---------- */}
        {session ? (
          <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
            {/* PC 핸드오버 배너 */}
            {userControl ? (
              <div className="hidden items-center gap-3 rounded-[20px] bg-[#FFF3EC] px-4 py-3 ring-1 ring-[#FFDFCC] lg:flex">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-[#F08C4B] shadow-sm">
                  <AlertTriangle size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[17px] font-bold text-[#D2694A]">{session.handoverLabel || '화면을 넘겨받았어요'}!</h2>
                  <p className="text-[12.5px] text-[#A9745B]">{session.controlDetail || '직접 입력 후 완료를 눌러주세요'} · 남은 시간 {remaining}분</p>
                </div>
                <button
                  className="flex items-center gap-1.5 rounded-full bg-[#D9F7EA] px-4 py-2 text-[13px] font-bold text-[#0F9668] shadow-sm disabled:opacity-60"
                  onClick={giveBack}
                  disabled={busy}
                >
                  <CheckCircle2 size={15} /> 인증 완료 · AI 재개
                </button>
                <span className="rounded-full bg-[#FFE1EA] px-4 py-2 text-[13px] font-bold text-[#E2568B]">제어권: 나</span>
                <Mascot name={profile.character as MascotName} hero size={44} />
              </div>
            ) : null}

            {/* 브라우저 크롬 */}
            <div className="overflow-hidden rounded-[20px] bg-white shadow-card ring-1 ring-[#F2EFFA]">
              <div className="flex items-center gap-1.5 border-b border-[#F4F2FA] px-2.5 py-2">
                <button className="rounded-lg p-2 text-[#6B677A] hover:bg-[#F7F5FF]" onClick={() => void sendInput({ type: 'back' })} aria-label="뒤로">
                  <ArrowLeft size={17} />
                </button>
                <button className="hidden rounded-lg p-2 text-[#6B677A] hover:bg-[#F7F5FF] sm:block" onClick={() => void sendInput({ type: 'forward' })} aria-label="앞으로">
                  <ArrowRight size={17} />
                </button>
                <button className="rounded-lg p-2 text-[#6B677A] hover:bg-[#F7F5FF]" onClick={() => void sendInput({ type: 'reload' })} aria-label="새로고침">
                  <RotateCw size={17} />
                </button>
                {editingAddress ? (
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded-full bg-[#F7F5FF] px-3 py-1.5 text-[12.5px] focus:outline-none"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setEditingAddress(false);
                        void sendInput({ type: 'goto', url: address });
                      }
                      if (e.key === 'Escape') setEditingAddress(false);
                    }}
                    onBlur={() => setEditingAddress(false)}
                  />
                ) : (
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-[#F7F5FF] px-3 py-1.5 text-left text-[12.5px] text-[#5B5866]"
                    onClick={() => setEditingAddress(true)}
                    title="주소 입력"
                  >
                    <Lock size={12} className="shrink-0 text-[#9B98AB]" />
                    <span className="truncate">{session.url || 'about:blank'}</span>
                  </button>
                )}
                <button className="hidden rounded-lg p-2 text-[#B4B1C2] sm:block" aria-label="즐겨찾기">
                  <Star size={16} />
                </button>
                <button className="rounded-lg p-2 text-[#6B677A] hover:bg-[#F7F5FF]" onClick={() => setShowLog((v) => !v)} aria-label="메뉴">
                  <MoreVertical size={17} />
                </button>
              </div>

              {/* 화면 */}
              <div className="relative bg-[#F7F8FB]">
                <div className="relative w-full" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }} onClick={onFrameClick}>
                  {frameUrl ? (
                    <img src={frameUrl} alt="브라우저 화면" className="h-full w-full select-none object-contain" draggable={false} />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[13px] text-[#A8A5B8]">
                      <Loader2 size={18} className="mr-2 animate-spin" /> 화면을 불러오는 중…
                    </div>
                  )}
                  {!userControl ? (
                    <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-[#1F1D2B]/60 px-2.5 py-1 text-[11px] font-semibold text-white">
                      AI 조작 중 · 보기 전용
                    </span>
                  ) : (
                    <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-[#E2568B]/90 px-2.5 py-1 text-[11px] font-semibold text-white">
                      직접 조작 중 · 남은 {remaining}분
                    </span>
                  )}
                </div>

                {!userControl ? (
                  <button
                    className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-2 text-[12.5px] font-bold text-[#7C63F6] shadow-float"
                    onClick={takeControl}
                    disabled={busy}
                  >
                    <MousePointerClick size={14} /> 내가 조작
                  </button>
                ) : null}
              </div>

              {/* 입력 바(사용자가 조작할 때만) */}
              {userControl ? (
                <div className="flex items-center gap-2 border-t border-[#F4F2FA] bg-[#FCFCFE] px-2.5 py-2">
                  <input
                    ref={inputRef}
                    className="min-w-0 flex-1 rounded-full bg-white px-3 py-2 text-[13px] ring-1 ring-[#EFEDF6] focus:outline-none focus:ring-[#C9B8FF]"
                    placeholder="입력창을 눌러 글자를 입력하세요 (Enter·Backspace도 전달돼요)"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={onTypeKey}
                  />
                  <button className="shrink-0 rounded-full bg-[#F3EEFF] px-3 py-2 text-[12px] font-bold text-[#7C63F6]" onClick={() => void sendInput({ type: 'key', key: 'Enter' })}>
                    Enter
                  </button>
                  <button className="shrink-0 rounded-full bg-[#F3EEFF] px-3 py-2 text-[12px] font-bold text-[#7C63F6]" onClick={() => void sendInput({ type: 'scroll', dy: 400 })}>
                    ↓
                  </button>
                </div>
              ) : null}
            </div>

            {hint ? (
              <p className="rounded-[14px] bg-[#FFF8E7] px-3 py-2 text-[12px] text-[#9A7412]">{hint}</p>
            ) : null}

            {/* 액션 로그 */}
            {showLog ? (
              <div className="rounded-[18px] bg-white p-3.5 shadow-card ring-1 ring-[#F6F4FB]">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13.5px] font-bold text-[#1F1D2B]">액션 로그</h3>
                  <button className="rounded-lg p-1 text-[#A8A5B8]" onClick={() => setShowLog(false)} aria-label="닫기">
                    <X size={15} />
                  </button>
                </div>
                {actions.length === 0 ? <p className="text-[12px] text-[#A8A5B8]">아직 기록이 없어요.</p> : null}
                <div className="max-h-[220px] space-y-1.5 overflow-y-auto pa-scroll">
                  {actions.slice().reverse().map((action) => (
                    <div key={action.id} className="flex items-start gap-2 rounded-[10px] bg-[#FAF9FD] px-2.5 py-1.5">
                      <span className={`mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${action.actor === 'user' ? 'bg-[#FFE9EF] text-[#E2568B]' : 'bg-[#EAF6FF] text-[#2F86D8]'}`}>
                        {action.actor === 'user' ? '나' : 'AI'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11.5px] font-semibold text-[#5B5866]">{action.tool}</p>
                        <p className="truncate text-[11px] text-[#A8A5B8]">{action.result}</p>
                      </div>
                      <span className="shrink-0 text-[10.5px] text-[#C0BCCD]">{timeLabel(action.at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* 모바일: 포몽이 안내 + CTA */}
            {userControl ? (
              <div className="flex items-center gap-3 rounded-[20px] bg-white px-4 py-3 shadow-card ring-1 ring-[#F6F4FB]">
                <Mascot name={profile.character as MascotName} hero size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-bold text-[#3A2F7A]">입력 후 아래 버튼을 눌러주세요</p>
                  <p className="text-[11.5px] text-[#8A8A9A]">입력이 완료되면 AI가 이어서 작업을 진행해요.</p>
                </div>
                <Sparkles size={16} className="text-[#C9B8FF]" />
              </div>
            ) : null}

            {session.lastUsedAt ? (
              <p className="text-center text-[11px] text-[#B4B1C2]">
                마지막 조작 {relativeTime(session.lastUsedAt)} · 액션 {session.actions}회
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 모바일 고정 CTA (하단 탭 위) */}
      {session && userControl ? (
        <div className="fixed inset-x-0 bottom-[calc(var(--safe-bottom)+58px)] z-10 px-4 lg:hidden">
          <button
            className="flex w-full items-center justify-center gap-2 rounded-[18px] py-3.5 text-[15px] font-bold text-[#2F2A4A] shadow-float"
            style={{ backgroundImage: 'linear-gradient(120deg,#CFF6E7 0%,#E3D9FF 100%)' }}
            onClick={giveBack}
            disabled={busy}
          >
            <Sparkles size={17} /> 인증 완료 · AI에게 넘기기
          </button>
        </div>
      ) : null}
    </div>
  );
}
