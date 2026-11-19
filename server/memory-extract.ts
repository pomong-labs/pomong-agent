import { MEMORY_CATEGORIES, memoryCount } from './memory';
import { db } from './db';

/**
 * 대화 후 자동 기억 추출 (v0.5.4)
 *
 * 채팅 턴이 끝나면 서버가 백그라운드로 한 번 더 모델을 불러, 이번 대화에서
 * **오래 기억할 가치가 있는 사실만** 골라 memories에 저장한다.
 *
 * - 인사·날씨·테스트·일회성 잡담은 저장하지 않는다.
 * - 직업/신분·취향·습관·주변 인물·중요한 약속·프로젝트 규칙만 남긴다.
 * - 이미 저장된 기억과 문구가 겹치면 저장하지 않는다(중복 방지).
 */

const CATEGORY_IDS = MEMORY_CATEGORIES.map((c) => c.id) as string[];

const NOISE_PATTERNS: RegExp[] = [
  /^(안녕|하이|ㅎㅇ|반가|좋은\s*아침|굿모닝|good\s*morning|hi|hello)\b/i,
  /^(테스트|test|ㅌㅅㅌ|asdf|1234)/i,
  /(날씨|기온|비\s*와|우산|미세먼지)/,
  /^(고마워|땡큐|thanks|thank you|잘했어|오케이|ok|굿)/i,
  /^(ㅋ+|ㅎ+|ㅇㅇ|ㄴㄴ|응|어|그래)$/,
];

/** 이번 턴에 기억 추출을 돌릴 가치가 있는지(가벼운 1차 필터) */
export function shouldExtract(userText: string, assistantText: string): boolean {
  const text = String(userText || '').replace(/\s+/g, ' ').trim();
  if (text.length < 8) return false;
  if (NOISE_PATTERNS.some((re) => re.test(text))) return false;
  // 시스템이 만든 후속 턴(로그인 이어가기 등)은 사용자 발화가 아니다.
  if (/^\[시스템\]/.test(text)) return false;
  if (!assistantText || assistantText.length < 10) return false;
  return true;
}

/** 추출기에게 주는 지시문 */
export function extractionSystemPrompt(): string {
  return [
    '너는 사용자에 대한 장기 기억 추출기다. 방금 끝난 대화에서 **오래 기억할 가치가 있는 사실만** 골라 JSON으로만 답한다.',
    '',
    '저장할 것:',
    '- 직업·신분·소속·거주지 같은 프로필(예: "군 복무 중인 취사병이다")',
    '- 취향(좋아하는 음악·게임·색·스타일), 싫어하는 것',
    '- 습관·일과(아침 브리핑 시간, 자주 쓰는 서비스)',
    '- 주변 인물(친구·가족·동료의 이름과 관계)',
    '- 중요한 약속·일정의 반복 규칙',
    '- 프로젝트 규칙(예: "배포 전 tsc 검증을 요구한다")',
    '',
    '저장하지 말 것: 인사, 날씨·시간 같은 일회성 질문, 테스트 발언, 잡담, 이번 한 번만 쓰는 요청, 이미 저장된 내용.',
    '',
    '출력 형식(설명 없이 JSON 배열만):',
    '[{"category":"profile|taste|habit|person|promise|project|rule|other","content":"한 문장","importance":1}]',
    '기억할 것이 없으면 [] 만 출력한다. importance는 1~5, 규칙·중요한 약속은 4~5.',
  ].join('\n');
}

export interface ExtractedMemory {
  category: string;
  content: string;
  importance: number;
}

/** 모델 응답에서 JSON 배열만 뽑아낸다 */
export function parseExtraction(raw: string): ExtractedMemory[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtractedMemory[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const content = String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (content.length < 4) continue;
    out.push({
      category: CATEGORY_IDS.includes(String(row.category)) ? String(row.category) : 'other',
      content,
      importance: Math.min(5, Math.max(1, Math.round(Number(row.importance) || 2))),
    });
    if (out.length >= 5) break;
  }
  return out;
}

function normalizeForCompare(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text: string): Set<string> {
  const stop = new Set([
    '그리고', '그러면', '합니다', '입니다', '있습니다', '같아요', '좋아', '싶어', '한다', '했다', '하는', '에서', '으로',
  ]);
  return new Set(
    normalizeForCompare(text)
      .split(' ')
      .map((w) => w.replace(/(은|는|이|가|을|를|의|에|도|와|과|로|만)$/u, ''))
      .filter((w) => w.length >= 2 && !stop.has(w))
  );
}

/** 공백을 지운 두 문장의 글자 2-gram 겹침 비율(0~1) */
function bigramOverlap(a: string, b: string): number {
  const grams = (text: string): Set<string> => {
    const compact = text.replace(/\s+/g, '');
    const set = new Set<string>();
    for (let i = 0; i < compact.length - 1; i += 1) set.add(compact.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / Math.min(ga.size, gb.size);
}

/**
 * 이미 저장된 기억과 의미·문구가 겹치는지.
 * ① 한쪽이 다른 쪽을 그대로 포함하면 중복 ② 토큰 겹침이 60% 이상이면 중복으로 본다.
 */
export function isDuplicate(content: string, existing: string[]): boolean {
  const a = normalizeForCompare(content);
  if (!a) return true;
  const aTokens = tokenSet(content);
  for (const prev of existing) {
    const b = normalizeForCompare(prev);
    if (!b) continue;
    if (a === b) return true;
    if (a.length >= 6 && b.includes(a)) return true;
    if (b.length >= 6 && a.includes(b)) return true;
    const bTokens = tokenSet(prev);
    if (aTokens.size && bTokens.size) {
      let shared = 0;
      for (const token of aTokens) if (bTokens.has(token)) shared += 1;
      const ratio = shared / Math.min(aTokens.size, bTokens.size);
      if (ratio >= 0.6) return true;
    }
    // 한국어는 한 글자 단어(군·돈·집)가 많아 토큰만으로는 놓친다.
    // 띄어쓰기를 지운 글자 2-gram 겹침이 매우 높으면 같은 문장으로 본다.
    if (bigramOverlap(a, b) >= 0.7) return true;
  }
  return false;
}

/** 지금 저장된 기억 문구 목록(중복 비교용) */
export function existingMemories(limit = 300): string[] {
  const rows = db.prepare('SELECT content FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit) as {
    content: string;
  }[];
  return rows.map((r) => r.content);
}

export function memoryCapReached(): boolean {
  return memoryCount() >= 500;
}
