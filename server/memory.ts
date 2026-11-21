import crypto from 'node:crypto';
import { db } from './db';

/**
 * 영구 기억 (v0.5.0 → v0.7.1 하이브리드 검색·최신화)
 *
 * 사용자가 "기억해 줘"라고 하지 않아도, 대화 중 드러난 취향·습관·직업·인물·약속·프로젝트 규칙을
 * AI가 스스로 memory_save로 남긴다. 매 채팅 턴마다 핵심 기억 + 질문에 가장 관련 높은 기억을
 * 시스템 프롬프트에 넣어, 대화가 길어지거나 앱을 다시 열어도 기억이 이어진다.
 *
 * v0.7.1 에서 세 가지가 더해졌다.
 *   ① 하이브리드 점수 — 키워드(BM25) + 글자 n-gram 코사인 + 최신성(시간 감쇠) + 중요도
 *   ② 최신화 — 같은 주제의 새 기억이 들어오면 옛 기억을 superseded_by 로 가리킨다(행은 보존)
 *   ③ 중요 고정(pinned) — 사용자가 고정한 기억은 매 대화 프롬프트에 항상 들어간다
 */

export type MemoryCategory = 'profile' | 'taste' | 'habit' | 'person' | 'promise' | 'project' | 'rule' | 'other';

export const MEMORY_CATEGORIES: { id: MemoryCategory; label: string }[] = [
  { id: 'profile', label: '나에 대해' },
  { id: 'taste', label: '취향' },
  { id: 'habit', label: '습관·일과' },
  { id: 'person', label: '사람' },
  { id: 'promise', label: '약속·일정' },
  { id: 'project', label: '프로젝트' },
  { id: 'rule', label: '규칙·지침' },
  { id: 'other', label: '기타' },
];

const CATEGORY_IDS = MEMORY_CATEGORIES.map((c) => c.id) as string[];

export function normalizeCategory(value: unknown, fallback: MemoryCategory = 'other'): MemoryCategory {
  return CATEGORY_IDS.includes(String(value)) ? (String(value) as MemoryCategory) : fallback;
}

export function normalizeImportance(value: unknown, fallback = 2): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

interface MemoryRow {
  id: string;
  category: string;
  content: string;
  importance: number;
  source: string | null;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  pinned: number | null;
  tags_json: string | null;
}

export interface MemoryView {
  id: string;
  category: MemoryCategory;
  content: string;
  importance: number;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  /** 이 기억을 대신하는 최신 기억 id (있으면 '이전 버전') */
  supersededBy: string | null;
  /** 사용자가 중요 고정한 기억 */
  pinned: boolean;
  tags: string[];
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((tag) => String(tag)).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

function toView(row: MemoryRow): MemoryView {
  return {
    id: row.id,
    category: normalizeCategory(row.category),
    content: row.content,
    importance: Number(row.importance) || 2,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supersededBy: row.superseded_by || null,
    pinned: Boolean(row.pinned),
    tags: parseTags(row.tags_json),
  };
}

/* ------------------------------------------------------------------ */
/* 텍스트 처리 (한국어·영문)                                            */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  '그리고', '그러면', '그래서', '합니다', '입니다', '있습니다', '없습니다', '같아요', '좋아', '싶어', '한다', '했다',
  '하는', '에서', '으로', '에게', '부터', '까지', '보다', '처럼', '정도', '때문', '이런', '그런', '저런', 'the', 'and',
  'for', 'with', 'that', 'this', 'from', 'have', 'has',
]);

/** 비교용 글자 형태: 소문자, 문장부호 제거, 공백 정리 */
export function normalizeText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PARTICLE_RE = /(은|는|이|가|을|를|의|에|에서|에게|도|와|과|로|으로|만|좀|요|님|으로는|에서는)$/u;

/** 낱말 토큰 — 조사를 떼고 2글자 이상만 */
function wordTokens(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .map((word) => word.replace(PARTICLE_RE, ''))
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
}

/** 검색용 토큰 = 낱말 + 한글 두 글자 묶음(어미·조사 차이 흡수) */
function searchTokens(text: string): string[] {
  const out = new Set<string>();
  for (const word of wordTokens(text)) {
    out.add(word);
    if (/[가-힣]/.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) out.add(word.slice(i, i + 2));
    }
  }
  return [...out];
}

