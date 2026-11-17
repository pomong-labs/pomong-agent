import crypto from 'node:crypto';
import { db } from './db';
import { currentStats } from './system';
import * as vault from './vault';
import type { ToolSpec } from './providers';

export type TaskPriority = 'high' | 'normal' | 'low';

export interface TaskRow {
  id: string;
  title: string;
  done: number;
  due: string | null;
  priority: string;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface TaskView {
  id: string;
  title: string;
  done: boolean;
  due: string | null;
  priority: TaskPriority;
  notes: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export function normalizePriority(value: unknown): TaskPriority {
  return value === 'high' || value === 'low' ? value : 'normal';
}

/** 'YYYY-MM-DD' · 'YYYY-MM-DDTHH:mm' · 'HH:mm' 형태만 저장한다. */
export function normalizeDue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) return text.replace(' ', 'T').slice(0, 16);
  if (/^\d{2}:\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const hasTime = /[T:]\d{2}:\d{2}/.test(text) || /오전|오후/.test(text);
    const date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
    return hasTime ? `${date}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}` : date;
  }
  return null;
}

export function toTaskView(row: TaskRow): TaskView {
  return {
    id: row.id,
    title: row.title,
    done: Boolean(row.done),
    due: row.due,
    priority: normalizePriority(row.priority),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTaskRows(limit = 200): TaskRow[] {
  return db
    .prepare(
      `SELECT id, title, done, due, priority, notes, created_at, updated_at FROM tasks
       ORDER BY done ASC,
         CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC,
         CASE WHEN due IS NULL OR due = '' THEN 1 ELSE 0 END ASC,
         due ASC, created_at DESC
       LIMIT ?`
    )
    .all(limit) as TaskRow[];
}

export function openTaskRows(limit = 12): TaskRow[] {
  return db
    .prepare(
      `SELECT id, title, done, due, priority, notes, created_at, updated_at FROM tasks
       WHERE done = 0
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC,
                CASE WHEN due IS NULL OR due = '' THEN 1 ELSE 0 END ASC,
                due ASC, created_at DESC
       LIMIT ?`
    )
    .all(limit) as TaskRow[];
}

export function createTask(input: { title: string; due?: unknown; priority?: unknown; notes?: unknown }): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO tasks(id, title, done, due, priority, notes, created_at, updated_at) VALUES(?,?,0,?,?,?,?,?)'
  ).run(
    id,
    input.title.trim().slice(0, 160),
    normalizeDue(input.due),
    normalizePriority(input.priority),
    input.notes ? String(input.notes).slice(0, 800) : null,
    now,
    now
  );
  return id;
}

export function dueLabel(due: string | null): string {
  if (!due) return '';
  const time = /T(\d{2}:\d{2})/.exec(due)?.[1];
  const datePart = due.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!m) return due;
  const label = `${Number(m[2])}월 ${Number(m[3])}일`;
  return time ? `${label} ${time}` : label;
}

export function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const stamp = due.includes('T') ? new Date(due) : new Date(`${due}T23:59`);
  if (Number.isNaN(stamp.getTime())) return false;
  return stamp.getTime() < Date.now();
}

/* ------------------------------------------------------------------ */
/* Tool registry                                                       */
/* ------------------------------------------------------------------ */

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'tasks_list',
    description: '할 일 목록을 조회한다. 사용자가 오늘 할 일·남은 일·완료한 일을 물으면 사용한다.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'], description: 'open=진행 중(기본), done=완료, all=전체' },
      },
    },
  },
  {
    name: 'tasks_add',
    description: '새 할 일을 추가한다. 사용자가 "우유 사기 추가해줘"처럼 할 일 등록을 요청하면 사용한다.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '할 일 내용' },
        due: { type: 'string', description: '마감 (YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm). 없으면 생략' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '우선순위 (기본 normal)' },
        notes: { type: 'string', description: '메모 (선택)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'tasks_complete',
    description: '할 일을 완료 처리한다. 사용자가 "그거 다 했어"처럼 완료를 알리면 제목 일부로 찾아 완료한다.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '완료할 할 일 제목의 일부' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_list',
    description:
      '금고에 저장된 항목의 이름과 종류만 조회한다. 실제 비밀값은 절대 조회되지 않으므로 값을 알려 달라는 요청에는 "금고에서 직접 확인" 안내만 한다.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어 (선택)' },
      },
    },
  },
  {
    name: 'server_stats',
    description: '현재 서버의 CPU·RAM·디스크·부하·가동 시간을 조회한다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'time_now',
    description: '현재 날짜와 시각(Asia/Seoul)을 조회한다. 날짜 계산이 필요할 때 사용한다.',
    parameters: { type: 'object', properties: {} },
  },
];

