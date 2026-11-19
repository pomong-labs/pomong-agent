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
  Maximize2,
  Minimize2,
  MoreVertical,
  MousePointerClick,
  Play,
  RotateCw,
  Sparkles,
  X,
} from 'lucide-react';
import Mascot, { type MascotName } from '../components/Mascot';
import NoVncViewer, { type RFBInstance } from '../components/NoVncViewer';
import { api, type BrowserAction, type BrowserSession } from '../lib/api';
import { relativeTime, timeLabel, useAppEvents } from '../lib/events';
import { useAppStore } from '../lib/store';

/** 모바일 상태 pill에 들어갈 짧은 사유 표기 */
const REASON_SHORT: Record<string, string> = {
  login: '로그인',
  otp: '인증번호',
  captcha: '캡차',
  payment: '결제',
  identity: '본인인증',
  manual: '수동',
};

/** X11 키심 (특수키) */
const KEY = {
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  ArrowUp: 0xff52,
  ArrowDown: 0xff54,
  ArrowLeft: 0xff51,
  ArrowRight: 0xff53,
};

export default function Browser() {
  const { profile } = useAppStore();
  const navigate = useNavigate();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [status, setStatus] = useState<{ enabled: boolean; connected: boolean } | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actions, setActions] = useState<BrowserAction[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [address, setAddress] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  const [hint, setHint] = useState('');
  const [vncStatus, setVncStatus] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting');
  const [viewerFull, setViewerFull] = useState(false);
  const rfbRef = useRef<RFBInstance | null>(null);
  const imeRef = useRef<HTMLInputElement>(null);

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

  /** 핸드오버가 열리면 화면을 한눈에 꽉 차게(전체화면) 보여 준다. */
  const controlOwner = session?.controlOwner || 'agent';
  useEffect(() => {
    if (controlOwner === 'user') setViewerFull(true);
  }, [controlOwner]);

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
      setViewerFull(true);
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
      setViewerFull(false);
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
    setViewerFull(false);
    await loadStatus();
  };

  /** 한글·이모지 입력: 조합이 끝난 글자를 유니코드 키심으로 한 글자씩 보낸다. */
  const sendText = (text: string) => {
    const rfb = rfbRef.current;
    if (!rfb || !text) return;
    for (const ch of Array.from(text)) {
      const cp = ch.codePointAt(0) || 0;
      const keysym = cp < 0x80 ? cp : 0x01000000 + cp;
      rfb.sendKey(keysym, undefined, true);
      rfb.sendKey(keysym, undefined, false);
    }
  };

  const sendKey = (name: keyof typeof KEY) => {
    rfbRef.current?.sendKey(KEY[name], name, true);
    rfbRef.current?.sendKey(KEY[name], name, false);
  };

  const onImeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const native = event.nativeEvent as InputEvent;
    if (native.isComposing) return;
    const value = event.target.value;
    if (!value) return;
    sendText(value);
    event.target.value = '';
  };

  const onImeKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      sendKey('Enter');
      return;
    }
    if (event.key === 'Backspace' && !(event.target as HTMLInputElement).value) {
      event.preventDefault();
      sendKey('Backspace');
    }
  };

  const userControl = controlOwner === 'user';
  const remaining = session?.leaseExpiresAt ? Math.max(0, Math.round((new Date(session.leaseExpiresAt).getTime() - Date.now()) / 60000)) : 0;
  const vncLive = vncStatus === 'connected';

  /** 화면 + 하단 입력 바 (일반 카드와 전체화면에서 같은 것을 쓴다) */
  const viewer = session ? (
    <div className="relative h-full w-full bg-[#0B0B12]">
      <NoVncViewer
        sessionId={session.id}
        interactive={userControl}
        fill={viewerFull}
        onStatus={setVncStatus}
        onError={(message) => setHint(message)}
        onReady={(rfb) => {
          rfbRef.current = rfb;
          if (rfb && userControl) rfb.focus();
        }}
      />
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
  ) : null;

  return (
    <div className="pa-scroll flex h-full min-h-0 flex-col overflow-y-auto px-4 pb-28 pt-4 lg:px-10 lg:pt-7 lg:pb-8">
      <div className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col">
        {/* ---------- 모바일 헤더 ---------- */}
        <header className="flex items-center gap-2.5 lg:hidden">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white shadow-[0_6px_18px_rgba(120,100,200,0.14)] ring-1 ring-[#F4F0FF]">
            <Mascot name={profile.character as MascotName} hero size={30} />
          </span>
          <h1 className="min-w-0 flex-1 truncate text-[19px] font-bold tracking-[-0.02em]">Pomong Browser</h1>
          {session ? (
            <button
              className="flex items-center gap-1 rounded-full bg-[#FFF1F6] px-2.5 py-1.5 text-[11.5px] font-bold text-[#E2568B]"
              onClick={closeSession}
              aria-label="세션 닫기"
            >
              <X size={13} /> 세션 닫기
            </button>
          ) : null}
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
              AI가 직접 눌러 보고, 로그인·결제는 실시간 화면에서 내가 이어받아요 ·{' '}
              {vncLive ? '실시간 화면 연결됨' : status?.connected ? '화면 연결 중' : '브라우저 대기'}
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
                  로그인·캡차 화면은 실시간 화면으로 자동으로 내게 넘어와요.
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
                  <p className="text-[12.5px] text-[#A9745B]">{session.controlDetail || '실시간 화면에서 직접 입력한 뒤 완료를 눌러주세요'} · 남은 시간 {remaining}분</p>
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
                <span
                  className={`hidden shrink-0 rounded-full px-2 py-1 text-[11px] font-bold sm:block ${
                    vncLive ? 'bg-[#EAFBF1] text-[#0F9668]' : 'bg-[#FFF8E7] text-[#9A7412]'
                  }`}
                >
                  {vncLive ? '실시간' : vncStatus === 'connecting' ? '연결 중' : '재연결'}
                </span>
                <button
                  className="rounded-lg p-2 text-[#6B677A] hover:bg-[#F7F5FF]"
                  onClick={() => setViewerFull(true)}
                  aria-label="전체화면"
                  title="전체화면으로 보기"
                >
                  <Maximize2 size={16} />
                </button>
                <button className="rounded-lg p-2 text-[#6B677A] hover:bg-[#F7F5FF]" onClick={() => setShowLog((v) => !v)} aria-label="메뉴">
                  <MoreVertical size={17} />
                </button>
                <button className="rounded-lg p-2 text-[#E2568B] hover:bg-[#FFF1F6] lg:hidden" onClick={closeSession} aria-label="세션 닫기">
                  <X size={17} />
                </button>
              </div>

              {/* 실시간 화면(noVNC) — 전체화면일 때는 그쪽에만 그린다(중복 연결 방지) */}
              <div className="relative aspect-[1280/800] max-h-[62vh] w-full bg-[#0B0B12]">
                {viewerFull ? <div className="h-full w-full" /> : viewer}
                {!userControl ? (
                  <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-[#1F1D2B]/70 px-2.5 py-1 text-[11px] font-semibold text-white">
                    AI 조작 중 · 실시간 화면
                  </span>
                ) : (
                  <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-[#E2568B]/90 px-2.5 py-1 text-[11px] font-semibold text-white">
                    직접 조작 중 · 남은 {remaining}분
                  </span>
                )}
              </div>

              {/* 화면 도구: 확대·스크롤·전체화면 */}
              <div className="flex items-center gap-1.5 border-t border-[#F4F2FA] bg-white px-2 py-1.5">
                <button className="rounded-full bg-[#FAF9FD] px-2.5 py-1 text-[11.5px] font-bold text-[#9B98AB]" onClick={() => void sendInput({ type: 'scroll', dy: -400 })}>
                  ↑
                </button>
                <button className="rounded-full bg-[#FAF9FD] px-2.5 py-1 text-[11.5px] font-bold text-[#9B98AB]" onClick={() => void sendInput({ type: 'scroll', dy: 400 })}>
                  ↓
                </button>
                <button className="rounded-full bg-[#FAF9FD] px-2.5 py-1 text-[11.5px] font-bold text-[#9B98AB]" onClick={() => sendKey('Tab')}>
                  Tab
                </button>
                <button className="rounded-full bg-[#FAF9FD] px-2.5 py-1 text-[11.5px] font-bold text-[#9B98AB]" onClick={() => sendKey('Backspace')}>
                  ⌫
                </button>
                <button className="ml-auto flex items-center gap-1 rounded-full bg-[#F3EEFF] px-3 py-1 text-[11.5px] font-bold text-[#7C63F6]" onClick={() => setViewerFull(true)}>
                  <Maximize2 size={12} /> 전체화면
                </button>
              </div>

              {/* 한글 입력 바 — 아이폰 한글 조합도 유니코드로 보낸다 */}
              <div className="flex items-center gap-2 border-t border-[#F4F2FA] bg-[#FCFCFE] px-2.5 py-2">
                <input
                  ref={imeRef}
                  className="min-w-0 flex-1 rounded-full bg-white px-3 py-2 text-[16px] ring-1 ring-[#EFEDF6] focus:outline-none focus:ring-[#C9B8FF]"
                  placeholder="여기에 입력하면 화면으로 바로 들어가요 (한글 OK)"
                  onChange={onImeChange}
                  onKeyDown={onImeKeyDown}
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                />
                <button className="shrink-0 rounded-full bg-[#7C63F6] px-3 py-2 text-[12px] font-bold text-white" onClick={() => sendKey('Enter')}>
                  Enter
                </button>
              </div>
            </div>

            {hint ? <p className="rounded-[14px] bg-[#FFF8E7] px-3 py-2 text-[12px] text-[#9A7412]">{hint}</p> : null}

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

            {/* 모바일: 포몽이 안내 */}
            {userControl ? (
              <div className="flex items-center gap-3 rounded-[20px] bg-white px-4 py-3 shadow-card ring-1 ring-[#F6F4FB]">
                <Mascot name={profile.character as MascotName} hero size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-bold text-[#3A2F7A]">실시간 화면에서 직접 입력해 주세요</p>
                  <p className="text-[11.5px] text-[#8A8A9A]">인증이 끝나면 AI가 이어서 작업을 진행해요.</p>
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

      {/* ---------- 전체화면(핸드오버) ---------- */}
      {session && viewerFull ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#0B0B12]">
          <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#12121C] px-3 py-2 text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/10">
              <Globe size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold">
                {userControl ? session.handoverLabel || '화면을 넘겨받았어요' : 'Pomong Browser · 실시간 화면'}
              </p>
              <p className="truncate text-[11px] text-white/60">
                {userControl ? `직접 입력한 뒤 「인증 완료」를 눌러 주세요 · 남은 ${remaining}분` : 'AI가 조작 중입니다 · 「내가 조작」을 누르면 직접 할 수 있어요'}
              </p>
            </div>
            {userControl ? (
              <button
                className="flex shrink-0 items-center gap-1 rounded-full bg-[#D9F7EA] px-3 py-2 text-[12px] font-bold text-[#0F9668] disabled:opacity-60"
                onClick={giveBack}
                disabled={busy}
              >
                <CheckCircle2 size={14} /> 인증 완료
              </button>
            ) : (
              <button
                className="flex shrink-0 items-center gap-1 rounded-full bg-[#7C63F6] px-3 py-2 text-[12px] font-bold text-white"
                onClick={takeControl}
                disabled={busy}
              >
                <MousePointerClick size={14} /> 내가 조작
              </button>
            )}
            <button
              className="flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 py-2 text-[12px] font-bold text-white"
              onClick={() => setViewerFull(false)}
            >
              <Minimize2 size={14} /> 닫기
            </button>
          </div>
          <div className="min-h-0 flex-1">{viewer}</div>
          <div className="flex shrink-0 items-center gap-2 border-t border-white/10 bg-[#12121C] px-2.5 py-2">
            <input
              className="min-w-0 flex-1 rounded-full bg-white/10 px-3 py-2 text-[16px] text-white placeholder-white/40 focus:outline-none focus:ring-1 focus:ring-[#C9B8FF]"
              placeholder="여기에 입력하면 화면으로 바로 들어가요 (한글 OK)"
              onChange={onImeChange}
              onKeyDown={onImeKeyDown}
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
            <button className="shrink-0 rounded-full bg-[#7C63F6] px-3 py-2 text-[12px] font-bold text-white" onClick={() => sendKey('Enter')}>
              Enter
            </button>
            <button className="shrink-0 rounded-full bg-white/10 px-3 py-2 text-[12px] font-bold text-white" onClick={() => sendInput({ type: 'scroll', dy: 500 })}>
              ↓
            </button>
          </div>
        </div>
      ) : null}

      {/* 모바일 고정 CTA (하단 탭 위) */}
      {session && userControl && !viewerFull ? (
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