/** 글자 2-gram 집합 (코사인 유사도용) */
function bigramSet(text: string): Map<string, number> {
  const compact = normalizeText(text).replace(/\s+/g, '');
  const map = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i += 1) {
    const gram = compact.slice(i, i + 2);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

/** 글자 2-gram 코사인 유사도 0~1 */
export function textSimilarity(a: string, b: string): number {
  const ga = bigramSet(a);
  const gb = bigramSet(b);
  if (!ga.size || !gb.size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const count of ga.values()) na += count * count;
  for (const count of gb.values()) nb += count * count;
  for (const [gram, count] of ga) {
    const other = gb.get(gram);
    if (other) dot += count * other;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 기억 태그 — 본문에서 긴 낱말 위주로 4개 */
export function deriveTags(content: string, category?: string): string[] {
  const counts = new Map<string, number>();
  for (const word of wordTokens(content)) counts.set(word, (counts.get(word) || 0) + 1);
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([word]) => word)
    .filter((word) => word.length >= 2)
    .slice(0, 4);
  if (category) {
    const label = MEMORY_CATEGORIES.find((item) => item.id === category)?.label;
    if (label && !tags.includes(label)) tags.push(label);
  }
  return tags.slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* 읽기                                                                */
/* ------------------------------------------------------------------ */

const ACTIVE = '(superseded_by IS NULL OR superseded_by = \'\')';

export function listMemories(category?: string, limit = 200, options: { includeSuperseded?: boolean } = {}): MemoryView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (category && category !== 'all') {
    where.push('category = ?');
    params.push(category);
  }
  if (!options.includeSuperseded) where.push(ACTIVE);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  const rows = db
    .prepare(`SELECT * FROM memories ${clause} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`)
    .all(...params) as MemoryRow[];
  return rows.map(toView);
}

export function getMemory(id: string): MemoryView | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id || '')) as MemoryRow | undefined;
  return row ? toView(row) : null;
}

