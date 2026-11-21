import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR } from './config';
import { addLog, db } from './db';

/**
 * PWA 백그라운드 웹 푸시 (v0.5.0)
 *
 * - VAPID 키는 첫 기동 때 /app/data/vapid.json 에 자동 생성한다. 환경변수를 따로 설정하지 않아도 된다.
 * - 앱을 보고 있을 때는 알림을 띄우지 않는다(이중 가드):
 *     ① 서버: 클라이언트가 /api/push/presence 로 알려 준 '최근 포그라운드' 상태면 발송 자체를 생략
 *     ② 서비스워커: push 이벤트에서 clients.matchAll 로 보이는 창이 있으면 showNotification 생략
 * - 클릭하면 해당 경로(/ · /browser · /automation)로 창을 연다(sw.js notificationclick).
 */

const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const FOREGROUND_WINDOW_MS = 45_000;

/**
 * VAPID 연락처(v0.5.2).
 * 이전에는 `mailto:pomong-agent@localhost` 를 썼는되, 일부 푸시 서비스(Apple APNs 포함)가
 * 도메인 없는 주소를 거절한다. 환경변수 VAPID_SUBJECT 로 바꿀 수 있고,
 * 기본값은 실제 도메인 주소로 둔다.
 */
const DEFAULT_VAPID_SUBJECT = 'mailto:push@pm-agent.kro.kr';

export function vapidSubject(): string {
  const raw = String(process.env.VAPID_SUBJECT || process.env.VAPID_CONTACT || '').trim();
  if (!raw) return DEFAULT_VAPID_SUBJECT;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^mailto:/i.test(raw)) return raw.replace(/@localhost$/i, '@pm-agent.kro.kr');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return `mailto:${raw}`;
  return raw;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let vapid: VapidKeys | null = null;
let vapidError: string | null = null;

function readVapid(): VapidKeys | null {
  try {
    const raw = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) as Partial<VapidKeys>;
    if (raw.publicKey && raw.privateKey) return { publicKey: raw.publicKey, privateKey: raw.privateKey };
  } catch {
    /* not created yet */
  }
  return null;
}

/** 첫 기동 시 키를 만들어 data/ 에 보관한다(파일 권한 600). */
export function ensureVapid(): VapidKeys | null {
  if (vapid) return vapid;
  const existing = readVapid();
  if (existing) {
    vapid = existing;
  } else {
    try {
      const generated = webpush.generateVAPIDKeys();
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(VAPID_FILE, JSON.stringify(generated, null, 2), { mode: 0o600 });
      vapid = generated;
      addLog('info', '웹 푸시 VAPID 키를 새로 만들었습니다(data/vapid.json)');
    } catch (err) {
      vapidError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }
  try {
    webpush.setVapidDetails(vapidSubject(), vapid.publicKey, vapid.privateKey);
  } catch (err) {
    vapidError = err instanceof Error ? err.message : String(err);
    return null;
  }
  return vapid;
}

export function publicKey(): string | null {
  return ensureVapid()?.publicKey || null;
}

/* ------------------------------------------------------------------ */
/* 구독                                                                */
/* ------------------------------------------------------------------ */

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  ua: string | null;
  created_at: string;
  last_ok_at: string | null;
}

export function subscriptionCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number };
  return row.n;
}

export function saveSubscription(input: {
  endpoint: string;
  keys: { p256dh?: string; auth?: string };
  ua?: string | null;
}): void {
  const endpoint = String(input.endpoint || '');
  const p256dh = String(input.keys?.p256dh || '');
  const auth = String(input.keys?.auth || '');
  if (!endpoint || !p256dh || !auth) throw new Error('구독 정보가 올바르지 않습니다.');
  const id = crypto.createHash('sha1').update(endpoint).digest('hex').slice(0, 24);
  db.prepare(
    `INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, ua, created_at, last_ok_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`
  ).run(id, endpoint, p256dh, auth, input.ua || null, new Date().toISOString(), null);
}

export function removeSubscription(endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint || ''));
}

/* ------------------------------------------------------------------ */
/* 포그라운드 상태(앱을 보고 있는지)                                     */
/* ------------------------------------------------------------------ */

const presence = new Map<string, { visible: boolean; at: number }>();

export function notePresence(clientId: string, visible: boolean): void {
  const id = String(clientId || 'default').slice(0, 80);
  presence.set(id, { visible, at: Date.now() });
  // 오래된 항목 정리
  for (const [key, value] of presence) {
    if (Date.now() - value.at > 10 * 60_000) presence.delete(key);
  }
}

