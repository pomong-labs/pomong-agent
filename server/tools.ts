import crypto from 'node:crypto';
import { db } from './db';
import { currentStats } from './system';
import * as vault from './vault';
import { weatherReport } from './weather';
import * as browser from './browser';
import * as jobs from './jobs';
import * as watchers from './watchers';
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

  /* ---------------------- Phase 2: 자율 웹 브라우저 ---------------------- */
  {
    name: 'browser_open',
    description:
      '실제 웹 브라우저로 페이지를 연다. API가 없는 사이트를 직접 보거나 조작할 때 쓴다. URL을 열면 화면 요소(ref)와 텍스트를 돌려준다.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '열 주소 (예: https://example.com)' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: '현재 브라우저 화면의 텍스트와 조작 가능한 요소(ref) 목록을 다시 읽는다. 클릭·입력 후 화면이 바뀌었는지 확인할 때 쓴다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description:
      '화면의 버튼·링크를 누른다. ref는 browser_snapshot이 준 값(e1, e2 …). 결제·게시·삭제 버튼은 눌 수 없고 사용자에게 넘겨야 한다.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '요소 ref (예: e12)' },
        text: { type: 'string', description: 'ref를 모를 때 누를 요소의 글자' },
      },
    },
  },
  {
    name: 'browser_type',
    description:
      '입력창에 글자를 넣는다. 비밀번호·카드번호·인증번호 입력은 하드블록이라 할 수 없다(사용자에게 넘긴다).',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '입력창 ref' },
        text: { type: 'string', description: '넣을 내용' },
        submit: { type: 'boolean', description: '입력 후 Enter까지 누를지' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_extract',
    description: '현재 페이지의 본문 텍스트를 정리해 가져온다(목록·표·가격 읽기).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description: '현재 브라우저 화면을 캡처해 파일로 저장한다(사용자에게 보여줄 때).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_handover',
    description:
      '화면을 사용자에게 넘긴다. 로그인·인증번호(OTP)·캡차·결제·본인인증은 에이전트가 할 수 없으므로 반드시 이 도구로 넘기고, 사용자가 마치면 이어서 한다.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['login', 'otp', 'captcha', 'payment', 'identity', 'manual'],
          description: '넘기는 이유',
        },
        detail: { type: 'string', description: '사용자에게 보여줄 한 줄 안내' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'browser_close',
    description: '브라우저 세션을 닫는다. 일이 끝났으면 닫아 서버 메모리를 아낀다.',
    parameters: { type: 'object', properties: {} },
  },

  /* ------------------- Phase 2: 예약 실행 · 워치 ------------------- */
  {
    name: 'automation_list',
    description: '예약 작업(스케줄)과 워치(웹 변화 감시) 목록을 조회한다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'job_create',
    description:
      '예약 실행을 만든다. "매일 아침 8시에 서버 상태 알려줘" 같은 반복 요청에 쓴다. cron은 5필드(분 시 일 월 요일)이며 Asia/Seoul 기준이다.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '작업 이름' },
        cron: { type: 'string', description: 'cron 5필드 (예: 0 8 * * * = 매일 08:00)' },
        prompt: { type: 'string', description: '깨어났을 때 할 일(지시문)' },
        max_steps: { type: 'number', description: '최대 단계(기본 6)' },
      },
      required: ['name', 'cron', 'prompt'],
    },
  },
  {
    name: 'watch_create',
    description:
      '웹 페이지 변화 감시(워치)를 만든다. "이 상품 재입고되면 알려줘", "이 페이지 바뀌면 알려줘"에 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '감시 이름' },
        url: { type: 'string', description: '감시할 주소' },
        mode: {
          type: 'string',
          enum: ['selector', 'text', 'json', 'regex', 'price', 'rss', 'github', 'ping'],
          description: '추출 방식 (기본 text, 가격은 price)',
        },
        target: { type: 'string', description: 'selector면 CSS 선택자, json이면 경로, regex면 정규식, github이면 owner/repo' },
        interval_min: { type: 'number', description: '확인 주기(분, 최소 5 · 기본 30)' },
      },
      required: ['name', 'url'],
    },
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
  {
    name: 'browser_open',
    label: '웹 브라우저 열기',
    summary: '실제 브라우저로 페이지를 열어 보고 조작해요. 로그인·결제는 사용자에게 넘겨요.',
    example: '쿠팡에서 이 상품 재고 확인해줘',
  },
  {
    name: 'browser_handover',
    label: '화면 넘겨받기',
    summary: '로그인·인증번호·캡차·결제 화면을 내게 넘겨줘요. 내가 하면 AI가 이어서 진행해요.',
    example: '깃허브 로그인은 내가 할게',
  },
  {
    name: 'job_create',
    label: '예약 실행 만들기',
    summary: '정해진 시각에 AI가 스스로 깨어나 일하게 해요.',
    example: '매일 아침 8시에 서버 상태 알려줘',
  },
  {
    name: 'watch_create',
    label: '웹 변화 감시',
    summary: '페이지가 바뀌면 알려줘요. 가격·재고 감시에 써요(구매는 하지 않아요).',
    example: '이 상품 재입고되면 알려줘',
  },
];