export function memoryCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${ACTIVE}`).get() as { n: number };
  return row.n;
}

export function supersededCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE superseded_by IS NOT NULL AND superseded_by != ''").get() as {
    n: number;
  };
  return row.n;
}

/* ------------------------------------------------------------------ */
/* 하이브리드 점수                                                      */
/* ------------------------------------------------------------------ */

export interface MemoryScoreParts {
  keyword: number;
  similarity: number;
  recency: number;
  importance: number;
  pinned: number;
}

export interface RankedMemory {
  memory: MemoryView;
  score: number;
  parts: MemoryScoreParts;
}

/** 최신성 감쇠 반감기(일) — 3주 지나면 무게가 절반 */
const RECENCY_HALF_LIFE_DAYS = 21;

function recencyScore(updatedAt: string, now = Date.now()): number {
  const at = new Date(updatedAt).getTime();
  if (!Number.isFinite(at)) return 0.5;
  const days = Math.max(0, (now - at) / 86_400_000);
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

/**
 * BM25 (k1=1.5, b=0.75) — 문서 집합이 작아도 안정적으로 동작한다.
 * 한국어는 낱말 + 두 글자 묶음을 함께 토큰으로 써서 조사·어미 차이를 흡수한다.
 */
export function bm25Scores(
  query: string,
  docs: { id: string; text: string }[]
): Map<string, number> {
  const scores = new Map<string, number>();
  const qTokens = searchTokens(query);
  if (!qTokens.length || !docs.length) return scores;
  const tokenized = docs.map((doc) => ({ id: doc.id, tokens: searchTokens(doc.text) }));
  const lengths = tokenized.map((doc) => doc.tokens.length || 1);
  const avgdl = lengths.reduce((sum, len) => sum + len, 0) / lengths.length || 1;
  const df = new Map<string, number>();
  for (const doc of tokenized) {
    for (const token of new Set(doc.tokens)) df.set(token, (df.get(token) || 0) + 1);
  }
  const total = tokenized.length;
  const k1 = 1.5;
  const b = 0.75;
  for (const doc of tokenized) {
    const freq = new Map<string, number>();
    for (const token of doc.tokens) freq.set(token, (freq.get(token) || 0) + 1);
    const len = doc.tokens.length || 1;
    let score = 0;
    for (const token of qTokens) {
      const tf = freq.get(token) || 0;
      if (!tf) continue;
      const docsWith = df.get(token) || 0;
      const idf = Math.log(1 + (total - docsWith + 0.5) / (docsWith + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgdl)));
    }
    if (score > 0) scores.set(doc.id, score);
  }
  return scores;
}

/** BM25 값을 0~1 로 부드럽게 눌러 다른 항목과 더할 수 있게 한다. */
function squash(value: number, scale = 2.4): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / (value + scale);
}

/** 가중치 — 키워드가 가장 크고, 유사도·최신성·중요도를 더한다. */
export const HYBRID_WEIGHTS = {
  keyword: 0.46,
  similarity: 0.18,
  recency: 0.18,
  importance: 0.18,
} as const;

/**
 * 대화 맥락에 가장 관련 높은 기억을 고른다.
 * 반환값은 점수 내림차순이며, parts 로 왜 골랐는지 함께 준다(관제·디버깅용).
 */
export function rankMemories(query: string, limit = 6, options: { includeSuperseded?: boolean } = {}): RankedMemory[] {
  const q = String(query || '').trim();
  const rows = db
    .prepare(
      `SELECT * FROM memories ${options.includeSuperseded ? '' : `WHERE ${ACTIVE}`} ORDER BY updated_at DESC LIMIT 800`
    )
    .all() as MemoryRow[];
  if (!rows.length) return [];
  const now = Date.now();
  if (!q) {
    return rows
      .map((row) => toView(row))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance)
      .slice(0, limit)
      .map((memory) => ({
        memory,
        score: 0,
        parts: { keyword: 0, similarity: 0, recency: recencyScore(memory.updatedAt, now), importance: memory.importance / 5, pinned: memory.pinned ? 1 : 0 },
      }));
  }
  const bm25 = bm25Scores(
    q,
    rows.map((row) => ({ id: row.id, text: `${row.content} ${parseTags(row.tags_json).join(' ')}` }))
  );
  const ranked: RankedMemory[] = [];
  for (const row of rows) {
    const memory = toView(row);
    const keyword = squash(bm25.get(row.id) || 0);
    const similarity = textSimilarity(q, row.content);
    const recency = recencyScore(row.updated_at, now);
    const importance = (Number(row.importance) || 2) / 5;
    const pinned = Boolean(row.pinned);
    const score =
      HYBRID_WEIGHTS.keyword * keyword +
      HYBRID_WEIGHTS.similarity * similarity +
      HYBRID_WEIGHTS.recency * recency +
      HYBRID_WEIGHTS.importance * importance +
      (pinned ? 0.12 : 0);
    if (score < 0.12) continue;
    ranked.push({ memory, score, parts: { keyword, similarity, recency, importance, pinned: pinned ? 1 : 0 } });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 키워드로 기억 검색(하이브리드 점수) */
export function searchMemories(query: string, limit = 6): MemoryView[] {
  const q = String(query || '').trim();
  if (!q) return listMemories(undefined, limit);
  return rankMemories(q, limit).map((item) => item.memory);
}

/* ------------------------------------------------------------------ */
/* 저장 · 최신화                                                        */
/* ------------------------------------------------------------------ */

function exactMatch(content: string): MemoryRow | undefined {
  return db.prepare('SELECT * FROM memories WHERE content = ? LIMIT 1').get(content) as MemoryRow | undefined;
}

/** 같은 분류에서 가장 비슷한 기억(자기 자신 제외) */
function closestInCategory(content: string, category: string, excludeId?: string): { row: MemoryRow; similarity: number } | null {
  const rows = db
    .prepare(`SELECT * FROM memories WHERE category = ? AND ${ACTIVE} ORDER BY updated_at DESC LIMIT 200`)
    .all(category) as MemoryRow[];
  let best: { row: MemoryRow; similarity: number } | null = null;
  for (const row of rows) {
    if (row.id === excludeId) continue;
    const similarity = textSimilarity(content, row.content);
    if (!best || similarity > best.similarity) best = { row, similarity };
  }
  return best;
}

/** 이전 기억을 '대체됨'으로 표시한다(행은 지우지 않는다 — 무손실). */
function markSuperseded(oldId: string, newId: string): void {
  db.prepare('UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ? AND (superseded_by IS NULL OR superseded_by = \'\')').run(
    newId,
    new Date().toISOString(),
    oldId
  );
}

/** 같은 주제로 거의 같은 문장인지 — 이 값 이상이면 병합·대체 대상 */
export const SUPERSEDE_SIMILARITY = 0.85;

export function createMemory(input: {
  content: string;
  category?: unknown;
  importance?: unknown;
  source?: string | null;
}): MemoryView {
  const content = String(input.content || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!content) throw new Error('기억할 내용이 비어 있습니다.');
  // 같은 내용을 반복 저장하면 새로 만들지 않고 갱신한다(자동 저장이 대화마다 중복되지 않게).
  const existing = exactMatch(content);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare('UPDATE memories SET category = ?, importance = ?, source = ?, updated_at = ? WHERE id = ?').run(
      normalizeCategory(input.category, normalizeCategory(existing.category)),
      normalizeImportance(input.importance, Number(existing.importance) || 2),
      input.source ? String(input.source).slice(0, 60) : existing.source,
      now,
      existing.id
    );
    return toView(db.prepare('SELECT * FROM memories WHERE id = ?').get(existing.id) as MemoryRow);
  }

  const category = normalizeCategory(input.category);
  const id = crypto.randomUUID();
  // v0.7.1: 같은 분류에 거의 같은 기억이 있으면 옛 기억을 '이전 버전'으로 표시한다.
  const closest = closestInCategory(content, category);
  const importance =
    closest && closest.similarity >= SUPERSEDE_SIMILARITY
      ? Math.max(normalizeImportance(input.importance), Number(closest.row.importance) || 2)
      : normalizeImportance(input.importance);
  db.prepare(
    'INSERT INTO memories(id, category, content, importance, source, created_at, updated_at, superseded_by, pinned, tags_json) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(
    id,
    category,
    content,
    importance,
    input.source ? String(input.source).slice(0, 60) : null,
    now,
    now,
    null,
    0,
    JSON.stringify(deriveTags(content, category))
  );
  if (closest && closest.similarity >= SUPERSEDE_SIMILARITY) markSuperseded(closest.row.id, id);
  return toView(db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow);
}

export function updateMemory(
  id: string,
  patch: { content?: string; category?: unknown; importance?: unknown; pinned?: unknown; tags?: unknown }
): MemoryView {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  if (!row) throw new Error('기억을 찾을 수 없습니다.');
  const content = patch.content !== undefined ? String(patch.content).replace(/\s+/g, ' ').trim().slice(0, 800) || row.content : row.content;
  const category = patch.category !== undefined ? normalizeCategory(patch.category, normalizeCategory(row.category)) : row.category;
  const importance = patch.importance !== undefined ? normalizeImportance(patch.importance, Number(row.importance) || 2) : row.importance;
  const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : row.pinned || 0;
  const tags =
    Array.isArray(patch.tags) && patch.tags.length
      ? patch.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8)
      : content !== row.content
        ? deriveTags(content, category)
        : parseTags(row.tags_json);
  db.prepare('UPDATE memories SET content = ?, category = ?, importance = ?, pinned = ?, tags_json = ?, updated_at = ? WHERE id = ?').run(
    content,
    category,
    importance,
    pinned,
    JSON.stringify(tags),
    new Date().toISOString(),
    id
  );
  return toView(db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow);
}

export function setMemoryPinned(id: string, pinned: boolean): MemoryView {
  return updateMemory(id, { pinned });
}

/** '이전 버전' 표시를 되돌린다(잘못 대체됐을 때). */
export function restoreMemory(id: string): MemoryView {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  if (!row) throw new Error('기억을 찾을 수 없습니다.');
  db.prepare('UPDATE memories SET superseded_by = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return toView(db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow);
}

export function deleteMemory(id: string): boolean {
  const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  // 이 기억을 가리키던 '이전 버전' 표시도 함께 푼다(없는 기억을 가리키지 않게).
  db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?').run(id);
  db.prepare('DELETE FROM memory_links WHERE a_id = ? OR b_id = ?').run(id, id);
  return info.changes > 0;
}

/** '기억 지워줘: 커피' 처럼 내용으로 지울 때 */
export function deleteMemoriesByText(query: string): number {
  const q = String(query || '').trim();
  if (!q) return 0;
  const rows = db.prepare('SELECT id FROM memories WHERE content LIKE ?').all(`%${q}%`) as { id: string }[];
  let removed = 0;
  for (const row of rows) if (deleteMemory(row.id)) removed += 1;
  return removed;
}

/**
 * 중복·구버전 정리(수동/자동).
 * 같은 분류에서 문장이 거의 같으면 오래된 쪽만 '이전 버전'으로 표시한다.
 * 행을 지우지 않으므로 언제든 복원할 수 있다.
 */
export function consolidateMemories(options: { threshold?: number } = {}): {
  superseded: number;
  groups: { keep: string; replaced: string[] }[];
} {
  const threshold = options.threshold ?? 0.9;
  const rows = db.prepare(`SELECT * FROM memories WHERE ${ACTIVE} ORDER BY category, updated_at ASC`).all() as MemoryRow[];
  const byCategory = new Map<string, MemoryRow[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) || [];
    list.push(row);
    byCategory.set(row.category, list);
  }
  let superseded = 0;
  const groups: { keep: string; replaced: string[] }[] = [];
  for (const list of byCategory.values()) {
    const replaced = new Set<string>();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const newer = list[i];
      if (replaced.has(newer.id)) continue;
      const older: string[] = [];
      for (let j = i - 1; j >= 0; j -= 1) {
        const candidate = list[j];
        if (replaced.has(candidate.id)) continue;
        if (textSimilarity(newer.content, candidate.content) >= threshold) {
          markSuperseded(candidate.id, newer.id);
          replaced.add(candidate.id);
          older.push(candidate.id);
          superseded += 1;
        }
      }
      if (older.length) groups.push({ keep: newer.id, replaced: older });
    }
  }
  return { superseded, groups };
}

/** 매 턴 시스템 프롬프트에 넣을 기억 블록. 기억이 없으면 빈 문자열. */
export function memoryPromptBlock(userText: string): string {
  const core = db
    .prepare(
      `SELECT * FROM memories WHERE ${ACTIVE} AND (pinned = 1 OR importance >= 4) ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 8`
    )
    .all() as MemoryRow[];
  const matched = rankMemories(userText, 8)
    .filter((item) => item.score >= 0.2)
    .map((item) => item.memory);
  const seen = new Set<string>();
  const picked: MemoryView[] = [];
  for (const item of [...core.map(toView), ...matched]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    picked.push(item);
  }
  if (!picked.length) return '';
  const label = (c: string) => MEMORY_CATEGORIES.find((x) => x.id === c)?.label || '기타';
  return [
    '[저장된 기억 — 사용자에 대해 이미 알고 있는 것]',
    ...picked.slice(0, 12).map((m) => `- (${label(m.category)}${m.pinned ? ' · 고정' : ''}) ${m.content}`),
    '위 기억은 이전 대화에서 스스로 저장한 것입니다. 사용자가 다시 말하지 않아도 반영하되, 틀렸다면 정정해 달라고 하세요. 같은 주제의 최신 내용이 있으면 최신 것을 따르세요.',
  ].join('\n');
}

/** 기억 검색 결과를 도구 응답용 텍스트로 */
export function formatMemoryList(items: MemoryView[]): string {
  if (!items.length) return '저장된 기억이 없습니다.';
  const label = (c: string) => MEMORY_CATEGORIES.find((x) => x.id === c)?.label || '기타';
  return items
    .map((m) => `- [${label(m.category)} · 중요도 ${m.importance}${m.pinned ? ' · 고정' : ''}] ${m.content}`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* 기억 그래프 (v0.7.1)                                                */
/* ------------------------------------------------------------------ */

export interface MemoryGraphNode {
  id: string;
  kind: 'me' | 'category' | 'memory';
  label: string;
  category?: MemoryCategory;
  content?: string;
  importance?: number;
  pinned?: boolean;
  count?: number;
  updatedAt?: string;
}

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'contains' | 'similar' | 'link';
  weight: number;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  counts: { memories: number; categories: number; links: number; superseded: number };
}

/** 두 기억을 잇는다(방향 없음). */
export function linkMemories(a: string, b: string): boolean {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right || left === right) return false;
  const [x, y] = left < right ? [left, right] : [right, left];
  const exists = db.prepare('SELECT 1 AS ok FROM memories WHERE id IN (?, ?)').all(x, y) as { ok: number }[];
  if (exists.length < 2) return false;
  db.prepare('INSERT OR IGNORE INTO memory_links(a_id, b_id, created_at) VALUES(?,?,?)').run(x, y, new Date().toISOString());
  return true;
}

export function unlinkMemories(a: string, b: string): boolean {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return false;
  const [x, y] = left < right ? [left, right] : [right, left];
  const info = db.prepare('DELETE FROM memory_links WHERE a_id = ? AND b_id = ?').run(x, y);
  return info.changes > 0;
}

export function listLinks(): { a: string; b: string }[] {
  return db.prepare('SELECT a_id AS a, b_id AS b FROM memory_links').all() as { a: string; b: string }[];
}

/**
 * 그래프 데이터 — 나(Me) → 분류 → 기억, 그리고 기억끼리의 유사·수동 연결.
 * 기억이 적어도 깨지지 않는다(빈 그래프는 counts 0 + 나 노드만).
 */
export function buildMemoryGraph(options: { limit?: number; category?: string } = {}): MemoryGraph {
  const limit = Math.min(400, Math.max(20, options.limit || 200));
  const rows = db.prepare(`SELECT * FROM memories WHERE ${ACTIVE} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`).all(
    limit
  ) as MemoryRow[];
  const memories = rows.map(toView).filter((item) => !options.category || options.category === 'all' || item.category === options.category);
  const nodes: MemoryGraphNode[] = [{ id: 'me', kind: 'me', label: '나' }];
  const edges: MemoryGraphEdge[] = [];
  const perCategory = new Map<string, MemoryView[]>();
  for (const memory of memories) {
    const list = perCategory.get(memory.category) || [];
    list.push(memory);
    perCategory.set(memory.category, list);
  }
  for (const category of MEMORY_CATEGORIES) {
    const list = perCategory.get(category.id) || [];
    if (!list.length) continue;
    const nodeId = `cat:${category.id}`;
    nodes.push({ id: nodeId, kind: 'category', label: category.label, category: category.id, count: list.length });
    edges.push({ id: `e:me:${nodeId}`, source: 'me', target: nodeId, kind: 'contains', weight: Math.min(1, 0.35 + list.length / 12) });
    for (const memory of list) {
      nodes.push({
        id: memory.id,
        kind: 'memory',
        label: memory.content.length > 46 ? `${memory.content.slice(0, 46)}…` : memory.content,
        category: memory.category,
        content: memory.content,
        importance: memory.importance,
        pinned: memory.pinned,
        count: 1,
        updatedAt: memory.updatedAt,
      });
      edges.push({
        id: `e:${nodeId}:${memory.id}`,
        source: nodeId,
        target: memory.id,
        kind: 'contains',
        weight: 0.3 + (memory.importance / 5) * 0.4,
      });
    }
  }
  // 수동 연결을 먼저 넣는다(사용자가 직접 이은 선이 '유사'보다 우선 보인다).
  const linked = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const links = listLinks();
  const known = new Set(memories.map((memory) => memory.id));
  for (const link of links) {
    if (!known.has(link.a) || !known.has(link.b)) continue;
    const key = pairKey(link.a, link.b);
    if (linked.has(key)) continue;
    linked.add(key);
    edges.push({ id: `e:link:${key}`, source: link.a, target: link.b, kind: 'link', weight: 1 });
  }
  // 기억끼리 유사 연결 — 노드마다 가장 비슷한 2개까지(그래프가 뭉개지지 않게)
  for (let i = 0; i < memories.length; i += 1) {
    const near: { id: string; similarity: number }[] = [];
    for (let j = 0; j < memories.length; j += 1) {
      if (i === j) continue;
      if (memories[i].category !== memories[j].category) continue;
      const similarity = textSimilarity(memories[i].content, memories[j].content);
      if (similarity >= 0.55) near.push({ id: memories[j].id, similarity });
    }
    near.sort((a, b) => b.similarity - a.similarity);
    for (const item of near.slice(0, 2)) {
      const key = pairKey(memories[i].id, item.id);
      if (linked.has(key)) continue;
      linked.add(key);
      edges.push({ id: `e:sim:${key}`, source: memories[i].id, target: item.id, kind: 'similar', weight: item.similarity });
    }
  }
  return {
    nodes,
    edges,
    counts: { memories: memories.length, categories: perCategory.size, links: links.length, superseded: supersededCount() },
  };
}
