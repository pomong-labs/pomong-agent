/**
 * v0.6.16 — 환율 · 주식 · 코인 시세 (API 키 불필요)
 *
 *  · 환율: Frankfurter(ECB 기준) — 전 영업일 값까지 함께 받아 전일 대비를 계산한다.
 *          없으면 open.er-api(하루 1회 갱신)로 대신한다(전일 대비 없음).
 *  · 코인: 업비트 공개 시세(KRW 마켓) — 전일 종가·변동률을 그대로 준다.
 *  · 주식: 야후 파이낸스 chart 응답(전일 종가 포함) — 국내는 `.KS`/`.KQ`, 미국은 티커.
 */

import { kstStamp, kstStampFull } from './kst';

const UA = 'Mozilla/5.0 (compatible; PomongAgent/0.6.16; +https://github.com/pomong-labs/pomong-agent)';

export type QuoteKind = 'fx' | 'crypto' | 'stock';

export interface Quote {
  kind: QuoteKind;
  /** 표시용 이름 (USD/KRW, 삼성전자, BTC …) */
  name: string;
  symbol: string;
  price: number;
  currency: string;
  change: number | null;
  changePct: number | null;
  /** 시세 기준 시각(ISO). 없으면 null */
  at: string | null;
  note?: string;
}

export interface QuoteFailure {
  ok: false;
  reason: string;
}

export interface QuoteSuccess {
  ok: true;
  quotes: Quote[];
  source: string;
}

export type QuoteResult = QuoteSuccess | QuoteFailure;

/* ------------------------------------------------------------------ */
/* 환율                                                                */
/* ------------------------------------------------------------------ */

const CURRENCY_ALIASES: { code: string; names: string[] }[] = [
  { code: 'KRW', names: ['원', '원화', '대한민국원', '한국돈', 'krw'] },
  { code: 'USD', names: ['달러', '미국달러', '미국 달러', 'usd', '달러화'] },
  { code: 'JPY', names: ['엔', '엔화', '일본엔', '일본 엔', 'jpy'] },
  { code: 'EUR', names: ['유로', '유로화', 'eur'] },
  { code: 'CNY', names: ['위안', '위안화', '중국위안', '위엔', 'cny'] },
  { code: 'GBP', names: ['파운드', '영국파운드', 'gbp'] },
  { code: 'AUD', names: ['호주달러', '호주 달러', 'aud'] },
  { code: 'CAD', names: ['캐나다달러', '캐나다 달러', 'cad'] },
  { code: 'HKD', names: ['홍콩달러', '홍콩 달러', 'hkd'] },
  { code: 'TWD', names: ['대만달러', '대만 달러', 'twd'] },
  { code: 'SGD', names: ['싱가포르달러', 'sgd'] },
  { code: 'THB', names: ['태국바트', '바트', 'thb'] },
  { code: 'VND', names: ['베트남동', '동', 'vnd'] },
  { code: 'CHF', names: ['스위스프랑', '프랑', 'chf'] },
];

const SUPPORTED_FX = new Set(CURRENCY_ALIASES.map((entry) => entry.code));

/** '달러', '엔화', 'USD' … → 통화 코드 */
export function currencyCode(text: string): string | null {
  const key = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!key) return null;
  for (const entry of CURRENCY_ALIASES) {
    if (entry.names.some((name) => name.replace(/\s+/g, '').toLowerCase() === key)) return entry.code;
  }
  return null;
}

