/**
 * v0.7.0 — 무한 루프 · 헛발질 자동 감지 (Doom-Loop Breaker)
 *
 * 실제로 겪은 실패 모습:
 *   · 같은 `browser_snapshot` 을 같은 인자로 계속 부르며 "이제 눌러 볼게요"만 반복
 *   · 로그인 벽에 막힌 채 같은 클릭을 다섯 번
 *   · 검색이 계속 0건인데 같은 검색어로 재시도
 *
 * 사람이 보면 바로 아는 이 패턴을 서버가 감지해 끊는다. 순서는 이렇게 간다.
 *   1) 같은 도구·같은 인자가 **연속 3회째** → 그 호출을 실행하지 않고, 전략을 바꾸라는
 *      시스템 안내를 대화에 넣는다(모델이 다른 방법을 찾게).
 *   2) 그래도 또 같은 호출 → 상위 모델로 올려 한 번 더 기회를 준다(경량 모델이 특히 잘 걸린다).
 *   3) 또 반복 → 루프를 끝내고 사용자에게 "무엇이 막혔는지"를 정직하게 알린다.
 *   · 연속 실패가 3회 쌓이면 안내, 5회면 중단.
 *
 * 감지는 '거의 같은 인자'도 포함한다. 긴 값(스냅샷 텍스트·메일 본문)은 앞부분만 비교하고,
 * 공백·대소문자 차이는 무시한다 — 같은 일을 인자만 살짝 바꿔 반복하는 헛발질을 잡기 위해서다.
 */

export type DoomAction = 'allow' | 'nudge' | 'escalate' | 'stop';

export interface DoomDecision {
  action: DoomAction;
  /** 같은 호출이 연속으로 몇 번 있었는지(이번 호출 포함) */
  repeat: number;
  /** 연속 실패 횟수 */
  failures: number;
  signature: string;
  /** 모델에게 넣을 시스템 안내 문장 */
  message: string;
}

/** 같은 호출을 이만큼 연속으로 보면 개입한다(3번째 호출) */
export const REPEAT_NUDGE_AT = 2;
/** 연속 실패 안내 기준 */
export const FAILURE_NUDGE_AT = 3;
/** 연속 실패 중단 기준 */
export const FAILURE_STOP_AT = 5;
/** 스텝 전체에서 이 횟수만큼 개입하면 더는 버티지 않는다 */
export const MAX_NUDGES = 8;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`).join(',')}}`;
}

/**
 * 인자 지문. '거의 같은' 호출을 잡으려고 긴 문자열은 앞 80자만 쓰고,
 * 숫자는 소수 2자리로 반올림한다(스크롤 좌표 0.1px 차이 같은 건 같은 호출로 본다).
 */
export function callSignature(name: string, args: Record<string, unknown> | undefined): string {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 4) return '…';
    if (typeof value === 'string') {
      const flat = value.replace(/\s+/g, ' ').trim();
      // 긴 값(스냅샷·메일 본문)은 앞부분만 비교해 '거의 같은' 호출을 잡는다.
      return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    }
    if (typeof value === 'number') return Math.round(value * 100) / 100;
    if (Array.isArray(value)) return value.slice(0, 12).map((item) => walk(item, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = walk((value as Record<string, unknown>)[key], depth + 1);
      }
      return out;
    }
    return value;
  };
  return `${name}|${stableStringify(walk(args || {}, 0))}`;
}

interface CallRecord {
  name: string;
  signature: string;
  ok: boolean;
}

export interface DoomLoopOptions {
  repeatNudgeAt?: number;
  failureNudgeAt?: number;
  failureStopAt?: number;
  maxNudges?: number;
  /** 상위 모델로 올려 볼 수 있는지(모델 에스컬레이션 1회) */
  canEscalate?: boolean;
}

export class DoomLoopGuard {
  private calls: CallRecord[] = [];
  private nudgesBySignature = new Map<string, number>();
  private failureNudged = false;
  private escalations = 0;
  private nudgeCount = 0;
  private options: Required<Omit<DoomLoopOptions, 'canEscalate'>> & { canEscalate: boolean };

  constructor(options: DoomLoopOptions = {}) {
    this.options = {
      repeatNudgeAt: options.repeatNudgeAt ?? REPEAT_NUDGE_AT,
      failureNudgeAt: options.failureNudgeAt ?? FAILURE_NUDGE_AT,
      failureStopAt: options.failureStopAt ?? FAILURE_STOP_AT,
      maxNudges: options.maxNudges ?? MAX_NUDGES,
      canEscalate: options.canEscalate ?? true,
    };
  }

  /** 같은 서명이 꼬리에서 연속으로 몇 번 나왔는지 */
  private tailRepeat(signature: string): number {
    let count = 0;
    for (let i = this.calls.length - 1; i >= 0; i -= 1) {
      if (this.calls[i].signature !== signature) break;
      count += 1;
    }
    return count;
  }

