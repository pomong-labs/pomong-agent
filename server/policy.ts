import { db, getSetting, setSetting } from './db';

/**
 * 도메인 정책 · 승인 매트릭스 (Phase 2 가드레일)
 *
 * 모델은 이 정책을 바꿀 수 없다. 정책은 화면(설정)에서만 바꾸고,
 * 브라우저 도구는 매 액션마다 서버에서 다시 검사한다.
 */

export type PolicyLevel = 'allow' | 'confirm' | 'block' | 'handover';

export interface PolicyRow {
  pattern: string;
  level: PolicyLevel;
  note: string | null;
}

export const POLICY_LABELS: Record<PolicyLevel, string> = {
  allow: '허용',
  confirm: '확인 필요',
  block: '차단',
  handover: '사람이 로그인',
};

/**
 * 기본 시드. 사용자가 저장소를 처음 켰을 때 이 값으로 시작한다.
 * (사용자가 화면에서 지우거나 등급을 바꾸면 그 값이 우선한다)
 */
const SEED_POLICIES: PolicyRow[] = [
  // 차단 — 접근 자체를 거부
  { pattern: 'bet365.com', level: 'block', note: '도박' },
  { pattern: '1xbet.com', level: 'block', note: '도박' },
  { pattern: 'bc.game', level: 'block', note: '도박' },
  { pattern: 'stake.com', level: 'block', note: '도박' },
  { pattern: 'casino', level: 'block', note: '도박' },
  { pattern: 'pornhub.com', level: 'block', note: '성인' },
  { pattern: 'xvideos.com', level: 'block', note: '성인' },
  { pattern: 'upbit.com', level: 'block', note: '가상자산 거래소' },
  { pattern: 'bithumb.com', level: 'block', note: '가상자산 거래소' },
  { pattern: 'binance.com', level: 'block', note: '가상자산 거래소' },
  { pattern: 'coinbase.com', level: 'block', note: '가상자산 거래소' },

  // 사람이 직접 — 금융·정부·본인인증
  { pattern: 'kbstar.com', level: 'handover', note: '은행' },
  { pattern: 'shinhan.com', level: 'handover', note: '은행' },
  { pattern: 'wooribank.com', level: 'handover', note: '은행' },
  { pattern: 'ibk.co.kr', level: 'handover', note: '은행' },
  { pattern: 'nhbank.com', level: 'handover', note: '은행' },
  { pattern: 'kakaobank.com', level: 'handover', note: '은행' },
  { pattern: 'tossbank.com', level: 'handover', note: '은행' },
  { pattern: 'gov.kr', level: 'handover', note: '정부 포털' },
  { pattern: 'hometax.go.kr', level: 'handover', note: '국세청' },
  { pattern: 'minwon24.go.kr', level: 'handover', note: '정부24' },
  { pattern: 'kiwoom.com', level: 'handover', note: '증권' },
  { pattern: 'miraeasset.com', level: 'handover', note: '증권' },
  { pattern: 'samsungcard.com', level: 'handover', note: '카드사' },
  { pattern: 'hyundaicard.com', level: 'handover', note: '카드사' },
  { pattern: 'toss.im', level: 'handover', note: '송금' },
  { pattern: 'paypal.com', level: 'handover', note: '결제' },

  // 확인 — 쇼핑·예약·커뮤니티
  { pattern: 'coupang.com', level: 'confirm', note: '쇼핑' },
  { pattern: '11st.co.kr', level: 'confirm', note: '쇼핑' },
  { pattern: 'gmarket.co.kr', level: 'confirm', note: '쇼핑' },
  { pattern: 'musinsa.com', level: 'confirm', note: '쇼핑' },
  { pattern: 'oliveyoung.co.kr', level: 'confirm', note: '쇼핑' },
  { pattern: 'yes24.com', level: 'confirm', note: '쇼핑' },
  { pattern: 'kyobobook.co.kr', level: 'confirm', note: '쇼핑' },
  { pattern: 'smartstore.naver.com', level: 'confirm', note: '쇼핑' },
  { pattern: 'yanolja.com', level: 'confirm', note: '예약' },
  { pattern: 'goodchoice.kr', level: 'confirm', note: '예약' },
  { pattern: 'catchtable.co.kr', level: 'confirm', note: '예약' },
  { pattern: 'dcinside.com', level: 'confirm', note: '커뮤니티' },
  { pattern: 'clien.net', level: 'confirm', note: '커뮤니티' },
  { pattern: 'reddit.com', level: 'confirm', note: '커뮤니티' },
  { pattern: 'x.com', level: 'confirm', note: 'SNS' },
  { pattern: 'instagram.com', level: 'confirm', note: 'SNS' },

  // 허용 — 공개 정보·문서
  { pattern: 'wikipedia.org', level: 'allow', note: '백과' },
  { pattern: 'namu.wiki', level: 'allow', note: '백과' },
  { pattern: 'github.com', level: 'allow', note: '코드' },
  { pattern: 'gitlab.com', level: 'allow', note: '코드' },
  { pattern: 'google.com', level: 'allow', note: '검색' },
  { pattern: 'naver.com', level: 'allow', note: '검색' },
  { pattern: 'daum.net', level: 'allow', note: '검색' },
  { pattern: 'stackoverflow.com', level: 'allow', note: '문서' },
  { pattern: 'developer.mozilla.org', level: 'allow', note: '문서' },
  { pattern: 'open-meteo.com', level: 'allow', note: '날씨' },
  { pattern: 'example.com', level: 'allow', note: '예제' },
];

