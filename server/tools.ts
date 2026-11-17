import crypto from 'node:crypto';
import { db } from './db';
import { currentStats } from './system';
import * as vault from './vault';
import { weatherReport } from './weather';
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
    name: 'weather_get',
    description:
      '지정한 지역의 현재 날씨와 오늘·주간 예보를 조회한다. 사용자가 날씨·기온·비·눈·우산·옷차림을 물으면 사용한다. 한국 지명("강원도 인제", "서울", "익산")과 영문 도시명("Tokyo") 모두 된다.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '지역명 (예: "강원도 인제", "서울", "익산", "Tokyo")' },
        days: { type: 'number', description: '예보 일수 1~7 (기본 3)' },
      },
      required: ['location'],
    },
  },
  {
    name: 'time_now',
    description: '현재 날짜와 시각(Asia/Seoul)을 조회한다. 날짜 계산이 필요할 때 사용한다.',
    parameters: { type: 'object', properties: {} },
  },
];

/** 앱 '더보기 → 도구 목록' 화면에 보여줄 도구 설명 */
export interface ToolCatalogEntry {
  name: string;
  label: string;
  summary: string;
  example: string;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'weather_get',
    label: '날씨 조회',
    summary: '지역의 현재 날씨와 최대 7일 예보를 확인해요. (Open-Meteo · API 키 불필요)',
    example: '강원도 인제 내일 날씨 알려줘',
  },
  {
    name: 'tasks_list',
    label: '할 일 조회',
    summary: '진행 중·완료된 할 일 목록을 확인해요.',
    example: '오늘 할 일 뭐 있어?',
  },
  {
    name: 'tasks_add',
    label: '할 일 추가',
    summary: '마감일·우선순위를 붙여 새 할 일을 등록해요.',
    example: '내일 오후 3시에 약 먹기 추가해줘',
  },
  {
    name: 'tasks_complete',
    label: '할 일 완료',
    summary: '말한 할 일을 찾아 완료 처리해요.',
    example: '우유 사기 다 했어',
  },
  {
    name: 'vault_list',
    label: '금고 목록',
    summary: '금고에 저장된 항목 이름과 종류만 확인해요. 비밀값은 AI에게 전달되지 않아요.',
    example: '금고에 뭐 저장돼 있어?',
  },
  {
    name: 'server_stats',
    label: '서버 상태',
    summary: '이 서버의 CPU·RAM·디스크·부하·가동 시간을 확인해요.',
    example: '지금 서버 상태 어때?',
  },
  {
    name: 'time_now',
    label: '현재 시각',
    summary: '오늘 날짜와 시각을 확인해 날짜 계산을 정확히 해요.',
    example: '이번 주 금요일이 며칠이야?',
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
    case 'weather_get': {
      const location = String(args.location || '').trim();
      if (!location) return { content: '어느 지역의 날씨를 알려드릴까요? 지역 이름을 말씀해 주세요.' };
      const days = Number(args.days) || 3;
      const report = await weatherReport(location, days);
      return { content: report.content };
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