export interface ToolResult {
  content: string;
  meta?: 'tasks' | 'server_stats';
}

function taskLine(row: TaskRow): string {
  const mark = row.done ? '[완료]' : '[할 일]';
  const priority = normalizePriority(row.priority);
  const prio = priority === 'high' ? ' (우선순위 높음)' : priority === 'low' ? ' (우선순위 낮음)' : '';
  const due = row.due ? ` · 마감 ${dueLabel(row.due)}` : '';
  const overdue = !row.done && isOverdue(row.due) ? ' · 기한 지남!' : '';
  return `${mark} ${row.title}${prio}${due}${overdue}`;
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'tasks_list': {
      const status = String(args.status || 'open');
      const rows = listTaskRows(60).filter((r) =>
        status === 'all' ? true : status === 'done' ? Boolean(r.done) : !r.done
      );
      if (!rows.length) {
        return { content: status === 'done' ? '완료된 할 일이 없습니다.' : '진행 중인 할 일이 없습니다.', meta: 'tasks' };
      }
      return { content: `할 일 ${rows.length}개:\n${rows.slice(0, 20).map(taskLine).join('\n')}`, meta: 'tasks' };
    }
    case 'tasks_add': {
      const title = String(args.title || '').trim();
      if (!title) return { content: '할 일 내용이 비어 있어 추가하지 못했습니다.' };
      const id = createTask({ title, due: args.due, priority: args.priority, notes: args.notes });
      const row = db.prepare('SELECT id, title, done, due, priority, notes, created_at, updated_at FROM tasks WHERE id = ?').get(id) as TaskRow;
      return { content: `할 일을 추가했습니다: ${taskLine(row)}`, meta: 'tasks' };
    }
    case 'tasks_complete': {
      const query = String(args.query || '').trim().toLowerCase();
      if (!query) return { content: '어떤 할 일을 완료할지 알려주세요.' };
      const rows = db
        .prepare("SELECT id, title, done, due, priority, notes, created_at, updated_at FROM tasks WHERE done = 0 AND lower(title) LIKE ? ORDER BY created_at DESC LIMIT 5")
        .all(`%${query}%`) as TaskRow[];
      if (!rows.length) return { content: `'${query}'와 맞는 진행 중인 할 일을 찾지 못했습니다.`, meta: 'tasks' };
      db.prepare('UPDATE tasks SET done = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), rows[0].id);
      return { content: `완료 처리했습니다: ${rows[0].title}`, meta: 'tasks' };
    }
    case 'vault_list': {
      let items: { title: string; type: string; hint: string; updatedAt: string }[];
      try {
        items = vault.listItems(String(args.query || '')).map((i) => ({
          title: i.title,
          type: i.type,
          hint: i.hint,
          updatedAt: i.updatedAt,
        }));
      } catch {
        return { content: '금고가 잠겨 있어 목록을 볼 수 없습니다. 금고 탭에서 PIN으로 잠금을 해제한 뒤 다시 요청해 주세요.' };
      }
      if (!items.length) return { content: '금고에 저장된 항목이 없습니다.' };
      const label = (t: string) => (t === 'apikey' ? 'API 키' : t === 'login' ? '로그인' : '메모');
      return {
        content: `금고 항목 ${items.length}개 (비밀값은 표시하지 않음):\n${items
          .slice(0, 20)
          .map((i) => `- ${i.title} (${label(i.type)})`)
          .join('\n')}`,
      };
    }
    case 'server_stats': {
      const s = currentStats();
      return {
        content: [
          `서버 ${s.hostname} (${s.osName})`,
          `CPU ${s.cpu}% · RAM ${s.ram}% (${s.ramUsedGB}/${s.ramTotalGB}GB) · 디스크 ${s.disk}% (${s.diskUsedGB}/${s.diskTotalGB}GB)`,
          `코어 ${s.cores}개 · 부하 ${s.load1}/${s.load5}/${s.load15} · 가동 ${Math.floor(s.uptimeSec / 3600)}시간`,
          `상태: ${s.status}`,
        ].join('\n'),
        meta: 'server_stats',
      };
    }
    case 'time_now': {
      const now = new Date();
      const label = now.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
      });
      return { content: `${label} (Asia/Seoul, ${now.toISOString()})` };
    }
    default:
      return { content: `알 수 없는 도구입니다: ${name}` };
  }
}