export interface ToolResult {
  content: string;
  meta?: 'tasks' | 'server_stats' | 'browser';
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
    case 'browser_open': {
      const url = String(args.url || '').trim();
      if (!url) return { content: '어떤 주소를 열지 알려 주세요.' };
      try {
        const result = await browser.openUrl(url);
        return { content: `${result.policy}\n\n${result.snapshot}`, meta: 'browser' };
      } catch (err) {
        return { content: `브라우저를 열지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'browser_snapshot': {
      try {
        const result = await browser.snapshot();
        return { content: result.snapshot, meta: 'browser' };
      } catch (err) {
        return { content: `화면을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'browser_click': {
      try {
        const result = await browser.click({ ref: args.ref ? String(args.ref) : undefined, text: args.text ? String(args.text) : undefined });
        return { content: result.snapshot, meta: 'browser' };
      } catch (err) {
        return { content: `누르지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'browser_type': {
      try {
        const result = await browser.typeInto({
          ref: args.ref ? String(args.ref) : undefined,
          text: String(args.text || ''),
          submit: Boolean(args.submit),
        });
        return { content: result.snapshot, meta: 'browser' };
      } catch (err) {
        return { content: `입력하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'browser_extract': {
      try {
        const result = await browser.extract();
        return { content: `<untrusted>\n${result.text}\n</untrusted>`, meta: 'browser' };
      } catch (err) {
        return { content: `페이지를 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'browser_screenshot': {
      try {
        const shot = await browser.screenshot();
        return { content: `화면을 캡처했습니다: ${shot.title} (${shot.url})\n파일: ${shot.path}`, meta: 'browser' };
      } catch (err) {
        return { content: `캡처하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'browser_handover': {
      const reason = String(args.reason || 'manual') as browser.HandoverReason;
      const detail = String(args.detail || '').trim();
      try {
        const result = await browser.requestHandover(
          ['login', 'otp', 'captcha', 'payment', 'identity', 'manual'].includes(reason) ? reason : 'manual',
          detail
        );
        return {
          content: `사용자에게 화면을 넘겼습니다(${result.label}). ${detail ? `안내: ${detail} ` : ''}사용자가 '넘겨줄게'를 누를 때까지 자동 조작은 멈춥니다. 그동안 자격증명을 읽거나 입력하지 마세요.`,
          meta: 'browser',
        };
      } catch (err) {
        return { content: `화면을 넘기지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'browser_close': {
      await browser.closeSession().catch(() => undefined);
      return { content: '브라우저 세션을 닫았습니다.', meta: 'browser' };
    }
    case 'automation_list': {
      const jobList = jobs.listJobs();
      const watchList = watchers.listWatchers();
      const lines: string[] = [];
      lines.push(jobList.length ? `예약 작업 ${jobList.length}개:` : '예약된 작업이 없습니다.');
      for (const j of jobList) {
        lines.push(`- ${j.name} · ${j.scheduleLabel} · ${j.enabled ? '켜짐' : '꺼짐'}${j.nextRunAt ? ` · 다음 ${j.nextRunAt}` : ''}`);
      }
      lines.push(watchList.length ? `워치 ${watchList.length}개:` : '감시 중인 워치가 없습니다.');
      for (const w of watchList) {
        lines.push(`- ${w.name} · ${w.intervalMin}분마다 · ${w.lastStatus || '대기'}`);
      }
      return { content: lines.join('\n') };
    }
    case 'job_create': {
      try {
        const job = jobs.createJob({
          name: String(args.name || ''),
          cron: String(args.cron || ''),
          prompt: String(args.prompt || ''),
          maxSteps: Number(args.max_steps) || undefined,
          timezone: 'Asia/Seoul',
        });
        return { content: `예약 작업을 만들었습니다: ${job.name} · ${job.scheduleLabel}${job.nextRunAt ? ` · 다음 실행 ${job.nextRunAt}` : ''}` };
      } catch (err) {
        return { content: `예약 작업을 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'watch_create': {
      try {
        const watch = watchers.createWatcher({
          name: String(args.name || ''),
          url: String(args.url || ''),
          mode: watchers.normalizeMode(args.mode),
          target: args.target ? String(args.target) : null,
          intervalMin: Number(args.interval_min) || 30,
        });
        return { content: `워치를 만들었습니다: ${watch.name} · ${watch.intervalMin}분마다 확인` };
      } catch (err) {
        return { content: `워치를 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
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