  /** 도구 실패가 연속으로 몇 번 쌓였는지(성공이 나오면 0으로) */
  private failureStreak(): number {
    let count = 0;
    for (let i = this.calls.length - 1; i >= 0; i -= 1) {
      if (this.calls[i].ok) break;
      count += 1;
    }
    return count;
  }

  /**
   * 실행 직전에 판단한다. 실행하지 않기로 한 호출은 record() 하지 않는다
   * (안내를 넣은 뒤 또 같은 호출이 오면 다음 단계로 넘어가야 하므로).
   */
  inspect(name: string, args?: Record<string, unknown>): DoomDecision {
    const signature = callSignature(name, args);
    const repeat = this.tailRepeat(signature) + 1;
    const failures = this.failureStreak();

    if (this.options.maxNudges > 0 && this.nudgeCount >= this.options.maxNudges) {
      return {
        action: 'stop',
        repeat,
        failures,
        signature,
        message: `도구 호출을 ${this.nudgeCount}번 바로잡았지만 같은 시도가 계속되고 있어 작업을 멈춥니다.`,
      };
    }

    if (repeat > this.options.repeatNudgeAt) {
      const seen = this.nudgesBySignature.get(signature) || 0;
      this.nudgesBySignature.set(signature, seen + 1);
      if (seen === 0) {
        this.nudgeCount += 1;
        return {
          action: 'nudge',
          repeat,
          failures,
          signature,
          message: buildRepeatNudge(name, repeat),
        };
      }
      if (seen === 1 && this.options.canEscalate && this.escalations < 1) {
        this.escalations += 1;
        this.nudgeCount += 1;
        return {
          action: 'escalate',
          repeat,
          failures,
          signature,
          message: buildRepeatNudge(name, repeat, true),
        };
      }
      return {
        action: 'stop',
        repeat,
        failures,
        signature,
        message: `같은 '${name}' 호출을 인자까지 같게 ${repeat}번 반복해 작업을 멈춥니다.`,
      };
    }

    if (failures + 1 >= this.options.failureStopAt) {
      return {
        action: 'stop',
        repeat,
        failures: failures + 1,
        signature,
        message: `도구가 ${failures + 1}번 연속 실패해 작업을 멈춥니다.`,
      };
    }
    if (failures + 1 >= this.options.failureNudgeAt && !this.failureNudged) {
      this.failureNudged = true;
      this.nudgeCount += 1;
      return {
        action: 'nudge',
        repeat,
        failures: failures + 1,
        signature,
        message: buildFailureNudge(failures + 1),
      };
    }

    return { action: 'allow', repeat, failures, signature, message: '' };
  }

  /** 실행한 호출을 기록한다(성공/실패) */
  record(name: string, args: Record<string, unknown> | undefined, ok: boolean): void {
    this.calls.push({ name, signature: callSignature(name, args), ok });
    if (this.calls.length > 200) this.calls.splice(0, this.calls.length - 200);
    // 성공하면 '실패 연속' 안내는 다시 열어 둔다(다른 도구에서 또 막힐 수 있다).
    if (ok) this.failureNudged = false;
  }

  get breaks(): number {
    return this.nudgeCount;
  }

  get escalationCount(): number {
    return this.escalations;
  }

  summary(): { calls: number; nudges: number; escalations: number } {
    return { calls: this.calls.length, nudges: this.nudgeCount, escalations: this.escalations };
  }
}

export function buildRepeatNudge(name: string, repeat: number, escalated = false): string {
  const head = escalated
    ? `[v0.7.0 루프 감지] '${name}' 호출이 인자까지 같게 ${repeat}번 반복되었습니다. 상위 모델로 올렸으니 같은 시도를 되풀이하지 말고 전략을 바꾸세요.`
    : `[v0.7.0 루프 감지] '${name}' 호출이 인자까지 같게 ${repeat}번 반복되었습니다. 이 호출은 실행하지 않았습니다.`;
  return [
    head,
    '전략을 바꾸세요. 같은 호출을 또 보내면 똑같은 결과만 나옵니다. 다음 중 하나로 바꾸세요:',
    '1) 인자를 실제로 바꿔 보기(다른 검색어·다른 요소·다른 조건)',
    '2) 다른 도구로 같은 목표에 접근하기(예: browser_extract 대신 browser_snapshot, 검색 대신 직접 URL 열기)',
    '3) 이미 막혔다면(로그인 벽·권한 없음·페이지 오류) 사용자에게 무엇이 막혔는지 한 문장으로 알리고 멈추기',
    '지금까지의 결과를 정리해 다음 행동을 한 번만 결정한 뒤 실행하세요.',
  ].join('\n');
}

export function buildFailureNudge(failures: number): string {
  return [
    `[v0.7.0 루프 감지] 도구가 ${failures}번 연속 실패했습니다.`,
    '같은 방법을 반복하지 말고 ① 오류 문구를 그대로 읽고 원인(없는 주소·권한·로그인·형식)을 확인하고',
    '② 다른 도구나 다른 경로로 시도하고 ③ 그래도 안 되면 사용자에게 원인과 다음 선택지를 알리세요.',
  ].join('\n');
}
