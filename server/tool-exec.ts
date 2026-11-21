/**
 * v0.7.0 — 병렬 도구 실행 + 일시 오류 자동 재시도
 *
 * 한 스텝에서 모델이 여러 도구 호출을 한꺼번에 돌려주면, **읽기만 하는 도구**는 서로
 * 기다릴 이유가 없다(검색 3건, 메일 2통 읽기, 택배 2건 조회...). 이걸 동시에 돌리면
 * 스텝 시간이 1/2~1/3 로 줄어 사용자가 덜 기다린다.
 *
 * 반대로 아래는 **절대 병렬로 돌리지 않는다**.
 *   · 브라우저 조작(click/type/open/close) — 한 페이지를 공유해서 순서가 곧 의미다
 *   · 쓰기·전송·결제·삭제(mail_send, file_save, memory_save, tasks_add, manage_docker ...)
 *   · 승인 카드가 필요한 도구, 금고 값을 꺼내는 도구
 *   · chat_notify(사용자에게 보이는 말풍선) — 순서가 뒤섞이면 대화가 어색해진다
 *
 * 일시 오류(429/503/타임아웃/연결 끊김)는 짧은 지수 백오프로 한두 번 더 시도한다.
 * 다만 **부작용이 있는 도구**는 "요청이 상대에게 닿았는지" 알 수 없는 오류에서 다시 보내면
 * 두 번 실행될 수 있으므로(메일 두 통 발송 등) 연결 자체가 안 된 오류에서만 재시도한다.
 */

/** 병렬 실행해도 안전한(읽기 전용) 도구 */
export const PARALLEL_SAFE_TOOLS = new Set<string>([
  'time_now',
  'tasks_list',
  'vault_list',
  'server_stats',
  'weather_get',
  'web_search',
  'memory_search',
  'chat_history_search',
  'read_skill',
  'mail_list',
  'mail_read',
  'mail_search',
  'automation_list',
  'attachment_read',
  'track_parcel',
  'get_market_quote',
  'dday_list',
  'browser_snapshot',
  'browser_extract',
]);

/** 읽기 전용이라 재시도해도 결과가 같은 도구(부작용 없음) */
export function isReadOnlyTool(name: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(name);
}

/**
 * 이 호출을 다른 호출과 동시에 실행해도 되는가.
 * 병렬 목록에 있어도 인자가 비어 있으면(스냅샷 등) 실행 자체는 읽기라 안전하다.
 */
export function isParallelSafe(name: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(name);
}

/** 한 스텝에서 동시에 돌릴 최대 개수(브라우저·서버에 부담을 주지 않는다) */
export const PARALLEL_LIMIT = 3;

/** 재시도해도 되는 오류인지 — 상태 코드·네트워크 문구로 판단한다. */
export function isTransientError(error: unknown): boolean {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  // 연결이 맺어지지도 않은 경우(요청이 상대에게 닿지 않았다 → 재시도 안전)
  if (/econnrefused|eai_again|enotfound|ehostunreach|network is unreachable|dns/.test(message)) return true;
  // 응답을 못 받았거나 중간에 끊긴 경우
  if (/timeout|timed out|etimedout|econnreset|socket hang up|aborted|fetch failed|network error/.test(message)) return true;
  // 서버가 잠시 바쁘다고 말한 경우
  if (/\b(429|500|502|503|504)\b/.test(message)) return true;
  if (/rate limit|too many requests|temporarily unavailable|service unavailable|overloaded/.test(message)) return true;
  return false;
}

/**
 * 부작용이 있는 도구에서 재시도해도 되는 오류인지.
 * "연결 자체가 안 됐다"가 확실한 경우만 — 응답 대기 중 타임아웃은 상대가 처리했을 수 있다.
 */
export function isRetryableForSideEffect(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /econnrefused|eai_again|enotfound|ehostunreach|network is unreachable|dns/.test(message);
}

/** 시도 n(0부터)의 대기 시간 — 400ms, 1,200ms, 3,000ms + 약간의 흔들림 */
export function backoffDelay(attempt: number): number {
  const base = [400, 1_200, 3_000][Math.min(attempt, 2)];
  const jitter = Math.floor(Math.random() * 150);
  return base + jitter;
}

export interface RetryOptions {
  attempts?: number;
  /** 부작용이 있는 도구인지(재시도 조건이 더 엄격해진다) */
  sideEffect?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 일시 오류에만 지수 백오프로 다시 시도한다.
 * 최종 실패는 마지막 오류를 그대로 던진다(호출부가 모델에게 알린다).
 */
export async function runWithRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1) break;
      const retryable = options.sideEffect ? isRetryableForSideEffect(error) : isTransientError(error);
      if (!retryable) break;
      const delay = backoffDelay(attempt);
      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 배열을 최대 limit 개씩 동시에 실행하되, 결과는 **입력 순서 그대로** 돌려준다.
 * (대화에 tool 메시지를 원래 순서로 넣어야 프로바이더가 짝을 맞춘다)
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