interface FxSeries {
  dates: string[];
  base: string;
  quote: string;
  values: number[];
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function frankfurterSeries(base: string, quote: string): Promise<FxSeries | null> {
  if (!SUPPORTED_FX.has(base) || !SUPPORTED_FX.has(quote)) return null;
  const end = new Date();
  const start = new Date(end.getTime() - 10 * 24 * 3600_000);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const url = `https://api.frankfurter.app/${iso(start)}..${iso(end)}?from=${base}&to=${quote}`;
  const res = await fetchJson(url);
  if (!res.ok || !res.data) return null;
  const rates = (res.data as { rates?: Record<string, Record<string, number>> }).rates;
  if (!rates) return null;
  const dates = Object.keys(rates).sort();
  const values = dates
    .map((date) => rates[date]?.[quote])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return null;
  return { dates: dates.slice(-values.length), base, quote, values };
}

/** 전일 대비가 있는 환율 (Frankfurter). 없으면 open.er-api 값만. */
async function quoteFx(base: string, quote: string): Promise<Quote | QuoteFailure> {
  if (base === quote) return { ok: false, reason: '같은 통화끼리는 시세를 볼 수 없습니다.' };
  const series = await frankfurterSeries(base, quote).catch(() => null);
  if (series) {
    const price = series.values[series.values.length - 1];
    const prev = series.values.length > 1 ? series.values[series.values.length - 2] : null;
    const change = prev === null ? null : price - prev;
    const changePct = prev ? ((price - prev) / prev) * 100 : null;
    const lastDate = series.dates[series.dates.length - 1] || '';
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastDate);
    const dateLabel = dateParts ? `${Number(dateParts[2])}월 ${Number(dateParts[3])}일` : lastDate;
    return {
      kind: 'fx',
      name: `${base}/${quote}`,
      symbol: `${base}${quote}`,
      price,
      currency: quote,
      change,
      changePct,
      at: null,
      note: `ECB 고시${dateLabel ? ` (${dateLabel})` : ''}`,
    };
  }
  // 예비: open.er-api (USD 기준 고시 환율, 하루 1회 갱신)
  const res = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (!res.ok || !res.data) return { ok: false, reason: '환율 조회에 실패했습니다(외부 서비스 응답 없음).' };
  const payload = res.data as { rates?: Record<string, number>; time_last_update_utc?: string };
  const rates = payload.rates || {};
  const baseRate = base === 'USD' ? 1 : rates[base];
  const quoteRate = quote === 'USD' ? 1 : rates[quote];
  if (!baseRate || !quoteRate) {
    return { ok: false, reason: `${base}/${quote} 환율을 찾지 못했습니다. USD·JPY·EUR·CNY처럼 주요 통화로 다시 물어봐 주세요.` };
  }
  return {
    kind: 'fx',
    name: `${base}/${quote}`,
    symbol: `${base}${quote}`,
    price: quoteRate / baseRate,
    currency: quote,
    change: null,
    changePct: null,
    at: payload.time_last_update_utc ? new Date(payload.time_last_update_utc).toISOString() : null,
    note: '일 1회 고시(전일 대비 없음)',
  };
}

/* ------------------------------------------------------------------ */
/* 코인 (업비트)                                                        */
/* ------------------------------------------------------------------ */

interface UpbitMarket {
  market: string;
  korean_name: string;
  english_name: string;
}

let upbitCache: { at: number; markets: UpbitMarket[] } | null = null;

async function upbitMarkets(): Promise<UpbitMarket[]> {
  if (upbitCache && Date.now() - upbitCache.at < 60 * 60_000) return upbitCache.markets;
  const res = await fetchJson('https://api.upbit.com/v1/market/all');
  if (!res.ok || !Array.isArray(res.data)) return upbitCache?.markets || [];
  const markets = (res.data as UpbitMarket[]).filter((item) => typeof item?.market === 'string');
  upbitCache = { at: Date.now(), markets };
  return markets;
}

const CRYPTO_NAME_HINTS: Record<string, string> = {
  비트코인: 'BTC',
  이더리움: 'ETH',
  리플: 'XRP',
  도지코인: 'DOGE',
  도지: 'DOGE',
  솔라나: 'SOL',
  에이다: 'ADA',
  카르다노: 'ADA',
  트론: 'TRX',
  폴카닷: 'DOT',
  체인링크: 'LINK',
  스텔라: 'XLM',
  시바이누: 'SHIB',
  앱토스: 'APT',
  수이: 'SUI',
  세이: 'SEI',
  톤: 'TON',
  니어: 'NEAR',
  아발란체: 'AVAX',
  폴리곤: 'MATIC',
  이더리움클래식: 'ETC',
  비트코인캐시: 'BCH',
  온도파이낸스: 'ONDO',
  페페: 'PEPE',
};

