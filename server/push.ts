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
    webpush.setVapidDetails('mailto:pomong-agent@localhost', vapid.publicKey, vapid.privateKey);
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

export interface PushResult {
  sent: number;
  skipped: boolean;
  reason?: string;
}

/** 앱을 보고 있으면 아무것도 보내지 않는다. force=true 는 '테스트 알림'용. */
export async function notify(payload: PushPayload, options: { force?: boolean } = {}): Promise<PushResult> {
  if (!publicKey()) return { sent: 0, skipped: true, reason: vapidError || 'VAPID 키를 만들지 못했습니다.' };
  if (!options.force && isForegroundActive()) return { sent: 0, skipped: true, reason: 'foreground' };
  const rows = db.prepare('SELECT * FROM push_subscriptions').all() as SubscriptionRow[];
  if (!rows.length) return { sent: 0, skipped: true, reason: 'no_subscription' };
  let sent = 0;
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
      if (status === 404 || status === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
        addLog('info', '만료된 푸시 구독을 정리했습니다');
      } else {
        addLog('warn', `푸시 발송 실패: ${err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)}`);
      }
    }
  }
  return { sent, skipped: false };
}

/** 이벤트(예약·워치·핸드오버·채팅)를 백그라운드 알림으로도 내보낸다. */
export function notifyForEvent(type: string, title: string, body: string, data?: Record<string, unknown>): void {
  const url =
    type === 'handover'
      ? '/browser'
      : type === 'job' || type === 'watch'
        ? '/automation'
        : '/';
  void notify({ title, body: body.slice(0, 180), url, tag: `${type}-${String(data?.jobId || data?.watcherId || data?.sessionId || '')}` }).catch(
    () => undefined
  );
}

export function pushMeta(): { enabled: boolean; subscriptions: number; error: string | null } {
  const keys = ensureVapid();
  return { enabled: Boolean(keys), subscriptions: subscriptionCount(), error: keys ? null : vapidError };
}