let seeded = false;

function seedOnce(): void {
  if (seeded) return;
  seeded = true;
  if (getSetting('policies.seeded') === '1') return;
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT OR IGNORE INTO policies(pattern, level, note, created_at) VALUES(?,?,?,?)');
  const tx = db.transaction(() => {
    for (const p of SEED_POLICIES) insert.run(p.pattern, p.level, p.note, now);
  });
  tx();
  setSetting('policies.seeded', '1');
}

export function listPolicies(): PolicyRow[] {
  seedOnce();
  const rows = db.prepare('SELECT pattern, level, note FROM policies ORDER BY level, pattern').all() as PolicyRow[];
  return rows;
}

export function normalizeLevel(value: unknown): PolicyLevel | null {
  return value === 'allow' || value === 'confirm' || value === 'block' || value === 'handover' ? value : null;
}

export function setPolicy(pattern: string, level: PolicyLevel, note: string | null): void {
  seedOnce();
  const clean = pattern.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean) throw new Error('도메인 패턴이 비어 있습니다.');
  db.prepare(
    'INSERT INTO policies(pattern, level, note, created_at) VALUES(?,?,?,?) ON CONFLICT(pattern) DO UPDATE SET level = excluded.level, note = excluded.note'
  ).run(clean, level, note, new Date().toISOString());
}

export function removePolicy(pattern: string): void {
  db.prepare('DELETE FROM policies WHERE pattern = ?').run(pattern.trim().toLowerCase());
}

export interface PolicyVerdict {
  /** 실제 판정 등급. 정책에 없는 도메인은 기본 confirm(처음 보는 사이트는 사람이 한 번 확인) */
  level: PolicyLevel;
  pattern: string | null;
  note: string | null;
  host: string;
}

export function hostOf(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase();
  } catch {
    return String(rawUrl || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  }
}

export function evaluateUrl(rawUrl: string): PolicyVerdict {
  seedOnce();
  const host = hostOf(rawUrl);
  const rows = db.prepare('SELECT pattern, level, note FROM policies').all() as PolicyRow[];
  let best: PolicyRow | null = null;
  for (const row of rows) {
    if (!host) break;
    if (host === row.pattern || host.endsWith(`.${row.pattern}`)) {
      // 더 구체적인(긴) 패턴이 이긴다
      if (!best || row.pattern.length > best.pattern.length) best = row;
    }
  }
  if (!best) return { level: 'confirm', pattern: null, note: '처음 보는 사이트', host };
  return { level: best.level, pattern: best.pattern, note: best.note, host };
}

