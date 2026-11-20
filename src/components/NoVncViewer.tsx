import { useCallback, useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { Loader2, RefreshCw, WifiOff } from 'lucide-react';

/**
 * noVNC 실시간 화면 (v0.6.0)
 *
 * 서버 컨테이너에서 도는 **화면 있는(headed) Chromium**을 RFB로 그대로 받아온다.
 * - AI와 사용자가 **같은 화면**을 본다(스크린샷 스트림이 아니라 진짜 화면).
 * - 화면 크기에 맞춰 자동 확대(scaleViewport) — 폰에서는 화면 폭에 꽉 차게.
 * - 마우스·터치 탭은 noVNC가 직접 전송하고, 한글 입력은 아래 입력 바에서
 *   조합이 끝난 글자를 유니코드 키심(0x01000000+코드포인트)으로 보낸다.
 * - 손가락 드래그는 휠 이벤트로 바꿔 보내 화면을 스크롤한다.
 */

interface Props {
  sessionId: string;
  /** false 이면 보기 전용(AI가 조작 중) */
  interactive: boolean;
  /** 핸드오버 전체화면처럼 화면을 꽉 채울 때 */
  fill?: boolean;
  /**
   * v0.6.4: 보기 방식.
   *  - 'fit'(기본): 원본 종횡비를 지킨 채 화면에 맞춘다. 남는 곳은 검은 여백(찌그러짐 없음).
   *  - 'actual': 원본 픽셀 크기로 그대로 보여 주고, 화면 안에서 스크롤해 본다.
   */
  mode?: 'fit' | 'actual';
  onStatus?: (status: 'connecting' | 'connected' | 'closed' | 'error') => void;
  onError?: (message: string) => void;
  /** 연결되면 RFB 인스턴스를 넘겨 준다(바깥에서 sendKey 등을 쓸 수 있게) */
  onReady?: (rfb: RFBInstance | null) => void;
}

export interface RFBInstance {
  sendKey: (keysym: number, code?: string, down?: boolean) => void;
  clipboardPasteFrom: (text: string) => void;
  focus: () => void;
  blur: () => void;
  disconnect: () => void;
  viewOnly: boolean;
  scaleViewport: boolean;
}

export default function NoVncViewer({ sessionId, interactive, fill, mode = 'fit', onStatus, onError, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBInstance | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState('');
  const retryRef = useRef(0);

  const updateStatus = useCallback(
    (next: 'connecting' | 'connected' | 'closed' | 'error') => {
      setStatus(next);
      onStatus?.(next);
    },
    [onStatus]
  );

  useEffect(() => {
    let disposed = false;
    let rfb: RFBInstance | null = null;
    let retryTimer = 0;
    const host = hostRef.current;
    if (!host) return;

    const connect = async () => {
      updateStatus('connecting');
      setMessage('');
      try {
        // 1회용 토큰을 받아 붙는다(쿠키가 없는 환경도 OK).
        const res = await fetch('/api/browser/vnc-token', { method: 'POST', credentials: 'same-origin' });
        const data = (await res.json().catch(() => null)) as { token?: string; message?: string } | null;
        if (!res.ok || !data?.token) throw new Error(data?.message || '화면 접속 토큰을 받지 못했어요.');
        if (disposed) return;
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${window.location.host}/api/browser/vnc?token=${encodeURIComponent(data.token)}`;
        const instance = new RFB(host, url, { shared: true, wsProtocols: ['binary'] }) as unknown as RFBInstance & {
          addEventListener: (type: string, fn: () => void) => void;
          removeEventListener: (type: string, fn: () => void) => void;
        };
        instance.scaleViewport = mode !== 'actual';
        instance.viewOnly = !interactive;
        rfb = instance;
        rfbRef.current = instance;
        (instance as unknown as { background: string }).background = '#0B0B12';
        const onConnect = () => {
          retryRef.current = 0;
          updateStatus('connected');
          onReady?.(instance);
        };
        const onDisconnect = () => {
          if (disposed) return;
          updateStatus('closed');
          onReady?.(null);
          // 자동 재연결(최대 6회, 점점 간격을 늘린다)
          if (retryRef.current < 6) {
            retryRef.current += 1;
            retryTimer = window.setTimeout(() => setAttempt((n) => n + 1), 900 * retryRef.current);
          }
        };
        instance.addEventListener('connect', onConnect);
        instance.addEventListener('disconnect', onDisconnect);
        onReady?.(instance);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        setMessage(text);
        updateStatus('error');
        onError?.(text);
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      try {
        rfb?.disconnect();
      } catch {
        /* ignore */
      }
      rfbRef.current = null;
      onReady?.(null);
      host.innerHTML = '';
    };
    // attempt 가 바뀌면 다시 연결한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attempt]);

  // 보기 전용 ↔ 조작 전환을 즉시 반영한다.
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !interactive;
  }, [interactive]);

  // v0.6.4: 맞춤(fit) ↔ 확대(actual) 전환을 즉시 반영한다. 비율을 늘리는 모드는 없다.
  useEffect(() => {
    if (!rfbRef.current) return;
    rfbRef.current.scaleViewport = mode !== 'actual';
  }, [mode]);

  /**
   * 손가락 드래그 → 휠 스크롤, 두 손가락은 그대로 둔다.
   * (noVNC는 휠 이벤트를 받아 서버로 보내므로, 합성 WheelEvent로 스크롤을 만든다)
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 확대(actual) 모드에서는 화면을 직접 스크롤한다(손가락 이동을 가로채지 않는다).
    if (mode === 'actual') return;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let moved = false;
    let multi = false;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        multi = true;
        return;
      }
      multi = false;
      moved = false;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      lastY = startY;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (multi || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - lastY;
      if (!moved && Math.hypot(touch.clientX - startX, touch.clientY - startY) > 9) moved = true;
      if (!moved) return;
      event.preventDefault();
      lastY = touch.clientY;
      const canvas = host.querySelector('canvas');
      if (!canvas) return;
      // 손가락을 내리면(dy>0) 화면이 위로 → 휠 아래 방향
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: dy * 2.2, deltaMode: 0, bubbles: true, cancelable: true })
      );
      void dx;
    };
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
    };
  }, [mode]);

  return (
    <div
      className={`relative w-full overflow-hidden bg-[#0B0B12] ${fill ? 'h-full' : ''}`}
      style={fill ? undefined : { aspectRatio: '1280 / 800' }}
      data-pa-viewer=""
      data-mode={mode}
    >
      <div
        ref={hostRef}
        className={mode === 'actual' ? 'h-full w-full overflow-auto' : 'h-full w-full'}
        style={{ touchAction: mode === 'actual' ? 'auto' : 'none' }}
      />
      {status !== 'connected' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0B0B12]/90 text-center text-[12.5px] text-[#C9C6D8]">
          {status === 'connecting' ? (
            <>
              <Loader2 size={18} className="animate-spin text-[#B9A6FF]" />
              화면에 연결하는 중…
            </>
          ) : (
            <>
              <WifiOff size={20} className="text-[#F08C4B]" />
              <span className="px-6">{message || (status === 'closed' ? '화면 연결이 끊겼어요. 다시 연결합니다…' : '화면을 열지 못했어요.')}</span>
              <button
                className="mt-1 flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-bold text-white"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <RefreshCw size={13} /> 다시 연결
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
