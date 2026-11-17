/**
 * 날씨 조회 (Open-Meteo · API 키 불필요)
 *
 * - 지오코딩: geocoding-api.open-meteo.com (한국 지명은 server/places.ts 표를 먼저 본다)
 * - 예보: api.open-meteo.com/v1/forecast
 *
 * 두 API 모두 무료·키 없이 쓸 수 있어 셀프호스팅/오픈소스 배포에 그대로 들어간다.
 */
import { KOREA_PLACES } from './places';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** WMO 날씨 코드 → 한국어 */
const WEATHER_CODES: Record<number, string> = {
  0: '맑음',
  1: '대체로 맑음',
  2: '구름 조금',
  3: '흐림',
  45: '안개',
  48: '서리 안개',
  51: '약한 이슬비',
  53: '이슬비',
  55: '강한 이슬비',
  56: '어는 이슬비',
  57: '강한 어는 이슬비',
  61: '약한 비',
  63: '비',
  65: '강한 비',
  66: '어는 비',
  67: '강한 어는 비',
  71: '약한 눈',
  73: '눈',
  75: '강한 눈',
  77: '눈 알갱이',
  80: '약한 소나기',
  81: '소나기',
  82: '강한 소나기',
  85: '약한 눈 소나기',
  86: '강한 눈 소나기',
  95: '뇌우',
  96: '뇌우·우박',
  99: '강한 뇌우·우박',
};

export function describeWeather(code: number | null | undefined): string {
  if (code === null || code === undefined) return '정보 없음';
  return WEATHER_CODES[code] || `알 수 없음(${code})`;
}

interface Place {
  /** 화면에 보여줄 이름 */
  name: string;
  /** 상위 지역(시·도/주/국가) */
  region: string;
  lat: number;
  lon: number;
}

const SUFFIXES = ['특별자치시', '특별자치도', '특별시', '광역시', '시', '군', '구', '읍', '면', '동', '도'];

function stripSuffix(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.length > suffix.length && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

/** "강원도 인제", "인제군", "제주 서귀포" 처럼 들어와도 표에서 찾을 수 있게 후보를 만든다. */
function candidates(input: string): string[] {
  const raw = input.trim().replace(/\s+/g, ' ');
  const out: string[] = [];
  const push = (value: string) => {
    const key = value.trim();
    if (key && !out.includes(key)) out.push(key);
  };
  push(raw);
  const words = raw.split(' ').filter(Boolean);
  if (words.length > 1) push(words[words.length - 1]);
  push(stripSuffix(raw));
  for (const word of words) push(stripSuffix(word));
  // "강원도인제" 처럼 붙여 쓴 경우
  for (const word of words) push(word);
  return out;
}

function fromKoreaTable(input: string): Place | null {
  for (const key of candidates(input)) {
    const hit = KOREA_PLACES[key];
    if (hit) return { name: hit.name, region: '대한민국', lat: hit.lat, lon: hit.lon };
  }
  return null;
}

async function geocode(input: string): Promise<Place | null> {
  const url = `${GEO_URL}?name=${encodeURIComponent(input)}&count=5&language=ko&format=json`;
  const data = await fetchJson<{
    results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string; country_code?: string }[];
  }>(url);
  const results = data?.results || [];
  if (!results.length) return null;
  // 같은 이름의 외국 마을보다 한국 결과를 먼저 쓴다.
  const korean = results.find((r) => r.country_code === 'KR');
  const hit = korean || results[0];
  return {
    name: hit.name,
    region: [hit.admin1, hit.country].filter(Boolean).join(', '),
    lat: hit.latitude,
    lon: hit.longitude,
  };
}

export async function findPlace(input: string): Promise<Place | null> {
  const raw = input.trim();
  if (!raw) return null;
  return fromKoreaTable(raw) || (await geocode(raw));
}

/**
 * 짧은 예산(기본 5초)으로 한 번만 시도한다. 답이 늦으면 기다리게 하지 않고
 * 호출한 쪽에서 대체 소스로 넘어간다.
 */
