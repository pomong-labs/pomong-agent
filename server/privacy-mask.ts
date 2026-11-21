import { addLog, getSetting, setSetting } from './db';

/**
 * v0.6.18: 외부 AI 전송 전 개인정보 자동 마스킹
 *
 * 사용자가 메시지를 보내면 그대로 Gemini·OpenAI·Claude·EXAONE 로 나간다.
 * 설정에서 켜 두면(기본 ON) 전화번호·계좌번호·카드번호·주민등록번호·이메일을
 * `[전화번호 1]` 같은 자리표시자로 바꿔 보내고, 모델의 답변·도구 인자에 남은
 * 자리표시자는 원래 값으로 되돌린다(로컬에서 도구를 실행할 때 실제 값이 필요하므로).
 *
 * 번호는 **대화 전체를 한 번에 훑은 순서**로 매기므로, 매 단계(step)마다 같은
 * 대화를 다시 마스킹해도 같은 값이 같은 번호를 받는다.
 */

export const MASK_SETTING_KEY = 'privacy.maskExternal';

export function maskingEnabled(): boolean {
  return getSetting(MASK_SETTING_KEY) !== '0';
}

export function setMaskingEnabled(on: boolean): void {
  setSetting(MASK_SETTING_KEY, on ? '1' : '0');
  addLog('info', on ? '개인정보 자동 마스킹을 켰습니다' : '개인정보 자동 마스킹을 껐습니다');
}

export type MaskLabel = 'rrn' | 'card' | 'phone' | 'account' | 'email';

export const MASK_LABELS: Record<MaskLabel, string> = {
  rrn: '주민등록번호',
  card: '카드번호',
  phone: '전화번호',
  account: '계좌번호',
  email: '이메일',
};

interface Rule {
  label: MaskLabel;
  source: string;
}

/**
 * 순서가 중요하다 — 주민번호·카드번호를 먼저 걷어내야 전화·계좌 패턴이 조각을 물지 않는다.
 * 모두 경계(숫자 앞뒤)를 확인해 문장 속 숫자를 과하게 가리지 않는다.
 */
const RULES: Rule[] = [
  { label: 'rrn', source: '(?<!\\d)\\d{6}[-\\s]?[1-4]\\d{6}(?!\\d)' },
  { label: 'card', source: '(?<!\\d)(?:\\d{4}[-\\s]?){3}\\d{4}(?!\\d)' },
  { label: 'phone', source: '(?<!\\d)(?:\\+?82[-\\s]?)?0\\d{1,2}[-\\s.]?\\d{3,4}[-\\s.]?\\d{4}(?!\\d)' },
  { label: 'account', source: '(?<!\\d)\\d{2,6}[-\\s]\\d{2,6}[-\\s]\\d{2,7}(?:[-\\s]\\d{1,4})?(?!\\d)' },
  { label: 'email', source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
];

const COMBINED = new RegExp(RULES.map((r) => `(?<${r.label}>${r.source})`).join('|'), 'g');

export interface MaskToken {
  token: string;
  label: MaskLabel;
  value: string;
}

/** 한 번의 마스킹 작업(대화 한 번)에서 값 ↔ 자리표시자 짝을 기억한다. */
export class PrivacyMasker {
  private byValue = new Map<string, string>();
  private tokens: MaskToken[] = [];
  private counts: Partial<Record<MaskLabel, number>> = {};

  /** 문자열 하나를 마스킹한다. 같은 값은 언제나 같은 자리표시자로 바뀐다. */
  mask(text: string): string {
    if (!text) return text;
    return text.replace(COMBINED, (match, ...rest) => {
      const groups = rest[rest.length - 1] as Record<string, string | undefined>;
      const label = (Object.keys(MASK_LABELS) as MaskLabel[]).find((key) => groups?.[key] !== undefined);
      if (!label) return match;
      const value = String(match).trim();
      const existing = this.byValue.get(value);
      if (existing) return existing;
      const next = (this.counts[label] || 0) + 1;
      this.counts[label] = next;
      const token = `[${MASK_LABELS[label]} ${next}]`;
      this.byValue.set(value, token);
      this.tokens.push({ token, label, value });
      return token;
    });
  }

  /** 자리표시자를 원래 값으로 되돌린다(모델 답변·도구 인자). */
  restore(text: string): string {
    if (!text || !this.tokens.length) return text;
    let out = text;
    for (const item of this.tokens) {
      if (!out.includes(item.token)) continue;
      out = out.split(item.token).join(item.value);
    }
    return out;
  }

  get count(): number {
    return this.tokens.length;
  }

  get labels(): MaskLabel[] {
    return Array.from(new Set(this.tokens.map((t) => t.label)));
  }

  summary(): string {
    if (!this.tokens.length) return '';
    const parts = this.labels.map((label) => `${MASK_LABELS[label]} ${this.counts[label] || 0}건`);
    return parts.join(' · ');
  }
}

/** 객체 안의 모든 문자열(도구 인자 등)에 같은 마스커를 적용한다. */
export function maskDeep<T>(value: T, masker: PrivacyMasker): T {
  if (typeof value === 'string') return masker.mask(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, masker)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = maskDeep(inner, masker);
    return out as unknown as T;
  }
  return value;
}

export function restoreDeep<T>(value: T, masker: PrivacyMasker): T {
  if (typeof value === 'string') return masker.restore(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => restoreDeep(item, masker)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = restoreDeep(inner, masker);
    return out as unknown as T;
  }
  return value;
}

/** 마스킹이 켜져 있을 때만 마스커를 만든다(호출부 편의). */
export function createMaskerIfEnabled(): PrivacyMasker | null {
  return maskingEnabled() ? new PrivacyMasker() : null;
}
