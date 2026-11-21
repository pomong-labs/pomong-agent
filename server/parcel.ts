/**
 * v0.6.16 — 택배 배송 조회 (공개 조회 경로 · API 키 불필요)
 *
 * ① 기본 경로: Delivery Tracker 공개 API(https://apis.tracker.delivery)
 *    - 국내 택배사 30여 곳을 같은 모양(progresses)으로 돌려준다. 계정·키가 필요 없다.
 * ② 예비 경로: CJ대한통운 공식 조회 페이지(tracking → _csrf → tracking-detail JSON)
 *    - 공개 API가 죽거나 막혔을 때 CJ만은 공식 페이지로 다시 시도한다.
 *
 * 응답에는 기사님 이름·전화번호가 섞여 오므로(예: "배송담당:홍길동 010-1234-5678")
 * 내보내기 전에 전화번호를 가린다.
 */

import https from 'node:https';
import { APP_VERSION } from './config';

const API_BASE = (process.env.PARCEL_API_BASE || 'https://apis.tracker.delivery').replace(/\/+$/, '');
const UA = `PomongAgent/${APP_VERSION} (+https://github.com/pomong-labs/pomong-agent)`;

export interface CarrierMeta {
  /** Delivery Tracker 택배사 id */
  id: string;
  label: string;
  /** 사용자가 부르는 다른 이름들 */
  aliases: string[];
  /** 이 택배사 송장번호 자릿수 (자동 추정용) */
  lengths: number[];
}

/** 자주 쓰는 국내 택배사 (넓게 지원 — id는 Delivery Tracker 규격) */
export const CARRIERS: CarrierMeta[] = [
  { id: 'kr.cjlogistics', label: 'CJ대한통운', aliases: ['cj', 'cj대한통운', '대한통운', '씨제이'], lengths: [10, 12] },
  { id: 'kr.epost', label: '우체국택배', aliases: ['우체국', '우체국택배', 'epost', '등기', '등기우편', '소포'], lengths: [13] },
  { id: 'kr.hanjin', label: '한진택배', aliases: ['한진', '한진택배'], lengths: [10, 11, 12, 13] },
  { id: 'kr.logen', label: '로젠택배', aliases: ['로젠', '로젠택배', 'klogis'], lengths: [11, 12] },
  { id: 'kr.lotte', label: '롯데택배', aliases: ['롯데', '롯데택배', '현대택배'], lengths: [12] },
  { id: 'kr.coupangls', label: '쿠팡로지스틱스', aliases: ['쿠팡', '쿠팡택배', '쿠팡로지스틱스'], lengths: [10, 12] },
  { id: 'kr.cvsnet', label: 'GS포스트박스(편의점택배)', aliases: ['gs', 'gs25', '편의점택배', '포스트박스', 'cvsnet'], lengths: [10, 11, 12, 13] },
  { id: 'kr.kdexp', label: '경동택배', aliases: ['경동', '경동택배'], lengths: [10, 11, 12, 13] },
  { id: 'kr.daesin', label: '대신택배', aliases: ['대신', '대신택배'], lengths: [10, 11, 12, 13] },
  { id: 'kr.ilyanglogis', label: '일양로지스', aliases: ['일양', '일양로지스'], lengths: [10, 11, 12, 13] },
  { id: 'kr.hdexp', label: '합동택배', aliases: ['합동', '합동택배'], lengths: [10, 11, 12, 13] },
  { id: 'kr.epost.ems', label: '우체국 EMS', aliases: ['ems', '국제택배', '국제우편'], lengths: [9, 10, 11, 13] },
];

/** 상태 id → 한국어 단계 */
export const STATE_LABELS: Record<string, string> = {
  information_received: '접수',
  at_pickup: '집화 완료',
  in_transit: '배송 중',
  out_for_delivery: '배송 출발',
  delivery_attempt_failed: '배송 시도 실패',
  delivered: '배송 완료',
  available_for_pickup: '수령 대기',
  exception: '배송 지연·예외',
  not_found: '조회 안 됨',
  unknown: '확인 중',
};

export const DELIVERED_STATE = 'delivered';

export interface ParcelEvent {
  /** ISO 8601 (대개 +09:00) */
  time: string;
  statusId: string;
  statusText: string;
  location: string;
  description: string;
}

