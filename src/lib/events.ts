import { useEffect, useRef, useState } from 'react';
import type { AppEvent } from './api';

/**
 * 서버 이벤트(SSE) 구독. 예약 실행 결과·워치 변경·핸드오버 요청이 실시간으로 도착한다.
 */
export function useAppEvents(onEvent?: (event: AppEvent) => void): AppEvent | null {
  const [latest, setLatest] = useState<AppEvent | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

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
        const data = JSON.parse(ev.data) as AppEvent;
        if (!data || typeof data.id !== 'number') return;
        setLatest(data);
        handler.current?.(data);
      } catch {
        /* ignore malformed */
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
  }, []);

  return latest;
}

/** '3분 전' 형태의 상대 시간 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let text: string;
  if (abs < minute) text = '방금';
  else if (abs < hour) text = `${Math.round(abs / minute)}분`;
  else if (abs < day) text = `${Math.round(abs / hour)}시간`;
  else text = `${Math.round(abs / day)}일`;
  if (text === '방금') return future ? '곧' : '방금 전';
  return future ? `${text} 후` : `${text} 전`;
}

/** '11월 19일 08:00' */
export function clockLabel(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function timeLabel(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