/** 대문자 티커가 코인인지 미국 주식인지 가르는 사전(자주 찾는 코인만) */
export const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'XRP', 'DOGE', 'SOL', 'ADA', 'TRX', 'DOT', 'LINK', 'XLM', 'SHIB', 'APT', 'SUI', 'SEI',
  'TON', 'NEAR', 'AVAX', 'MATIC', 'ETC', 'BCH', 'ONDO', 'PEPE', 'USDT', 'USDC', 'ATOM', 'ALGO', 'VET',
  'HBAR', 'FIL', 'ARB', 'OP', 'SAND', 'MANA', 'AXS', 'CHZ', 'GRT', 'IMX', 'BLUR', 'WLD', 'ENA', 'JUP',
  'PYTH', 'STX', 'RNDR', 'RENDER', 'FET', 'TAO', 'AAVE', 'MKR', 'COMP', 'SNX', 'CRV', 'ANKR', 'ZIL',
  'EOS', 'NEO', 'KSM', 'QTUM', 'THETA', 'BTT', 'ROSE', 'GLMR', 'ASTR', 'INJ', 'TIA', 'OSMO', 'KAVA',
  'LDO', 'WEMIX', 'KLAY', 'EGLD', 'FLOW', 'XEC', 'IOTA', 'WAVES', 'DASH', 'ZEC', '1INCH', 'BAT',
]);

/** '비트코인'·'BTC'·'이더리움' → 코인 심볼('BTC') */
export function cryptoHintSymbol(query: string): string | null {
  const raw = query.trim();
  if (!raw) return null;
  const hires = CRYPTO_NAME_HINTS[raw.replace(/\s+/g, '')];
  if (hires) return hires;
  const upper = raw.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(upper) ? upper : null;
}