async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Open-Meteo가 막히거나 늦을 때 쓰는 대체 소스(wttr.in, 키 불필요). */
async function wttrFallback(place: Place): Promise<string | null> {
  const url = `https://wttr.in/${place.lat},${place.lon}?format=j1`;
  const data = await fetchJson<{
    current_condition?: { temp_C?: string; FeelsLikeC?: string; humidity?: string; windspeedKmph?: string; weatherDesc?: { value?: string }[] }[];
  }>(url, 5000);
  const cur = data?.current_condition?.[0];
  if (!cur) return null;
  const desc = cur.weatherDesc?.[0]?.value || '정보 없음';
  return [
    `${place.name} (${place.region})`,
    `지금 ${cur.temp_C ?? '-'}°C (체감 ${cur.FeelsLikeC ?? '-'}°C) · ${desc} · 습도 ${cur.humidity ?? '-'}% · 바람 ${cur.windspeedKmph ?? '-'}km/h`,
    '(예보 상세는 지금 일시적으로 받지 못했어요. 현재 날씨만 안내합니다.)',
  ].join('\n');
}

interface ForecastResponse {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    precipitation?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    precipitation_sum?: number[];
    sunrise?: string[];
    sunset?: string[];
  };
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function dayLabel(date: string, index: number): string {
  if (index === 0) return '오늘';
  if (index === 1) return '내일';
  const [, month, day] = date.split('-');
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return `${Number(month)}/${Number(day)} (${WEEKDAYS[weekday]})`;
}

function round(value: number | undefined | null): number | null {
  if (value === undefined || value === null || Number.isNaN(value)) return null;
  return Math.round(value * 10) / 10;
}

/** 날씨를 사람이 읽는 한국어 문장으로 돌려준다. 실패하면 안내 문장을 돌려준다. */
export async function weatherReport(location: string, days = 3): Promise<{ content: string; place?: Place }> {
  const place = await findPlace(location);
  if (!place) {
    return {
      content: `'${location}' 위치를 찾지 못했습니다. '서울', '강원도 인제', 'Iksan'처럼 도시 이름으로 다시 물어봐 주세요.`,
    };
  }
  const span = Math.min(7, Math.max(1, Math.round(days) || 3));
  const params = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    timezone: 'auto',
    forecast_days: String(span),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
  });
  const data = await fetchJson<ForecastResponse>(`${FORECAST_URL}?${params.toString()}`, 6000);
  if (!data?.current && !data?.daily) {
    const fallback = await wttrFallback(place);
    return {
      content: fallback || '날씨 정보를 지금 받지 못했어요. 잠시 뒤 다시 시도해 주세요.',
      place,
    };
  }

  const cur = data.current || {};
  const daily = data.daily || {};
  const lines = [`${place.name} (${place.region})`];
  lines.push(
    `지금 ${round(cur.temperature_2m) ?? '-'}°C (체감 ${round(cur.apparent_temperature) ?? '-'}°C) · ${describeWeather(cur.weather_code)}` +
      ` · 습도 ${round(cur.relative_humidity_2m) ?? '-'}% · 바람 ${round(cur.wind_speed_10m) ?? '-'}km/h` +
      (cur.precipitation ? ` · 강수 ${round(cur.precipitation)}mm` : '')
  );
  const dates = daily.time || [];
  if (dates.length) {
    lines.push('');
    lines.push(`${span === 1 ? '오늘' : `앞으로 ${span}일`} 예보 (최저~최고 · 강수확률):`);
    dates.slice(0, span).forEach((date, i) => {
      const min = round(daily.temperature_2m_min?.[i]);
      const max = round(daily.temperature_2m_max?.[i]);
      const pop = daily.precipitation_probability_max?.[i];
      const sum = round(daily.precipitation_sum?.[i]);
      lines.push(
        `- ${dayLabel(date, i)}: ${describeWeather(daily.weather_code?.[i])}, ${min ?? '-'}~${max ?? '-'}°C` +
          `${pop !== undefined && pop !== null ? `, 강수확률 ${pop}%` : ''}` +
          `${sum ? `, 예상 강수 ${sum}mm` : ''}`
      );
    });
  }
  return { content: lines.join('\n'), place };
}
