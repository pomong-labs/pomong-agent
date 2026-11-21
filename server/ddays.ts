/**
 * v0.6.16 — D-Day · 기념일 · 결제일 카운터
 *
 * 저장: ddays (server/db.ts) — 제목·목표 날짜(YYYY-MM-DD)·매년 반복·메모
 * 표시: 남은 일수(D-14 / D-Day / D+3) — 기준은 항상 한국 시간(Asia/Seoul)의 오늘.
 */

import crypto from 'node:crypto';
import { db } from './db';
import { kstDateLabel } from './kst';

export interface DDayRow {
  id: string;
  title: string;
  target_date: string;
  repeat_yearly: number;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface DDayView {
  id: string;
  title: string;
  /** 사용자가 넣은 원래 날짜 */
  targetDate: string;
  /** 매년 반복이면 이번(또는 다음) 기준 날짜 */
  nextDate: string;
  repeatYearly: boolean;
  notes: string | null;
  /** 오늘 기준 남은 일수 (지난 날짜면 음수) */
  days: number;
  /** D-Day · D-14 · D+3 */
  label: string;
  /** 2027년 5월 15일 (토) */
  dateLabel: string;
  createdAt: string;
  updatedAt: string | null;
}

export const MAX_DDAYS = 100;

/** 한국 시간의 오늘 'YYYY-MM-DD' */
export function todayKst(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

function parseYmd(value: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(y, month - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { y, m: month, d: day };
}

/** 'YYYY. M. D' · 'YYYY/MM/DD' · '2026-3-5' → 'YYYY-MM-DD' */
export function normalizeDateInput(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[.\/년]/g, '-').replace(/월/g, '-').replace(/일/g, '').replace(/\s+/g, '');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(cleaned);
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return parseYmd(iso) ? iso : null;
}

function dayNumber(ymd: string): number {
  const parsed = parseYmd(ymd);
  if (!parsed) return Number.NaN;
  return Math.floor(Date.UTC(parsed.y, parsed.m - 1, parsed.d) / 86_400_000);
}

/** 남은 일수 (양수 = 앞으로, 0 = 오늘, 음수 = 지남) */
export function daysUntil(targetYmd: string, todayYmd: string = todayKst()): number {
  return dayNumber(targetYmd) - dayNumber(todayYmd);
}

export function ddayLabel(days: number): string {
  if (days === 0) return 'D-Day';
  return days > 0 ? `D-${days}` : `D+${-days}`;
}

/**
 * 매년 반복이면 오늘 이후의 가장 가까운 기념일을 기준으로 계산한다.
 * (올해 기념일이 지났으면 내년 날짜로 넘어간다)
 */
export function nextOccurrence(targetYmd: string, repeatYearly: boolean, todayYmd: string = todayKst()): string {
  if (!repeatYearly) return targetYmd;
  const parsed = parseYmd(targetYmd);
  const today = parseYmd(todayYmd);
  if (!parsed || !today) return targetYmd;
  const pad = (n: number) => n.toString().padStart(2, '0');
  // 2월 29일처럼 그 해에 없는 날짜는 그 달 마지막 날로 본다.
  const clamp = (y: number, m: number, d: number) => {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${pad(m)}-${pad(Math.min(d, last))}`;
  };
  const thisYear = clamp(today.y, parsed.m, parsed.d);
  if (dayNumber(thisYear) >= dayNumber(todayYmd)) return thisYear;
  return clamp(today.y + 1, parsed.m, parsed.d);
}

function toView(row: DDayRow, today: string): DDayView {
  const repeat = Boolean(row.repeat_yearly);
  const next = nextOccurrence(row.target_date, repeat, today);
  const days = daysUntil(next, today);
  return {
    id: row.id,
    title: row.title,
    targetDate: row.target_date,
    nextDate: next,
    repeatYearly: repeat,
    notes: row.notes,
    days,
    label: ddayLabel(days),
    dateLabel: kstDateLabel(next),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listDDays(today: string = todayKst()): DDayView[] {
  const rows = db.prepare('SELECT * FROM ddays ORDER BY created_at ASC').all() as DDayRow[];
  return rows
    .map((row) => toView(row, today))
    .sort((a, b) => {
      const aPast = a.days < 0 && !a.repeatYearly;
      const bPast = b.days < 0 && !b.repeatYearly;
      if (aPast !== bPast) return aPast ? 1 : -1;
      return a.days - b.days;
    });
}

export function getDDay(id: string): DDayView | null {
  const row = db.prepare('SELECT * FROM ddays WHERE id = ?').get(id) as DDayRow | undefined;
  return row ? toView(row, todayKst()) : null;
}

export interface CreateDDayInput {
  title?: unknown;
  date?: unknown;
  repeatYearly?: unknown;
  notes?: unknown;
}

export function createDDay(input: CreateDDayInput): { ok: true; dday: DDayView } | { ok: false; error: string } {
  const title = String(input.title ?? '').trim().slice(0, 80);
  if (!title) return { ok: false, error: 'D-Day 이름을 입력해 주세요.' };
  const date = normalizeDateInput(input.date);
  if (!date) {
    return { ok: false, error: '날짜를 YYYY-MM-DD 형식으로 알려 주세요(예: 2027-05-15).' };
  }
  const count = (db.prepare('SELECT COUNT(*) AS n FROM ddays').get() as { n: number }).n;
  if (count >= MAX_DDAYS) return { ok: false, error: `D-Day는 최대 ${MAX_DDAYS}개까지 저장할 수 있습니다.` };
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const repeat = input.repeatYearly === true || input.repeatYearly === 'true' || input.repeatYearly === 1 || input.repeatYearly === '1';
  db.prepare(
    'INSERT INTO ddays(id, title, target_date, repeat_yearly, notes, created_at, updated_at) VALUES(?,?,?,?,?,?,?)'
  ).run(id, title, date, repeat ? 1 : 0, input.notes ? String(input.notes).slice(0, 300) : null, now, now);
  return { ok: true, dday: getDDay(id) as DDayView };
}

/** id · 제목(일부)로 삭제 */
export function deleteDDay(query: unknown): { removed: DDayView[]; error?: string } {
  const raw = String(query ?? '').trim();
  if (!raw) return { removed: [], error: '어떤 D-Day를 지울지 이름으로 알려 주세요.' };
  const views = listDDays();
  const key = raw.toLowerCase();
  const exact = views.filter((view) => view.id === raw || view.title.toLowerCase() === key);
  const matched = exact.length ? exact : views.filter((view) => view.title.toLowerCase().includes(key));
  if (!matched.length) return { removed: [], error: `'${raw}'에 해당하는 D-Day를 찾지 못했습니다.` };
  for (const view of matched) db.prepare('DELETE FROM ddays WHERE id = ?').run(view.id);
  return { removed: matched };
}

/** 도구·화면 공용 한 줄 표기 */
export function ddayLine(view: DDayView): string {
  const parts = [`${view.title} ${view.label}`, view.dateLabel];
  if (view.repeatYearly) parts.push('매년 반복');
  if (view.notes) parts.push(view.notes);
  return parts.join(' · ');
}