export interface ParcelSnapshot {
  ok: true;
  carrierId: string;
  carrierLabel: string;
  trackingNumber: string;
  stateId: string;
  stateText: string;
  events: ParcelEvent[];
  /** 마지막 이벤트 시각(ISO) */
  lastEventTime: string;
  lastLocation: string;
  lastDescription: string;
  /** 조회에 실제로 쓴 경로 (delivery-tracker | cj-direct) */
  source: string;
  fetchedAt: string;
}

export interface ParcelFailure {
  ok: false;
  notFound: boolean;
  reason: string;
}

export type ParcelResult = ParcelSnapshot | ParcelFailure;

/* ------------------------------------------------------------------ */
/* 이름 → 택배사                                                       */
/* ------------------------------------------------------------------ */

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[-_]/g, '');
}

export function findCarrierByName(name: unknown): CarrierMeta | null {
  const key = normalizeKey(String(name ?? ''));
  if (!key) return null;
  for (const carrier of CARRIERS) {
    if (normalizeKey(carrier.id) === key) return carrier;
  }
  for (const carrier of CARRIERS) {
    const names = [carrier.label, ...carrier.aliases].map(normalizeKey);
    if (names.includes(key)) return carrier;
  }
  // 느슨한 포함 검사 — 'CJ대한통운 택배' 처럼 조금 붙어 와도 찾는다.
  for (const carrier of CARRIERS) {
    const names = [carrier.label, ...carrier.aliases].map(normalizeKey);
    if (names.some((candidate) => candidate.length >= 2 && (key.includes(candidate) || candidate.includes(key)))) {
      return carrier;
    }
  }
  return null;
}

export function carrierLabel(carrierId: string): string {
  return CARRIERS.find((carrier) => carrier.id === carrierId)?.label || carrierId;
}

/** 송장번호 자릿수로 그럴듯한 택배사를 앞에서부터 늘어놓는다(자동 추정). */
export function carrierCandidates(number: string): CarrierMeta[] {
  const digits = number.replace(/\D/g, '').length;
  const matched = CARRIERS.filter((carrier) => carrier.lengths.includes(digits));
  return matched.length ? matched : CARRIERS.slice(0, 4);
}

export function normalizeTrackingNumber(value: unknown): string {
  return String(value ?? '')
    .replace(/[^0-9]/g, '')
    .slice(0, 20);
}

/* ------------------------------------------------------------------ */
/* 개인정보(기사님 연락처) 가리기                                        */
/* ------------------------------------------------------------------ */

