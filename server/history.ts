import { db } from './db';

/**
 * 과거 대화 전체 검색 (v0.6.0)
 *
 * messages 테이블에 FTS5(trigram) 인덱스를 두고, **지금 방이 아닌 다른 방의
 * 과거 대화까지** 한 번에 찾는다. trigram 토크나이저라 한국어 부분 문자열
 * ("무신" · "신사" 같은 조각)도 걸린다. 3글자 미만 질의는 LIKE로 대신한다.
 */

export interface HistoryHit {
  messageId: number;
  sessionId: string;
  sessionTitle: string;
  role: 'user' | 'assistant' | 'other';
  snippet: string;
  createdAt: string;
}

export interface HistorySearchResult {
  query: string;
  mode: 'fts' | 'like';
  scanned: number;
  hits: HistoryHit[];
  sessionFilter: string | null;
}

function ftsQuery(raw: string): string | null {
  const words = raw
    .replace(/["'*()^:{}[\]]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  if (!words.length) return null;
  // trigram 토크나이저는 3글자 이상 질의를 요구한다 → 짧은 낱말은 LIKE로 보낸다.
  if (words.every((w) => w.length < 3) && raw.trim().length < 3) return null;
  return words
    .filter((w) => w.length >= 3)
    .map((w) => `"${w.replace(/"/g, '')}"`)
    .join(' AND ');
}

function cleanSnippet(text: string): string {
  return String(text || '')
    .replace(/<b>|<\/b>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

/**
 * 대화 검색.
 * @param query 사용자가 말한 검색어 (예: "무신사 로그인")
 * @param options.session 특정 방만 (없으면 전체 방)
 * @param options.excludeSession 지금 대화방 제외
 */
export function searchChatHistory(
  query: string,
  options: { session?: string | null; excludeSession?: string | null; limit?: number } = {}
): HistorySearchResult {
  const text = String(query || '').trim();
  const limit = Math.min(30, Math.max(1, options.limit || 8));
  const sessionFilter = options.session ? String(options.session) : null;
  const exclude = options.excludeSession ? String(options.excludeSession) : null;
  if (!text) return { query: text, mode: 'fts', scanned: 0, hits: [], sessionFilter };

  const titles = new Map<string, string>();
  for (const row of db.prepare('SELECT id, title FROM chat_sessions').all() as { id: string; title: string }[]) {
    titles.set(row.id, row.title);
  }
  const toRole = (role: string): HistoryHit['role'] => (role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'other');

  const match = ftsQuery(text);
  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT message_id, session_id, role, created_at,
                  snippet(messages_fts, 0, '<b>', '</b>', '…', 14) AS snip
             FROM messages_fts
            WHERE messages_fts MATCH ?
              AND (? IS NULL OR session_id = ?)
              AND (? IS NULL OR session_id <> ?)
            ORDER BY rank
            LIMIT ?`
        )
        .all(match, sessionFilter, sessionFilter, exclude, exclude, limit) as {
        message_id: number;
        session_id: string;
        role: string;
        created_at: string;
        snip: string;
      }[];
      if (rows.length) {
        return {
          query: text,
          mode: 'fts',
          scanned: rows.length,
          sessionFilter,
          hits: rows.map((r) => ({
            messageId: Number(r.message_id),
            sessionId: r.session_id,
            sessionTitle: titles.get(r.session_id) || r.session_id,
            role: toRole(r.role),
            snippet: cleanSnippet(r.snip),
            createdAt: r.created_at,
          })),
        };
      }
    } catch {
      /* 인덱스 문제 시 LIKE 로 폴백 */
    }
  }

  // 폴백: 짧은 질의·인덱스 없음 → 부분 문자열 LIKE
  const like = `%${text.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT id, session_id, role, created_at, substr(content, 1, 320) AS snip
         FROM messages
        WHERE content LIKE ? ESCAPE '\\'
          AND (? IS NULL OR session_id = ?)
          AND (? IS NULL OR session_id <> ?)
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(like, sessionFilter, sessionFilter, exclude, exclude, limit) as {
    id: number;
    session_id: string;
    role: string;
    created_at: string;
    snip: string;
  }[];
  return {
    query: text,
    mode: 'like',
    scanned: rows.length,
    sessionFilter,
    hits: rows.map((r) => ({
      messageId: Number(r.id),
      sessionId: r.session_id,
      sessionTitle: titles.get(r.session_id) || r.session_id,
      role: toRole(r.role),
      snippet: cleanSnippet(r.snip),
      createdAt: r.created_at,
    })),
  };
}

/** 모델에게 돌려줄 형태 (근거가 된 대화를 방 이름·시각과 함께 보여 준다) */
export function formatHistory(result: HistorySearchResult): string {
  if (!result.hits.length) {
    return `'${result.query}'로 과거 대화를 찾지 못했습니다. 다른 낱말(사이트 이름·사람 이름·핵심 단어)로 다시 찾아보거나, 사용자에게 언제쯤의 대화인지 물어보세요.`;
  }
  const stamp = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const lines = result.hits.map((hit, i) => {
    const who = hit.role === 'user' ? '사용자' : hit.role === 'assistant' ? 'AI' : '시스템';
    return `${i + 1}. [${hit.sessionTitle}] ${stamp(hit.createdAt)} · ${who}: ${hit.snippet}`;
  });
  return [
    `과거 대화에서 ${result.hits.length}건을 찾았습니다(방 ${new Set(result.hits.map((h) => h.sessionId)).size}곳).`,
    ...lines,
    '',
    '※ 위 내용은 과거 대화의 기록입니다. 지금 사용자의 말과 다르면 지금 말을 따르세요.',
  ].join('\n');
}

/** 인덱스 상태(설정·감시 화면 표시용) */
export function historyIndexStats(): { messages: number; indexed: number } {
  const messages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const indexed = (db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as { n: number }).n;
  return { messages, indexed };
}

/** 수동 재색인(관리용) */
export function reindexHistory(): number {
  db.exec('DELETE FROM messages_fts');
  db.exec(`
    INSERT INTO messages_fts(rowid, content, session_id, message_id, role, created_at)
    SELECT id, content, session_id, id, role, created_at FROM messages
  `);
  return historyIndexStats().indexed;
}
