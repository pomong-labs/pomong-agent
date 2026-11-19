import type { Response } from 'express';

/**
 * 앱 이벤트 버스 (Phase 1 EventBus의 최소 구현).
 * 예약 실행 결과·워치 변경·핸드오버 요청을 화면(SSE)으로 밀어 준다.
 * 알림 채널(텔레그램·디스코드·웹푸시)은 이 이벤트를 구독해서 붙이면 된다.
 */

export type AppEventType =
  | 'job'
  | 'watch'
  | 'handover'
  | 'browser'
  | 'info'
  | 'chat'
  | 'chat_message'
  | 'task'
  | 'login_request'
  | 'vault_unlock_request'
  | 'memory'
  | 'agent_stop';

export interface AppEvent {
  id: number;
  type: AppEventType;
  title: string;
  body: string;
  at: string;
  data?: Record<string, unknown>;
}

let seq = 0;
const buffer: AppEvent[] = [];
const clients = new Set<Response>();

export function publish(event: Omit<AppEvent, 'id' | 'at'>, options: { push?: boolean } = {}): AppEvent {
  seq += 1;
  const full: AppEvent = { ...event, id: seq, at: new Date().toISOString() };
  buffer.push(full);
  if (buffer.length > 50) buffer.splice(0, buffer.length - 50);
  const payload = `event: message\ndata: ${JSON.stringify(full)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
  // 앱을 보고 있지 않을 때만 휴대폰 알림으로도 보낸다(웹 푸시).
  // push:false 는 호출부가 이미 다른 이벤트로 알림을 보냈을 때(중복 알림 방지).
  if (options.push !== false && (event.type === 'job' || event.type === 'watch' || event.type === 'handover' || event.type === 'chat')) {
    void import('./push')
      .then((push) => push.notifyForEvent(event.type, full.title, full.body || '', full.data))
      .catch(() => undefined);
  }
  return full;
}

export function recentEvents(limit = 20): AppEvent[] {
  return buffer.slice(-limit).reverse();
}

export function subscribe(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 25_000);
  heartbeat.unref?.();
  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}