export function maskPersonal(text: string): string {
  return String(text || '')
    .replace(/\b(0\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, '$1-****-****')
    .replace(/배송담당\s*[:：]\s*[^\s()]+/g, '배송담당 기사님');
}

/* ------------------------------------------------------------------ */
/* 조회                                                                */
/* ------------------------------------------------------------------ */

interface TrackerProgress {
  time?: string;
  status?: { id?: string; text?: string };
  location?: { name?: string };
  description?: string;
}

interface TrackerPayload {
  carrier?: { id?: string; name?: string };
  from?: { name?: string | null; time?: string | null };
  to?: { name?: string | null; time?: string | null };
  progresses?: TrackerProgress[];
  state?: { id?: string; text?: string };
}

function toEvents(payload: TrackerPayload): ParcelEvent[] {
  const list = Array.isArray(payload.progresses) ? payload.progresses : [];
  return list
    .map((item) => ({
      time: String(item.time || ''),
      statusId: String(item.status?.id || 'unknown'),
      statusText: String(item.status?.text || ''),
      location: String(item.location?.name || ''),
      description: maskPersonal(String(item.description || '')),
    }))
    .filter((event) => event.time || event.statusText || event.description);
}

function buildSnapshot(
  carrierId: string,
  trackingNumber: string,
  payload: TrackerPayload,
  source: string
): ParcelResult {
  const events = toEvents(payload);
  if (!events.length) {
    return { ok: false, notFound: true, reason: '조회 결과가 없습니다. 운송장 번호와 택배사를 확인해 주세요.' };
  }
  // 시간 순으로 정렬(문자열 ISO는 같은 오프셋에서 사전순 비교가 곧 시간순이다).
  events.sort((a, b) => a.time.localeCompare(b.time));
  const last = events[events.length - 1];
  const stateId = String(payload.state?.id || last.statusId || 'unknown');
  const stateText = String(payload.state?.text || last.statusText || '');
  return {
    ok: true,
    carrierId,
    carrierLabel: carrierLabel(carrierId),
    trackingNumber,
    stateId,
    stateText,
    events,
    lastEventTime: last.time,
    lastLocation: last.location,
    lastDescription: last.description,
    source,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchPublicTracker(carrierId: string, trackingNumber: string): Promise<ParcelResult> {
  const url = `${API_BASE}/carriers/${encodeURIComponent(carrierId)}/tracks/${encodeURIComponent(trackingNumber)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (res.status === 404) {
      return { ok: false, notFound: true, reason: '조회 결과가 없습니다. 운송장 번호와 택배사를 확인해 주세요.' };
    }
    if (!res.ok) {
      return { ok: false, notFound: false, reason: `배송 조회 서비스가 응답 ${res.status}을 돌려줬습니다.` };
    }
    const payload = (await res.json()) as TrackerPayload;
    return buildSnapshot(carrierId, trackingNumber, payload, 'delivery-tracker');
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- CJ 공식 페이지 예비 경로 ------------------------------- */

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpsRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'ko-KR,ko;q=0.9',
          ...(options.headers || {}),
        },
        timeout: options.timeoutMs ?? 12_000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('시간 초과')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const CJ_STATE_MAP: Record<string, string> = {
  '01': 'information_received',
  '11': 'at_pickup',
  '21': 'in_transit',
  '31': 'in_transit',
  '41': 'in_transit',
  '42': 'in_transit',
  '44': 'in_transit',
  '82': 'out_for_delivery',
  '91': 'delivered',
};

interface CjResultItem {
  crgSt?: string;
  dTime?: string;
  regBranNm?: string;
  scanNm?: string;
  crgNm?: string;
}

/** CJ대한통운 공식 조회 페이지(_csrf → tracking-detail). 공개 API가 막혔을 때만 쓴다. */
async function fetchCjDirect(trackingNumber: string): Promise<ParcelResult> {
  const entry = await httpsRequest('https://www.cjlogistics.com/ko/tool/parcel/tracking', {
    headers: { Accept: 'text/html' },
  });
  const csrf = /name="_csrf"\s+value="([^"]+)"/.exec(entry.body)?.[1];
  if (!csrf) return { ok: false, notFound: false, reason: 'CJ대한통운 조회 화면에서 인증 토큰을 찾지 못했습니다.' };
  const setCookie = entry.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
    .map((item) => String(item).split(';')[0])
    .join('; ');
  const body = new URLSearchParams({ _csrf: csrf, paramInvcNo: trackingNumber }).toString();
  const detail = await httpsRequest('https://www.cjlogistics.com/ko/tool/parcel/tracking-detail', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: 'https://www.cjlogistics.com/ko/tool/parcel/tracking',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  if (detail.status !== 200) {
    return { ok: false, notFound: false, reason: `CJ대한통운 조회가 응답 ${detail.status}을 돌려줬습니다.` };
  }
  let parsed: { parcelDetailResultMap?: { resultList?: CjResultItem[] } };
  try {
    parsed = JSON.parse(detail.body) as { parcelDetailResultMap?: { resultList?: CjResultItem[] } };
  } catch {
    return { ok: false, notFound: false, reason: 'CJ대한통운 응답을 읽지 못했습니다.' };
  }
  const rows = parsed.parcelDetailResultMap?.resultList || [];
  if (!rows.length) {
    return { ok: false, notFound: true, reason: '조회 결과가 없습니다. 운송장 번호를 확인해 주세요.' };
  }
  const events: ParcelEvent[] = rows.map((row) => {
    const stamp = String(row.dTime || '').replace(' ', 'T');
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(stamp) ? `${stamp}+09:00` : stamp;
    const code = String(row.crgSt || '');
    return {
      time: iso,
      statusId: CJ_STATE_MAP[code] || 'in_transit',
      statusText: String(row.scanNm || ''),
      location: String(row.regBranNm || ''),
      description: maskPersonal(String(row.crgNm || '')),
    };
  });
  events.sort((a, b) => a.time.localeCompare(b.time));
  const last = events[events.length - 1];
  return {
    ok: true,
    carrierId: 'kr.cjlogistics',
    carrierLabel: carrierLabel('kr.cjlogistics'),
    trackingNumber,
    stateId: last.statusId,
    stateText: last.statusText,
    events,
    lastEventTime: last.time,
    lastLocation: last.location,
    lastDescription: last.description,
    source: 'cj-direct',
    fetchedAt: new Date().toISOString(),
  };
}

/** 한 택배사로 조회. 공개 API가 통째로 실패(네트워크·5xx)하면 CJ만 예비 경로로 재시도한다. */
export async function fetchParcel(carrierId: string, trackingNumber: string): Promise<ParcelResult> {
  try {
    return await fetchPublicTracker(carrierId, trackingNumber);
  } catch (err) {
    if (carrierId === 'kr.cjlogistics') {
      try {
        return await fetchCjDirect(trackingNumber);
      } catch {
        /* 아래 공통 오류로 넘어간다 */
      }
    }
    return {
      ok: false,
      notFound: false,
      reason: `배송 조회에 실패했습니다(${err instanceof Error ? err.message : String(err)}). 잠시 뒤 다시 시도해 주세요.`,
    };
  }
}

/**
 * 택배사 없이 송장번호만으로 조회 — 자릿수로 후보를 좁혀 차례로 시도한다.
 * (후보가 많아도 보통 첫 1~2곳에서 끝난다)
 */
export async function lookupParcel(input: { number: unknown; carrier?: unknown }): Promise<ParcelResult & { triedCarriers?: string[] }> {
  const number = normalizeTrackingNumber(input.number);
  if (number.length < 8) {
    return { ok: false, notFound: false, reason: '운송장 번호가 너무 짧습니다. 숫자만 다시 확인해 주세요.' };
  }
  const named = findCarrierByName(input.carrier);
  if (String(input.carrier || '').trim() && !named) {
    return {
      ok: false,
      notFound: false,
      reason: `'${String(input.carrier)}' 택배사를 찾지 못했습니다. 지원하는 택배사: ${CARRIERS.map((c) => c.label).join(', ')}`,
    };
  }
  const candidates = named ? [named] : carrierCandidates(number);
  const tried: string[] = [];
  for (const carrier of candidates.slice(0, 4)) {
    tried.push(carrier.label);
    const result = await fetchParcel(carrier.id, number);
    if (result.ok) return { ...result, triedCarriers: tried };
    // '조회 결과 없음'이면 다음 후보, 그 밖의 오류(서비스 장애)면 거기서 멈춘다.
    if (!result.notFound) {
      return { ...result, triedCarriers: tried };
    }
  }
  return {
    ok: false,
    notFound: true,
    reason: `운송장 ${number}의 조회 결과를 찾지 못했습니다(${tried.join(', ')} 확인). 택배사 이름을 함께 알려 주시면 다시 조회할게요.`,
    triedCarriers: tried,
  };
}

/* ------------------------------------------------------------------ */
/* 화면·도구용 문구                                                     */
/* ------------------------------------------------------------------ */

function kstStamp(iso: string): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function stateLabel(stateId: string, stateText = ''): string {
  const label = STATE_LABELS[stateId] || '';
  const text = String(stateText || '').trim();
  if (label && text && text !== label) return `${label} (${text})`;
  return label || text || '확인 중';
}

/** 도구 응답용 요약(최근 이력 포함) */
export function formatParcel(snapshot: ParcelSnapshot, options: { events?: number } = {}): string {
  const limit = Math.max(1, Math.min(20, options.events ?? 8));
  const recent = snapshot.events.slice(-limit).reverse();
  const lines = [
    `📦 ${snapshot.carrierLabel} · 운송장 ${snapshot.trackingNumber}`,
    `현재 상태: ${stateLabel(snapshot.stateId, snapshot.stateText)} · ${kstStamp(snapshot.lastEventTime)}`,
    snapshot.lastLocation ? `위치: ${snapshot.lastLocation}` : '',
    snapshot.lastDescription ? `최근 안내: ${snapshot.lastDescription}` : '',
    '',
    `이동 이력 ${snapshot.events.length}건 (최근 ${recent.length}건, 최신순)`,
    ...recent.map((event) => {
      const parts = [kstStamp(event.time), event.location, stateLabel(event.statusId, event.statusText)].filter(Boolean);
      return `- ${parts.join(' · ')}${event.description ? ` — ${event.description}` : ''}`;
    }),
  ];
  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

/** 채팅방 알림용 한 줄 요약 */
export function parcelNoticeLine(snapshot: ParcelSnapshot): string {
  const parts = [snapshot.lastLocation, stateLabel(snapshot.stateId, snapshot.stateText)].filter(Boolean);
  return `${kstStamp(snapshot.lastEventTime)} · ${parts.join(' · ')}${snapshot.lastDescription ? `\n${snapshot.lastDescription}` : ''}`;
}
