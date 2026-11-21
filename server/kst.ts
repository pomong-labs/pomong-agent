/**
 * v0.6.16 — 한국 시간 표기 (로케일 없이 계산)
 *
 * 컨테이너의 ICU 구성에 따라 `toLocaleString('ko-KR')`가 "AM 10:30"처럼
 * 영어로 나오는 일이 있어, 시세·택배 시각은 직접 계산해 표기한다.
 */

const KST_OFFSET_MS = 9 * 60 * 60_000;

export interface KstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function kstParts(date: Date): KstParts {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 오늘이면 '10:30', 다른 날이면 '11월 20일 15:30' */
export function kstStamp(iso: string | Date | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return typeof iso === 'string' ? iso : '';
  const parts = kstParts(date);
  const today = kstParts(now);
  const clock = `${pad(parts.hour)}:${pad(parts.minute)}`;
  if (parts.year === today.year && parts.month === today.month && parts.day === today.day) return clock;
  return `${parts.month}월 ${parts.day}일 ${clock}`;
}

/** '11월 21일 10:30' (날짜까지 항상) */
export function kstStampFull(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return typeof iso === 'string' ? iso : '';
  const parts = kstParts(date);
  return `${parts.month}월 ${parts.day}일 ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** '2026년 11월 21일 (토)' — 날짜만 */
export function kstDateLabel(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return ymd;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${year}년 ${month}월 ${day}일 (${WEEKDAYS[weekday]})`;
}
