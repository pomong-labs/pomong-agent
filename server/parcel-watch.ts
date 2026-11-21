/**
 * v0.6.16 — 택배 변동 자동 추적(경량 워치)
 *
 * AI 모델을 부르지 않는다(토큰 0). 서버가 정해진 주기마다 공개 배송 조회 API를
 * 가볍게 폴링하고, **직전에 저장한 최신 단계/시각과 달라졌을 때만** 채팅방에 알림을
 * 남기고 웹 푸시를 보낸다. '배송 완료'에 닿으면 스스로 멈춘다.
 *
 * 저장 위치: parcel_watches (server/db.ts)
 */

import crypto from 'node:crypto';
import { addLog, db } from './db';
import { DELIVERED_STATE, carrierLabel, fetchParcel, parcelNoticeLine, stateLabel, type ParcelSnapshot } from './parcel';

export const PARCEL_MIN_INTERVAL = 10;
export const PARCEL_DEFAULT_INTERVAL = 20;
export const PARCEL_MAX_INTERVAL = 6 * 60;
export const MAX_PARCEL_WATCHES = 20;

export interface ParcelWatchRow {
  id: string;
  carrier: string;
  tracking_number: string;
  label: string | null;
  session_id: string;
  interval_min: number;
  enabled: number;
  last_state: string | null;
  last_state_text: string | null;
  last_event_time: string | null;
  last_location: string | null;
  last_summary: string | null;
  last_checked_at: string | null;
  last_notified_at: string | null;
  fail_count: number;
  next_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParcelWatchView {
  id: string;
  carrier: string;
  carrierLabel: string;
  trackingNumber: string;
  label: string;
  sessionId: string;
  intervalMin: number;
  enabled: boolean;
  stateId: string | null;
  stateText: string | null;
  stateLabel: string | null;
  lastEventTime: string | null;
  lastLocation: string | null;
  lastSummary: string | null;
  lastCheckedAt: string | null;
  lastNotifiedAt: string | null;
  failCount: number;
  nextCheckAt: string | null;
  createdAt: string;
}

function toView(row: ParcelWatchRow): ParcelWatchView {
  return {
    id: row.id,
    carrier: row.carrier,
    carrierLabel: carrierLabel(row.carrier),
    trackingNumber: row.tracking_number,
    label: row.label || carrierLabel(row.carrier),
    sessionId: row.session_id,
    intervalMin: row.interval_min,
    enabled: Boolean(row.enabled),
    stateId: row.last_state,
    stateText: row.last_state_text,
    stateLabel: row.last_state ? stateLabel(row.last_state, row.last_state_text || '') : null,
    lastEventTime: row.last_event_time,
    lastLocation: row.last_location,
    lastSummary: row.last_summary,
    lastCheckedAt: row.last_checked_at,
    lastNotifiedAt: row.last_notified_at,
    failCount: row.fail_count,
    nextCheckAt: row.next_check_at,
    createdAt: row.created_at,
  };
}

function normalizeInterval(value: unknown): number {
  const n = Math.round(Number(value) || PARCEL_DEFAULT_INTERVAL);
  return Math.max(PARCEL_MIN_INTERVAL, Math.min(PARCEL_MAX_INTERVAL, n));
}

function nextCheckAt(intervalMin: number, jitter = true): string {
  const factor = jitter ? 1 + (Math.random() * 0.2 - 0.1) : 1;
  return new Date(Date.now() + intervalMin * 60_000 * factor).toISOString();
}

export function listParcelWatches(): ParcelWatchView[] {
  const rows = db
    .prepare('SELECT * FROM parcel_watches ORDER BY enabled DESC, created_at DESC')
    .all() as ParcelWatchRow[];
  return rows.map(toView);
}

export function getParcelWatch(id: string): ParcelWatchView | null {
  const row = db.prepare('SELECT * FROM parcel_watches WHERE id = ?').get(id) as ParcelWatchRow | undefined;
  return row ? toView(row) : null;
}

export interface CreateParcelWatchInput {
  carrier: string;
  carrierLabelText?: string;
  trackingNumber: string;
  label?: string;
  sessionId?: string;
  intervalMin?: number;
  /** 등록 시점에 이미 조회한 결과(있으면 첫 기준값을 바로 넣어 중복 알림을 막는다) */
  snapshot?: ParcelSnapshot;
}

export function createParcelWatch(input: CreateParcelWatchInput): ParcelWatchView | { error: string } {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM parcel_watches').get() as { n: number }).n;
  if (count >= MAX_PARCEL_WATCHES) {
    return { error: `택배 추적은 최대 ${MAX_PARCEL_WATCHES}개까지 등록할 수 있습니다.` };
  }
  const existing = db
    .prepare('SELECT * FROM parcel_watches WHERE carrier = ? AND tracking_number = ?')
    .get(input.carrier, input.trackingNumber) as ParcelWatchRow | undefined;
  if (existing) {
    const view = toView(existing);
    return { error: `이미 추적 중인 송장입니다: ${view.label} (${view.carrierLabel} ${view.trackingNumber})` };
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const interval = normalizeInterval(input.intervalMin);
  const snapshot = input.snapshot;
  db.prepare(
    `INSERT INTO parcel_watches(
       id, carrier, tracking_number, label, session_id, interval_min, enabled,
       last_state, last_state_text, last_event_time, last_location, last_summary,
       last_checked_at, fail_count, next_check_at, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,0,?,?,?)`
  ).run(
    id,
    input.carrier,
    input.trackingNumber,
    input.label ? String(input.label).slice(0, 60) : null,
    input.sessionId || 'default',
    interval,
    snapshot?.stateId || null,
    snapshot?.stateText || null,
    snapshot?.lastEventTime || null,
    snapshot?.lastLocation || null,
    snapshot?.lastDescription || null,
    snapshot ? now : null,
    nextCheckAt(interval, false),
    now,
    now
  );
  addLog('info', `택배 추적 등록 · ${input.trackingNumber} (${carrierLabel(input.carrier)}, ${interval}분)`);
  return getParcelWatch(id) as ParcelWatchView;
}

/** id · 송장번호 · 별칭 어느 것으로도 멈출 수 있다. */
export function stopParcelWatch(query: unknown): { removed: ParcelWatchView[]; error?: string } {
  const raw = String(query ?? '').trim();
  if (!raw) return { removed: [], error: '어떤 추적을 멈출지 송장번호·별칭·id로 알려 주세요.' };
  const digits = raw.replace(/\D/g, '');
  const rows = db.prepare('SELECT * FROM parcel_watches').all() as ParcelWatchRow[];
  const matched = rows.filter((row) => {
    if (row.id === raw) return true;
    if (digits.length >= 8 && row.tracking_number.includes(digits)) return true;
    const label = (row.label || '').toLowerCase();
    return label.length > 0 && (label.includes(raw.toLowerCase()) || raw.toLowerCase().includes(label));
  });
  if (!matched.length) return { removed: [], error: `'${raw}'에 해당하는 택배 추적을 찾지 못했습니다.` };
  for (const row of matched) {
    db.prepare('DELETE FROM parcel_watches WHERE id = ?').run(row.id);
  }
  addLog('info', `택배 추적 중지 · ${matched.map((row) => row.tracking_number).join(', ')}`);
  return { removed: matched.map(toView) };
}

/* ------------------------------------------------------------------ */
/* 확인                                                                */
/* ------------------------------------------------------------------ */

export interface ParcelWatchNotice {
  watch: ParcelWatchView;
  snapshot: ParcelSnapshot;
  /** delivered | changed */
  kind: 'changed' | 'delivered';
  line: string;
}

export type ParcelNotifier = (notice: ParcelWatchNotice) => void;

let notifier: ParcelNotifier | null = null;
let timer: NodeJS.Timeout | null = null;
let checking = false;

export function setParcelNotifier(fn: ParcelNotifier): void {
  notifier = fn;
}

function stateKey(row: ParcelWatchRow): string {
  return [row.last_state || '', row.last_state_text || '', row.last_event_time || ''].join('|');
}

/** 워치 1회 확인. 단계·시각이 바뀌었을 때만 알린다. */
export async function checkParcelWatchNow(
  id: string,
  trigger: 'schedule' | 'manual' = 'manual'
): Promise<{ watch: ParcelWatchView; changed: boolean; snapshot: ParcelSnapshot | null; error?: string }> {
  const row = db.prepare('SELECT * FROM parcel_watches WHERE id = ?').get(id) as ParcelWatchRow | undefined;
  if (!row) return { watch: null as unknown as ParcelWatchView, changed: false, snapshot: null, error: '추적을 찾지 못했습니다.' };
  const now = new Date().toISOString();
  const result = await fetchParcel(row.carrier, row.tracking_number);
  if (!result.ok) {
    const fails = row.fail_count + 1;
    // 조회 실패는 3회부터 한 번 알리고, 주기를 조금씩 늘려 서비스를 두드리지 않는다.
    const backoff = fails >= 3 ? Math.min(8, 2 ** Math.min(3, fails - 2)) : 1;
    const interval = Math.min(PARCEL_MAX_INTERVAL, row.interval_min * backoff);
    db.prepare(
      'UPDATE parcel_watches SET fail_count = ?, last_checked_at = ?, next_check_at = ?, updated_at = ? WHERE id = ?'
    ).run(fails, now, nextCheckAt(interval), now, row.id);
    if (fails === 3) addLog('warn', `택배 조회 실패 3회 · ${row.tracking_number}: ${result.reason.slice(0, 100)}`);
    if (trigger === 'manual') {
      return { watch: getParcelWatch(row.id) as ParcelWatchView, changed: false, snapshot: null, error: result.reason };
    }
    return { watch: getParcelWatch(row.id) as ParcelWatchView, changed: false, snapshot: null, error: result.reason };
  }

  const before = stateKey(row);
  const after = [result.stateId, result.stateText || '', result.lastEventTime || ''].join('|');
  const first = !row.last_state;
  const changed = !first && before !== after;
  const delivered = result.stateId === DELIVERED_STATE;

  db.prepare(
    `UPDATE parcel_watches SET last_state = ?, last_state_text = ?, last_event_time = ?, last_location = ?,
       last_summary = ?, last_checked_at = ?, fail_count = 0, next_check_at = ?, enabled = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    result.stateId,
    result.stateText || null,
    result.lastEventTime || null,
    result.lastLocation || null,
    result.lastDescription || null,
    now,
    delivered ? null : nextCheckAt(row.interval_min),
    delivered ? 0 : row.enabled,
    now,
    row.id
  );

  const view = getParcelWatch(row.id) as ParcelWatchView;
  if (changed || (delivered && !first)) {
    const notice: ParcelWatchNotice = {
      watch: view,
      snapshot: result,
      kind: delivered ? 'delivered' : 'changed',
      line: parcelNoticeLine(result),
    };
    db.prepare('UPDATE parcel_watches SET last_notified_at = ? WHERE id = ?').run(now, row.id);
    notifier?.(notice);
    addLog(delivered ? 'success' : 'info', `택배 ${delivered ? '배송 완료' : '단계 변동'} · ${view.label} (${row.tracking_number})`);
    return { watch: getParcelWatch(row.id) as ParcelWatchView, changed: true, snapshot: result };
  }
  if (first) addLog('info', `택배 추적 기준값 저장 · ${row.tracking_number} (${result.stateId})`);
  return { watch: view, changed: false, snapshot: result };
}

export function startParcelWatchLoop(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void tick();
  }, 60_000);
  timer.unref?.();
  setTimeout(() => void tick(), 20_000).unref?.();
}

export function stopParcelWatchLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const now = Date.now();
    const rows = db.prepare('SELECT * FROM parcel_watches WHERE enabled = 1').all() as ParcelWatchRow[];
    for (const row of rows) {
      const next = row.next_check_at ? new Date(row.next_check_at).getTime() : 0;
      if (next > now) continue;
      // 한 번에 하나씩 — 공개 조회 서비스를 두드리지 않도록 순서대로 본다.
      await checkParcelWatchNow(row.id, 'schedule').catch(() => undefined);
    }
  } catch (err) {
    addLog('error', `택배 추적 오류: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    checking = false;
  }
}