export function isForegroundActive(): boolean {
  for (const value of presence.values()) {
    if (value.visible && Date.now() - value.at < FOREGROUND_WINDOW_MS) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 발송                                                                */
/* ------------------------------------------------------------------ */

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/**
 * v0.7.1 — 알림을 누르면 그 대화·메시지·승인 카드로 바로 가는 딥링크.
 *
 * `/?room=<대화방>&msg=<메시지>&approval=<승인카드>` 형태로 만든다.
 * 화면(Chat.tsx)이 이 쿼리를 읽어 방을 바꾸고 해당 지점으로 스크롤한 뒤 쿼리를 지운다.
 * 같은 앱의 라우트(`/` = 채팅)를 그대로 쓰므로 새로고침·딥링크·PWA 실행이 모두 같은 길로 동작한다.
 */
export function chatDeepLink(data?: Record<string, unknown> | null): string {
  const message = (data?.message ?? null) as { id?: unknown } | null;
  const room = String(data?.room ?? data?.session ?? data?.sessionId ?? '').trim();
  const messageId = Number(data?.msg ?? data?.messageId ?? message?.id ?? 0);
  const approval = String(data?.approval ?? data?.approvalId ?? '').trim();
  const params = new URLSearchParams();
  if (room) params.set('room', room);
  if (Number.isFinite(messageId) && messageId > 0) params.set('msg', String(messageId));
  if (approval) params.set('approval', approval);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

export interface PushResult {
  sent: number;
  skipped: boolean;
  /** 화면에 그대로 보여 줄 수 있는 한국어 이유 */
  reason?: string;
  /** 기계가 구분하는 이유 코드 */
  code?: 'no_subscription' | 'foreground' | 'vapid' | 'send_failed' | 'expired' | 'unknown';
  /** 서버가 보낸 실제 응답 요약(디버깅용) */
  details?: string[];
}

/** 푸시 서비스 응답 본문을 한 줄로 요약한다(너무 길면 자른다). */
function sendErrorDetail(err: unknown): string {
  const status = (err as { statusCode?: number }).statusCode;
  const body = (err as { body?: string }).body;
  const message = err instanceof Error ? err.message : String(err);
  const parts = [status ? `HTTP ${status}` : '', body ? String(body).replace(/\s+/g, ' ').slice(0, 160) : '', message.slice(0, 160)];
  return parts.filter(Boolean).join(' · ');
}

/**
 * 앱을 보고 있으면 아무것도 보내지 않는다. force=true 는 '테스트 알림'용.
 * 실패하면 실제 원인(HTTP 코드·본문 요약)을 reason/details에 담아 돌려준다.
 */
export async function notify(payload: PushPayload, options: { force?: boolean } = {}): Promise<PushResult> {
  if (!publicKey()) {
    return { sent: 0, skipped: true, code: 'vapid', reason: `푸시 키를 준비하지 못했습니다${vapidError ? ` (${vapidError})` : ''}.` };
  }
  if (!options.force && isForegroundActive()) return { sent: 0, skipped: true, code: 'foreground', reason: '앱을 보고 있어 알림을 보내지 않았습니다.' };
  const rows = db.prepare('SELECT * FROM push_subscriptions').all() as SubscriptionRow[];
  if (!rows.length) {
    return {
      sent: 0,
      skipped: true,
      code: 'no_subscription',
      reason: '이 기기에 알림 구독이 없습니다. 설정에서 푸시 알림을 껐다 켜 주세요.',
    };
  }
  let sent = 0;
  const failures: string[] = [];
  let expired = 0;
  for (const row of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 }
      );
      sent += 1;
      db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const detail = sendErrorDetail(err);
      failures.push(detail);
      if (status === 404 || status === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
        expired += 1;
        addLog('info', '만료된 푸시 구독을 정리했습니다');
      } else {
        addLog('warn', `푸시 발송 실패: ${detail.slice(0, 140)}`);
      }
    }
  }
  if (sent > 0) return { sent, skipped: false };
  if (expired === rows.length) {
    return {
      sent: 0,
      skipped: false,
      code: 'expired',
      reason: '구독이 만료되었습니다(404/410). 설정에서 알림을 껐다가 다시 켜 주세요.',
      details: failures,
    };
  }
  const unauthorized = failures.some((f) => /HTTP 40[13]/.test(f));
  return {
    sent: 0,
    skipped: false,
    code: unauthorized ? 'vapid' : 'send_failed',
    reason: unauthorized
      ? '푸시 서비스가 발신자를 거부했습니다(VAPID 서명/연락처 문제). 서버를 재시작해 키를 다시 읽게 해 주세요.'
      : '푸시 서비스가 알림을 받아주지 않았습니다. 아래 원인을 확인해 주세요.',
    details: failures.slice(0, 3),
  };
}

/** 이벤트(예약·워치·핸드오버·채팅)를 백그라운드 알림으로도 내보낸다. */
export function notifyForEvent(type: string, title: string, body: string, data?: Record<string, unknown>): void {
  // v0.5.2: 예약·워치 결과도 채팅방에 남으므로 어느 알림이든 앱을 열면 채팅이 보이게 한다.
  // v0.7.1: 그 대화방·그 메시지·그 승인 카드로 바로 가도록 딥링크를 붙인다.
  const url = type === 'handover' ? '/browser' : chatDeepLink(data);
  void notify({ title, body: body.slice(0, 180), url, tag: `${type}-${String(data?.jobId || data?.watcherId || data?.sessionId || '')}` }).catch(
    () => undefined
  );
}

export function pushMeta(): { enabled: boolean; subscriptions: number; error: string | null; subject: string } {
  const keys = ensureVapid();
  return { enabled: Boolean(keys), subscriptions: subscriptionCount(), error: keys ? null : vapidError, subject: vapidSubject() };
}
