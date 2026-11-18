import crypto from 'node:crypto';
import { db } from './db';

/**
 * 영구 기억 (v0.5.0)
 *
 * 사용자가 "기억해 줘"라고 하지 않아도, 대화 중 드러난 취향·습관·직업·인물·약속·프로젝트 규칙을
 * AI가 스스로 memory_save로 남긴다. 매 채팅 턴마다 핵심 기억 + 질문 키워드에 맞는 기억을
 * 시스템 프롬프트에 넣어, 대화가 길어지거나 앱을 다시 열어도 기억이 이어진다.
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
}

export interface MemoryView {
  id: string;
  category: MemoryCategory;
  content: string;
  importance: number;
  source: string | null;
  createdAt: string;
  updatedAt: string;
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
  };
}

export function listMemories(category?: string, limit = 200): MemoryView[] {
  const rows = category && category !== 'all'
    ? (db
        .prepare('SELECT * FROM memories WHERE category = ? ORDER BY importance DESC, updated_at DESC LIMIT ?')
        .all(category, limit) as MemoryRow[])
    : (db.prepare('SELECT * FROM memories ORDER BY importance DESC, updated_at DESC LIMIT ?').all(limit) as MemoryRow[]);
  return rows.map(toView);
}

export function memoryCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
  return row.n;
}

export function createMemory(input: {
  content: string;
  category?: unknown;
  importance?: unknown;
  source?: string | null;
}): MemoryView {
  const content = String(input.content || '').trim().slice(0, 800);
  if (!content) throw new Error('기억할 내용이 비어 있습니다.');
  // 같은 내용을 반복 저장하면 새로 만들지 않고 갱신한다(자동 저장이 대화마다 중복되지 않게).
  const existing = db
    .prepare('SELECT * FROM memories WHERE content = ? LIMIT 1')
    .get(content) as MemoryRow | undefined;
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
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO memories(id, category, content, importance, source, created_at, updated_at) VALUES(?,?,?,?,?,?,?)'
  ).run(
    id,
    normalizeCategory(input.category),
    content,
    normalizeImportance(input.importance),
    input.source ? String(input.source).slice(0, 60) : null,
    now,
    now
  );
  return toView(db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow);
}

export function updateMemory(
  id: string,
  patch: { content?: string; category?: unknown; importance?: unknown }
): MemoryView {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  if (!row) throw new Error('기억을 찾을 수 없습니다.');
  db.prepare('UPDATE memories SET content = ?, category = ?, importance = ?, updated_at = ? WHERE id = ?').run(
    patch.content !== undefined ? String(patch.content).trim().slice(0, 800) || row.content : row.content,
    patch.category !== undefined ? normalizeCategory(patch.category, normalizeCategory(row.category)) : row.category,
    patch.importance !== undefined ? normalizeImportance(patch.importance, Number(row.importance) || 2) : row.importance,
    new Date().toISOString(),
    id
  );
  return toView(db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow);
}

export function deleteMemory(id: string): boolean {
  const info = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return info.changes > 0;
}

/** '기억 지워줘: 커피' 처럼 내용으로 지울 때 */
export function deleteMemoriesByText(query: string): number {
  const q = String(query || '').trim();
  if (!q) return 0;
  const info = db.prepare('DELETE FROM memories WHERE content LIKE ?').run(`%${q}%`);
  return info.changes;
}

/** 한국어 조사·기호를 걷어낸 검색 토큰 */
function tokens(text: string): string[] {
  return Array.from(
    new Set(
      String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .map((word) => word.replace(/(은|는|이|가|을|를|의|에|에서|에게|도|와|과|로|으로|만|좀|요|님)$/u, ''))
        .filter((word) => word.length >= 2)
    )
  ).slice(0, 12);
}

/** 키워드로 기억 검색(간단한 LIKE 점수 합산) */
export function searchMemories(query: string, limit = 6): MemoryView[] {
  const words = tokens(query);
  if (!words.length) {
    return listMemories(undefined, limit).slice(0, limit);
  }
  const rows = db.prepare('SELECT * FROM memories LIMIT 800').all() as MemoryRow[];
  const scored = rows
    .map((row) => {
      const hay = `${row.content} ${row.category}`.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (hay.includes(word)) score += word.length >= 3 ? 3 : 2;
      }
      if (score > 0) score += (Number(row.importance) || 2) - 2;
      return { row, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.row.updated_at).getTime() - new Date(a.row.updated_at).getTime())
    .slice(0, limit);
  return scored.map((entry) => toView(entry.row));
}

/** 매 턴 시스템 프롬프트에 넣을 기억 블록. 기억이 없으면 빈 문자열. */
export function memoryPromptBlock(userText: string): string {
  const core = db
    .prepare('SELECT * FROM memories WHERE importance >= 4 ORDER BY importance DESC, updated_at DESC LIMIT 10')
    .all() as MemoryRow[];
  const matched = searchMemories(userText, 6);
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
    ...picked.slice(0, 12).map((m) => `- (${label(m.category)}) ${m.content}`),
    '위 기억은 이전 대화에서 스스로 저장한 것입니다. 사용자가 다시 말하지 않아도 반영하되, 틀렸다면 정정해 달라고 하세요.',
  ].join('\n');
}

/** 기억 검색 결과를 도구 응답용 텍스트로 */
export function formatMemoryList(items: MemoryView[]): string {
  if (!items.length) return '저장된 기억이 없습니다.';
  const label = (c: string) => MEMORY_CATEGORIES.find((x) => x.id === c)?.label || '기타';
  return items
    .map((m) => `- [${label(m.category)} · 중요도 ${m.importance}] ${m.content}`)
    .join('\n');
}