/** 결제·게시·삭제처럼 되돌릴 수 없는 조작인지 */
const PAYMENT_WORDS = /(결제|구매|송금|후원|입금|출금|주문\s*완료|pay\s*now|place\s*order|buy\s*now|checkout|purchase|donate|transfer)/i;
/**
 * 게시·댓글·리뷰로 나가는 버튼 (v0.6.1: '댓글 등록'·'등록'처럼 실제 화면에 많은 말을 보강했다.
 * 영어는 단어 경계를 써서 postcode 같은 단어를 잘못 잡지 않는다)
 */
const PUBLISH_WORDS = /(게시|등록|올리기|댓글|리뷰|후기|\b(post|publish|tweet|comment|submit)\b)/i;
const DESTRUCTIVE_WORDS = /(삭제|탈퇴|해지|계정\s*변경|비밀번호\s*변경|delete|remove|unsubscribe|cancel\s*account)/i;

export interface ActionVerdict {
  /** 사람 승인이 필요한가 */
  confirm: boolean;
  reason?: string;
  /** 아예 실행 금지(결제 하드블록 등) */
  forbidden?: boolean;
}

/**
 * 사용자가 이번 요청에서 전송·답장·댓글·게시를 **직접 부탁했는지** (v0.6.1)
 *
 * 현준 님 지침(11-13)에 따라 게시·댓글 버튼은 기본 차단이지만, 사용자가
 * "이 문의에 답장 보내 줘"처럼 명시적으로 시키면 AI는 끝까지 실행해야 한다.
 * 그 판단 근거를 이번 턴의 사용자 문장에서만 찾는다(모델의 추측으로 풀리지 않게).
 */
export function userRequestedPublish(userRequest: string): boolean {
  const text = String(userRequest || '');
  if (!text.trim()) return false;
  const action = /(답장|답변|회신|보내|전송|댓글|게시|올려|올리|등록|작성|써서|써\s*줘|달아|남겨|포스팅|reply|send|post|comment)/i;
  const target = /(메시지|문의|쪽지|댓글|게시글|리뷰|후기|답장|회신|DM|디엠|카톡|채팅|글|답변)/i;
  return action.test(text) && target.test(text);
}

/**
 * 브라우저 도구 한 건의 위험도 판정.
 * - 결제·카드 입력: 무조건 사람(하드블록)
 * - 게시·댓글·리뷰: 기본 차단(대표님 11-13 지침). 단 사용자가 이번 턴에 직접
 *   전송·답장·게시를 부탁했으면(allowPublish) 통과시킨다.
 * - 삭제·계정 변경: 금지
 */
export function evaluateBrowserAction(
  tool: string,
  args: Record<string, unknown>,
  options: { allowPublish?: boolean } = {}
): ActionVerdict {
  const text = [args.text, args.label, args.selector, args.description].filter(Boolean).join(' ');
  if (tool === 'browser_type') {
    const into = String(args.target || args.field || '');
    if (/card|cvc|cvv|카드|계좌|주민|password|비밀번호/i.test(into)) {
      return { confirm: false, forbidden: true, reason: '카드·계좌·비밀번호 입력은 에이전트가 할 수 없습니다(사람이 입력).' };
    }
    if (PAYMENT_WORDS.test(text)) return { confirm: true, reason: '결제 관련 입력' };
  }
  if (tool === 'browser_click') {
    if (PAYMENT_WORDS.test(text)) return { confirm: true, reason: '결제·구매 버튼' };
    if (PUBLISH_WORDS.test(text) && !options.allowPublish) return { confirm: true, reason: '게시·댓글 버튼' };
    if (DESTRUCTIVE_WORDS.test(text)) return { confirm: true, reason: '삭제·계정 변경 버튼' };
  }
  return { confirm: false };
}

/** 프롬프트 인젝션 의심 문구 */
export function looksLikeInjection(text: string): boolean {
  return /(이전\s*지시|위\s*지시|시스템\s*프롬프트|ignore (all )?previous|disregard .*instruction|api\s*key|토큰을?\s*보내|시크릿을?\s*보내)/i.test(
    text.slice(0, 4000)
  );
}