async function quoteCrypto(rawQuery: string): Promise<Quote | QuoteFailure> {
  const markets = await upbitMarkets();
  if (!markets.length) return { ok: false, reason: '코인 시세를 불러오지 못했습니다(업비트 응답 없음).' };
  const key = rawQuery.trim().toLowerCase().replace(/\s+/g, '');
  const symbol = cryptoHintSymbol(rawQuery);
  const found =
    markets.find((item) => item.market === `KRW-${symbol}`) ||
    markets.find((item) => item.korean_name.replace(/\s+/g, '').toLowerCase() === key) ||
    markets.find((item) => item.english_name.toLowerCase() === key) ||
    markets.find((item) => item.market.replace('KRW-', '').toLowerCase() === key);
  if (!found) {
    return {
      ok: false,
      reason: `'${rawQuery}' 코인을 업비트 원화 마켓에서 찾지 못했습니다. 예: 비트코인(BTC), 이더리움(ETH), 리플(XRP)`,
    };
  }
  const res = await fetchJson(`https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(found.market)}`);
  const list = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
  const row = list[0];
  if (!res.ok || !row) return { ok: false, reason: '코인 시세를 불러오지 못했습니다(업비트 응답 없음).' };
  const price = Number(row.trade_price);
  const prev = Number(row.prev_closing_price);
  const change = Number.isFinite(prev) ? price - prev : null;
  const changePct = Number.isFinite(prev) && prev ? ((price - prev) / prev) * 100 : null;
  const stamp = String(row.trade_date_kst || '') + String(row.trade_time_kst || '');
  const at = /^\d{8}\d{6}$/.test(stamp)
    ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}+09:00`
    : null;
  return {
    kind: 'crypto',
    name: found.korean_name || found.market,
    symbol: found.market.replace('KRW-', ''),
    price,
    currency: 'KRW',
    change,
    changePct,
    at,
    note: `업비트 ${found.market}`,
  };
}

/* ------------------------------------------------------------------ */
/* 주식                                                                */
/* ------------------------------------------------------------------ */

/** 국내 종목 이름 → 종목코드 (자주 찾는 종목만) */
export const KR_STOCKS: Record<string, string> = {
  삼성전자: '005930',
  sk하이닉스: '000660',
  lg에너지솔루션: '373220',
  삼성바이오로직스: '207940',
  현대차: '005380',
  현대자동차: '005380',
  기아: '000270',
  네이버: '035420',
  naver: '035420',
  카카오: '035720',
  셀트리온: '068270',
  포스코홀딩스: '005490',
  posco홀딩스: '005490',
  삼성sdi: '006400',
  lg화학: '051910',
  현대모비스: '012330',
  kb금융: '105560',
  신한지주: '055550',
  하나금융지주: '086790',
  삼성물산: '028260',
  sk이노베이션: '096770',
  크래프톤: '259960',
  엔씨소프트: '036570',
  넷마블: '251270',
  하이브: '352820',
  에코프로비엠: '247540',
  에코프로: '086520',
  두산에너빌리티: '034020',
  한화에어로스페이스: '012450',
  삼성전기: '009150',
  삼성생명: '032830',
  삼성화재: '000810',
  우리금융지주: '316140',
  메리츠금융지주: '138040',
  카카오뱅크: '323410',
  카카오페이: '377300',
  sk텔레콤: '017670',
  kt: '030200',
  lg유플러스: '032640',
  대한항공: '003490',
  아모레퍼시픽: '090430',
  cj제일제당: '097950',
  오리온: '271560',
  농심: '004370',
  롯데케미칼: '011170',
  금호타이어: '073240',
  유한양행: '000100',
  알테오젠: '196170',
  리노공업: '058470',
  이오테크닉스: '039030',
  원익ips: '240810',
};

/** 지수 이름 → 야후 심볼 */
export const INDEXES: Record<string, string> = {
  코스피: '^KS11',
  kospi: '^KS11',
  코스닥: '^KQ11',
  kosdaq: '^KQ11',
  나스닥: '^IXIC',
  nasdaq: '^IXIC',
  's&p500': '^GSPC',
  's&p': '^GSPC',
  다우: '^DJI',
  다우존스: '^DJI',
  니케이: '^N225',
  니케이225: '^N225',
  항셍: '^HSI',
  상해: '000001.SS',
};

interface YahooMeta {
  symbol?: string;
  currency?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketChangePercent?: number;
  regularMarketTime?: number;
  shortName?: string;
  longName?: string;
  exchangeName?: string;
}

async function yahooChart(symbol: string): Promise<YahooMeta | null> {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
    const res = await fetchJson(url).catch(() => null);
    if (!res?.ok || !res.data) continue;
    const result = (res.data as { chart?: { result?: { meta?: YahooMeta }[] } }).chart?.result;
    const meta = Array.isArray(result) ? result[0]?.meta : undefined;
    if (meta && Number.isFinite(Number(meta.regularMarketPrice))) return meta;
  }
  return null;
}

interface StockTarget {
  symbol: string;
  label: string;
  currency: string;
}

/** 입력 → 야후 심볼 */
export function resolveStockTargets(rawQuery: string): StockTarget[] {
  const raw = rawQuery.trim();
  const key = raw.toLowerCase().replace(/\s+/g, '');
  const index = INDEXES[key];
  if (index) return [{ symbol: index, label: raw.toUpperCase(), currency: index.startsWith('^') ? 'POINT' : 'KRW' }];
  const krName = KR_STOCKS[key];
  if (krName) {
    return [
      { symbol: `${krName}.KS`, label: raw, currency: 'KRW' },
      { symbol: `${krName}.KQ`, label: raw, currency: 'KRW' },
    ];
  }
  if (/^\d{6}$/.test(raw)) {
    return [
      { symbol: `${raw}.KS`, label: raw, currency: 'KRW' },
      { symbol: `${raw}.KQ`, label: raw, currency: 'KRW' },
    ];
  }
  if (/^[A-Za-z][A-Za-z.^-]{0,9}$/.test(raw)) {
    return [{ symbol: raw.toUpperCase(), label: raw.toUpperCase(), currency: 'USD' }];
  }
  return [];
}

async function quoteStock(rawQuery: string): Promise<Quote | QuoteFailure> {
  const targets = resolveStockTargets(rawQuery);
  if (!targets.length) {
    return {
      ok: false,
      reason: `'${rawQuery}' 종목을 찾지 못했습니다. 국내는 종목 이름(삼성전자)이나 코드(005930), 미국은 티커(AAPL·TSLA)로 알려 주세요.`,
    };
  }
  for (const target of targets) {
    const meta = await yahooChart(target.symbol);
    if (!meta) continue;
    const price = Number(meta.regularMarketPrice);
    const prevRaw = Number(meta.chartPreviousClose ?? meta.previousClose);
    const prev = Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : null;
    const change = prev === null ? null : price - prev;
    const changePct = prev ? ((price - prev) / prev) * 100 : null;
    const at = meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : null;
    return {
      kind: 'stock',
      name: meta.shortName || meta.longName || target.label,
      symbol: String(meta.symbol || target.symbol),
      price,
      currency: String(meta.currency || target.currency),
      change,
      changePct,
      at,
      note: meta.exchangeName || undefined,
    };
  }
  return { ok: false, reason: `${rawQuery} 시세를 불러오지 못했습니다(심볼 확인 또는 잠시 뒤 다시).` };
}

/* ------------------------------------------------------------------ */
/* 입력 해석 · 표시                                                     */
/* ------------------------------------------------------------------ */

export type MarketQueryKind = QuoteKind | null;

/** "USD/KRW", "달러 원", "BTC", "삼성전자", "AAPL" … → 종류 판별 */
export function detectQuoteKind(rawQuery: string): MarketQueryKind {
  const raw = rawQuery.trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, '');
  const lowered = raw.toLowerCase().replace(/\s+/g, '');
  // 1) 통화쌍 — 'USD/KRW', 'USDKRW'
  const pair = /([A-Za-z]{3})\s*[\/\-_:]?\s*([A-Za-z]{3})/.exec(raw);
  if (pair && SUPPORTED_FX.has(pair[1].toUpperCase()) && SUPPORTED_FX.has(pair[2].toUpperCase())) return 'fx';
  // 2) 국내 주식·지수·종목코드
  if (KR_STOCKS[lowered] || INDEXES[lowered] || /^\d{6}$/.test(cleaned)) return 'stock';
  // 3) 코인 (한글 이름 → 코인 사전)
  if (CRYPTO_NAME_HINTS[cleaned]) return 'crypto';
  // 4) 대문자 티커 — 코인 사전에 있으면 코인, 없으면 미국 주식
  const upper = cleaned.toUpperCase();
  if (/^[A-Z0-9]{2,10}$/.test(upper)) {
    if (CRYPTO_SYMBOLS.has(upper)) return 'crypto';
    if (/^[A-Z][A-Z.^-]{0,9}$/.test(cleaned)) return 'stock';
  }
  // 5) 통화 이름 하나만 말했으면 그 통화↔원 환율로 본다
  const currencyMentioned = CURRENCY_ALIASES.some((entry) =>
    entry.names.some((name) => lowered.includes(name.toLowerCase()))
  );
  if (currencyMentioned) return 'fx';
  return null;
}

function koreanFxOrder(base: string, quote: string): { base: string; quote: string } {
  // 우리말 '원달러·원엔'은 "1달러에 몇 원"이라는 뜻이다 — 원이 앞에 와도 기준은 외화로 둔다.
  if (base === 'KRW' && quote !== 'KRW') return { base: quote, quote: 'KRW' };
  return { base, quote };
}

function fxPair(rawQuery: string): { base: string; quote: string } | null {
  const raw = rawQuery.trim();
  const pair = /([A-Za-z]{3})\s*[\/\-_:]?\s*([A-Za-z]{3})/.exec(raw);
  if (pair) {
    const base = pair[1].toUpperCase();
    const quote = pair[2].toUpperCase();
    if (SUPPORTED_FX.has(base) && SUPPORTED_FX.has(quote)) return koreanFxOrder(base, quote);
  }
  const found: string[] = [];
  const lowered = raw.toLowerCase();
  for (const entry of CURRENCY_ALIASES) {
    if (entry.names.some((name) => lowered.includes(name.toLowerCase()))) found.push(entry.code);
  }
  const unique = [...new Set(found)];
  if (unique.length === 0) return null;
  if (unique.length === 1) return koreanFxOrder(unique[0], 'KRW');
  return koreanFxOrder(unique[0], unique[1]);
}

function decimalsFor(currency: string, value: number, kind: QuoteKind): number {
  if (currency === 'KRW') {
    // 주가·코인은 원 단위 정수, 환율은 소수점이 의미가 있다(1,339.44원 · 8.43원).
    if (kind !== 'fx') return 0;
    return value >= 10 ? 2 : 4;
  }
  if (currency === 'POINT') return 2;
  if (currency === 'JPY' || currency === 'VND' || currency === 'IDR' || currency === 'CNY') {
    return kind === 'fx' ? (value >= 100 ? 2 : 4) : value >= 100 ? 0 : 2;
  }
  return kind === 'fx' ? 4 : 2;
}

export function formatMoney(value: number, currency: string, kind: QuoteKind = 'stock'): string {
  if (!Number.isFinite(value)) return '-';
  const digits = decimalsFor(currency, Math.abs(value), kind);
  const number = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  if (currency === 'KRW') return `${number}원`;
  if (currency === 'USD') return `$${number}`;
  if (currency === 'EUR') return `€${number}`;
  if (currency === 'GBP') return `£${number}`;
  if (currency === 'JPY' || currency === 'CNY') return `¥${number}`;
  if (currency === 'POINT') return number;
  return `${currency} ${number}`;
}

function formatChange(quote: Quote): string {
  if (quote.change === null || quote.changePct === null) return '전일 대비 확인 불가';
  const sign = quote.change > 0 ? '+' : quote.change < 0 ? '-' : '';
  const diff = formatMoney(Math.abs(quote.change), quote.currency, quote.kind).replace('-', '');
  const pct = Math.abs(quote.changePct).toFixed(2);
  if (quote.change === 0) return '전일 대비 변동 없음';
  return `전일 대비 ${sign}${diff} (${sign}${pct}%)`;
}

function formatQuoteLine(quote: Quote): string {
  const head = quote.kind === 'fx' ? `${quote.name} 1 = ${formatMoney(quote.price, quote.currency, quote.kind)}` : `${quote.name} ${formatMoney(quote.price, quote.currency, quote.kind)}`;
  const parts = [head, formatChange(quote)];
  const stamp = kstStamp(quote.at);
  if (stamp) parts.push(`기준 ${stamp}`);
  if (quote.note) parts.push(quote.note);
  return `• ${parts.join(' · ')}`;
}

export const MARKET_EXAMPLES = '예: USD/KRW, JPY/KRW, 삼성전자, AAPL, 코스피, BTC, 이더리움';

/** 여러 종목을 한 번에(쉼표 구분, 최대 5개) */
export async function lookupQuotes(rawQuery: string): Promise<QuoteResult> {
  const queries = String(rawQuery || '')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!queries.length) return { ok: false, reason: `무엇의 시세를 볼지 알려 주세요. ${MARKET_EXAMPLES}` };

  const quotes: Quote[] = [];
  const failures: string[] = [];
  for (const query of queries) {
    const kind = detectQuoteKind(query);
    let result: Quote | QuoteFailure;
    if (kind === 'fx') {
      const pair = fxPair(query);
      result = pair ? await quoteFx(pair.base, pair.quote) : { ok: false, reason: `'${query}' 통화쌍을 해석하지 못했습니다.` };
    } else if (kind === 'crypto') {
      result = await quoteCrypto(query);
    } else if (kind === 'stock') {
      result = await quoteStock(query);
    } else {
      result = { ok: false, reason: `'${query}'는 환율·주식·코인 어느 쪽인지 알 수 없습니다. ${MARKET_EXAMPLES}` };
    }
    if ('ok' in result) failures.push(result.reason);
    else quotes.push(result);
  }

  if (!quotes.length) {
    return { ok: false, reason: failures.join(' / ') || `시세를 찾지 못했습니다. ${MARKET_EXAMPLES}` };
  }
  return {
    ok: true,
    quotes,
    source: failures.length ? failures.join(' / ') : '',
  };
}

/** 도구 응답 문구 */
export function formatQuotes(result: QuoteSuccess): string {
  const lines = [`💹 시세 · ${kstStampFull(new Date())} 기준`, ...result.quotes.map(formatQuoteLine)];
  if (result.source) lines.push('', `※ ${result.source}`);
  lines.push('※ 출처: ECB 고시 환율(환율) · 업비트(코인) · 야후 파이낸스(주식) — 표시 시각과 실제 체결가가 다를 수 있습니다.');
  return lines.join('\n');
}
