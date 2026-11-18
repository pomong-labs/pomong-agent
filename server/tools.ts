import crypto from 'node:crypto';
import { db } from './db';
import { currentStats } from './system';
import * as vault from './vault';
import { weatherReport } from './weather';
import * as browser from './browser';
import * as jobs from './jobs';
import * as watchers from './watchers';
import * as memory from './memory';
import * as loginRequests from './login-requests';
import * as attachments from './attachments';
import { webSearch, formatSearch } from './web-search';
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

  /* --------------- v0.5.0: 무료 웹 검색 · 중간 말풍선 --------------- */
  {
    name: 'web_search',
    description:
      'API 키 없이 동작하는 무료 웹 검색. 사이트를 직접 열지 않아도 되는 사실·가격·뉴스·설명을 찾을 때 쓴다. 봇 차단이 강한 사이트(쿠팡 등)에서 browser_open이 막히면 이 도구로 찾아 답한다. 제목·주소·발췌문 상위 5~8건을 돌려준다.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어 (예: "아이폰 17 쿠팡 가격")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'chat_notify',
    description:
      '오래 걸리는 작업(브라우저 열기·검색·여러 단계)을 시작하기 전에 사용자에게 짧은 안내 말풍선을 먼저 보낸다. 예: "깃허브 연동해 드릴게요, 잠시만요!". 같은 작업에서 한 번만 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '사용자에게 보여 줄 한두 문장' },
      },
      required: ['text'],
    },
  },

  /* --------------------- v0.5.0: 영구 기억 --------------------- */
  {
    name: 'memory_save',
    description:
      '사용자에 대해 오래 기억할 사실을 저장한다. 사용자가 달라고 하지 않아도 취향·습관·직업·중요한 인물·약속·프로젝트 규칙이 나오면 스스로 저장한다. 인사말·일회성 요청은 저장하지 않는다.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '기억할 내용 한 문장 (예: "아침 브리핑은 강원도 인제 날씨로 받고 싶어 한다")' },
        category: {
          type: 'string',
          enum: ['profile', 'taste', 'habit', 'person', 'promise', 'project', 'rule', 'other'],
          description: '분류 (기본 other)',
        },
        importance: { type: 'number', description: '중요도 1~5 (기본 2, 규칙·중요한 약속은 4~5)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_search',
    description: '저장된 기억을 키워드로 찾는다. 사용자의 취향·약속·과거 대화 내용을 확인할 때 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어 (비우면 전체)' },
      },
    },
  },
  {
    name: 'memory_delete',
    description: '저장된 기억을 지운다. 사용자가 "그거 잊어줘"라고 하거나 잘못 저장한 것을 정리할 때 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '지울 기억의 내용 일부 또는 id' },
      },
      required: ['query'],
    },
  },

  /* ------------------- v0.5.0: 금고 자동 로그인 ------------------- */
  {
    name: 'vault_find_for_site',
    description:
      '사이트·서비스 이름으로 금고에 저장된 계정을 찾는다. 비밀번호·아이디 원문은 돌려주지 않고 id·제목·마스킹된 아이디·기본 계정 여부만 준다. 로그인이 필요할 때 먼저 이 도구로 계정을 확인한다.',
    parameters: {
      type: 'object',
      properties: {
        site_or_service: { type: 'string', description: '사이트·서비스 이름 (예: "깃허브", "쿠팡")' },
      },
      required: ['site_or_service'],
    },
  },
  {
    name: 'vault_request_login',
    description:
      '금고에 그 서비스 계정이 없을 때, 채팅 화면에 아이디·비밀번호를 받는 로그인 카드를 띄운다. 사용자가 카드에 입력해 저장하면 서버가 금고에 암호화 저장하고 AI에게 후속 턴을 줘 브라우저 로그인을 이어서 한다. 계정이 없을 때 "직접 하세요"로 끝내지 말고 반드시 이 도구를 부른다.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: '서비스 이름 (예: "GitHub", "쿠팡")' },
        login_url: { type: 'string', description: '로그인 페이지 주소 (예: https://github.com/login)' },
        site_host: { type: 'string', description: '사이트 도메인 (예: github.com) — 없으면 주소에서 자동' },
        note: { type: 'string', description: '카드에 함께 보여 줄 한 줄 안내(선택)' },
      },
      required: ['service', 'login_url'],
    },
  },
  {
    name: 'browser_fill_vault',
    description:
      '금고에 저장된 아이디/비밀번호를 브라우저 입력창에 서버가 직접 채운다(값은 AI에게 전달되지 않는다). 로그인 화면에서만 쓴다. 아이디·비밀번호·로그인 버튼을 한 번에 끝내려면 browser_login_with_vault를 쓰는 것이 좋다. 금고가 잠겨 있으면 먼저 금고 잠금 해제를 안내한다.',
    parameters: {
      type: 'object',
      properties: {
        vault_id: { type: 'string', description: 'vault_find_for_site가 준 항목 id' },
        field: { type: 'string', enum: ['username', 'password'], description: '채울 값' },
        ref: { type: 'string', description: '입력창 요소 ref (browser_snapshot에서 확인)' },
        submit: { type: 'boolean', description: '비밀번호를 채운 뒤 Enter까지 눌러 전송할지(기본 false)' },
      },
      required: ['vault_id', 'field', 'ref'],
    },
  },
  {
    name: 'browser_login_with_vault',
    description:
      '금고 계정으로 로그인을 **한 번에 끝낸다**: 아이디 입력 → 비밀번호 입력 → 로그인 버튼 클릭까지 서버가 직접 한다(값은 AI에게 전달되지 않는다). 로그인 화면에서 vault_find_for_site로 항목 id를 찾았으면 이것만 부르면 된다. ref는 비워 두어도 서버가 화면에서 찾는다. 인증번호(OTP)·캡차가 나오면 그때만 browser_handover를 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        vault_id: { type: 'string', description: '금고 항목 id (vault_find_for_site 결과)' },
        username_ref: { type: 'string', description: '아이디 입력창 ref (없으면 자동 탐색)' },
        password_ref: { type: 'string', description: '비밀번호 입력창 ref (없으면 자동 탐색)' },
        submit_ref: { type: 'string', description: '로그인 버튼 ref (없으면 자동 탐색)' },
        submit: { type: 'boolean', description: '로그인 버튼을 누를지(기본 true)' },
      },
      required: ['vault_id'],
    },
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

  /* ------------------ v0.5.2: 채팅 첨부 파일 ------------------ */
  {
    name: 'attachment_read',
    description:
      '사용자가 채팅에 첨부한 파일의 내용을 다시 읽는다. 첨부는 대부분 자동으로 프롬프트에 포함되므로, 내용이 잘렸거나 파일 정보만 전달됐을 때 쓴다. id는 [첨부] 블록에 적힌 값을 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        attachment_id: { type: 'string', description: '첨부 id' },
        max_chars: { type: 'number', description: '읽을 최대 글자 수(기본 12000)' },
      },
      required: ['attachment_id'],
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
  {
    name: 'web_search',
    label: '웹 검색',
    summary: 'API 키 없이 웹을 검색해 제목·주소·발췌문을 가져와요. 사이트가 막혔을 때도 최소한 정보를 찾아요.',
    example: '요즘 아이폰 17 최저가 알려줘',
  },
  {
    name: 'memory_save',
    label: '영구 기억',
    summary: '취향·습관·약속을 스스로 기억해 다음 대화에도 반영해요. 기억함에서 직접 고칠 수 있어요.',
    example: '내일 오후 3시 취사장 근무 기억해줘',
  },
  {
    name: 'vault_find_for_site',
    label: '금고 자동 로그인',
    summary: '금고 계정으로 로그인 화면을 채워요. 비밀번호는 AI에게 전달되지 않아요.',
    example: '깃허브 로그인해줘',
  },
  {
    name: 'browser_login_with_vault',
    label: '원스톱 로그인',
    summary: '아이디·비밀번호 입력부터 로그인 버튼 클릭까지 한 번에 끝내요. OTP·캡차만 내게 넘어와요.',
    example: '깃허브에 금고 계정으로 로그인해줘',
  },
  {
    name: 'vault_request_login',
    label: '로그인 정보 받기',
    summary: '금고에 계정이 없으면 채팅에 로그인 카드를 띄워 아이디·비밀번호를 받고, 저장한 뒤 바로 로그인까지 해요.',
    example: '깃허브 연동하고 싶어',
  },
];

export interface ToolResult {
  content: string;
  meta?: 'tasks' | 'server_stats' | 'browser';
}

export interface ToolContext {
  /** 채팅 세션 id (로그인 카드를 그 세션 화면에 붙인다) */
  session?: string;
}

function taskLine(row: TaskRow): string {
  const mark = row.done ? '[완료]' : '[할 일]';
  const priority = normalizePriority(row.priority);
  const prio = priority === 'high' ? ' (우선순위 높음)' : priority === 'low' ? ' (우선순위 낮음)' : '';
  const due = row.due ? ` · 마감 ${dueLabel(row.due)}` : '';
  const overdue = !row.done && isOverdue(row.due) ? ' · 기한 지남!' : '';
  return `${mark} ${row.title}${prio}${due}${overdue}`;
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext = {}): Promise<ToolResult> {
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
    case 'web_search': {
      try {
        const result = await webSearch(String(args.query || ''));
        return { content: formatSearch(result) };
      } catch (err) {
        return { content: `검색하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'chat_notify': {
      // 실제 발송은 agent-loop가 담당한다(메시지 저장 + SSE).
      return { content: '사용자에게 안내 말풍선을 보냈습니다. 이어서 작업을 진행하세요.' };
    }
    case 'memory_save': {
      try {
        const saved = memory.createMemory({
          content: String(args.content || ''),
          category: args.category,
          importance: args.importance,
          source: 'chat',
        });
        return { content: `기억에 저장했습니다: ${saved.content}` };
      } catch (err) {
        return { content: `기억하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'memory_search': {
      const query = String(args.query || '').trim();
      const items = query ? memory.searchMemories(query, 10) : memory.listMemories(undefined, 20);
      return { content: memory.formatMemoryList(items) };
    }
    case 'memory_delete': {
      const query = String(args.query || '').trim();
      if (!query) return { content: '어떤 기억을 지울지 알려 주세요.' };
      const byId = memory.deleteMemory(query);
      const count = byId ? 1 : memory.deleteMemoriesByText(query);
      return { content: count ? `기억 ${count}개를 지웠습니다.` : `'${query}'와 맞는 기억을 찾지 못했습니다.` };
    }
    case 'vault_find_for_site': {
      const term = String(args.site_or_service || '').trim();
      if (!term) return { content: '어떤 사이트의 계정을 찾을지 알려 주세요.' };
      const matches = vault.findForSite(term);
      if (!matches.length) {
        return {
          content: `금고에 '${term}' 계정이 없습니다. 사용자에게 직접 하라고 하지 말고, vault_request_login(service, login_url)을 불러 채팅에 로그인 카드를 띄우세요. 사용자가 카드에 계정을 넣으면 금고에 저장되고, 그 즉시 로그인을 이어서 하게 됩니다.`,
        };
      }
      const lines = matches.map(
        (m) =>
          `- id=${m.id} · ${m.title} (${m.type === 'login' ? '로그인' : m.type === 'apikey' ? 'API 키' : '메모'}) · 아이디 ${m.usernameMasked || '없음'}${m.isDefault ? ' · 기본 계정' : ''}`
      );
      const multi = matches.filter((m) => m.type === 'login').length;
      const hasDefault = matches.some((m) => m.isDefault);
      const hint =
        multi > 1 && !hasDefault
          ? '\n⚠️ 같은 서비스에 계정이 여러 개이고 기본 계정이 없습니다. 임의로 고르지 말고, 채팅에서 어느 계정을 쓸지 사용자에게 물어보세요.'
          : '';
      return {
        content: `금고에서 '${term}' 계정 ${matches.length}개를 찾았습니다(비밀번호는 표시하지 않음):\n${lines.join('\n')}\n입력은 browser_fill_vault(vault_id, field, ref)로 서버가 직접 합니다.${hint}`,
      };
    }
    case 'vault_request_login': {
      const service = String(args.service || '').trim();
      const loginUrl = String(args.login_url || '').trim();
      const siteHost = String(args.site_host || '').trim();
      const note = String(args.note || '').trim();
      const noteText = note || undefined;
      if (!service || !loginUrl) return { content: '서비스 이름과 로그인 주소가 필요합니다.' };
      if (!/^https?:\/\//i.test(loginUrl)) return { content: 'login_url은 http:// 또는 https://로 시작하는 주소여야 합니다.' };
      // 이미 대기 중인 같은 서비스 카드가 있으면 새로 만들지 않고 그것을 안내한다.
      const open = loginRequests
        .listForSession(ctx.session || 'default')
        .find((r) => r.status === 'pending' && r.service.toLowerCase() === service.toLowerCase());
      const card = open ||
        loginRequests.create({ sessionId: ctx.session || 'default', service, loginUrl, siteHost, note: noteText });
      return {
        content: `채팅 화면에 '${service}' 로그인 카드를 띄웠습니다(id: ${card.id}). 이제 브라우저를 열지 말고 사용자에게 "아래 카드에 계정 정보를 입력해 주시면 제가 바로 로그인해 드릴게요!"라고 안내하며 답변을 마치세요. 사용자가 카드를 저장하면 자동으로 이어서 로그인합니다.`,
      };
    }
    case 'browser_fill_vault': {
      const vaultId = String(args.vault_id || '');
      const field = String(args.field || '') === 'password' ? 'password' : 'username';
      const ref = String(args.ref || '');
      if (!vaultId || !ref) return { content: '금고 항목 id와 입력창 ref가 필요합니다.' };
      try {
        const values = vault.secretForFill(vaultId);
        const value = field === 'password' ? values.secret : values.username;
        if (!value) return { content: `이 항목에는 ${field === 'password' ? '비밀번호' : '아이디'}가 저장되어 있지 않습니다.` };
        const result = await browser.fillFromVault(ref, value, field, { submit: Boolean(args.submit) });
        return { content: `${field === 'password' ? '비밀번호' : '아이디'}를 금고에서 채웠습니다(값은 기록하지 않음).${args.submit ? ' Enter로 전송했습니다.' : ''}\n\n${result.snapshot}`, meta: 'browser' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('잠겨')) {
          return {
            content:
              '금고가 잠겨 있어 자동 입력을 할 수 없습니다. 사용자에게 금고 탭에서 PIN으로 잠금을 해제해 달라고 안내한 뒤 다시 시도하세요.',
          };
        }
        return { content: `자동 입력에 실패했습니다: ${message}` };
      }
    }
    case 'browser_login_with_vault': {
      const vaultId = String(args.vault_id || '');
      if (!vaultId) return { content: '금고 항목 id가 필요합니다(vault_find_for_site로 먼저 찾으세요).' };
      try {
        const values = vault.secretForFill(vaultId);
        if (!values.secret) return { content: '이 항목에는 비밀번호가 저장되어 있지 않습니다.' };
        const result = await browser.loginWithVault({
          username: values.username,
          password: values.secret,
          usernameRef: args.username_ref ? String(args.username_ref) : undefined,
          passwordRef: args.password_ref ? String(args.password_ref) : undefined,
          submitRef: args.submit_ref ? String(args.submit_ref) : undefined,
          submit: args.submit === undefined ? true : Boolean(args.submit),
        });
        const done = `아이디 ${result.filledUsername ? '입력 완료' : '칸을 찾지 못해 건너뜀'} · 비밀번호 입력 완료 · ${
          result.submitted === 'click' ? '로그인 버튼 클릭' : result.submitted === 'enter' ? 'Enter로 전송' : '전송하지 않음'
        } (값은 기록하지 않음).`;
        const next = result.stillOnLogin
          ? '\n\n※ 아직 로그인 화면으로 보입니다. 아이디·비밀번호가 틀렸거나 인증번호(OTP)·캡차·2단계 인증일 수 있습니다. 화면에 인증번호·캡차가 있으면 browser_handover로 사용자에게 넘기고, 그냥 로그인 실패 문구라면 사용자에게 금고의 계정 정보를 확인해 달라고 알려 주세요.'
          : '\n\n※ 로그인 화면을 벗어났습니다. 이어서 하려던 일을 계속하세요.';
        return { content: `${done}${next}\n\n${result.snapshot}`, meta: 'browser' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('잠겨')) {
          return {
            content:
              '금고가 잠겨 있어 자동 로그인을 할 수 없습니다. 사용자에게 금고 탭에서 PIN으로 잠금을 해제해 달라고 안내한 뒤 다시 시도하세요.',
          };
        }
        return { content: `자동 로그인에 실패했습니다: ${message}` };
      }
    }
    case 'attachment_read': {
      const id = String(args.attachment_id || '').trim();
      if (!id) return { content: '첨부 id가 필요합니다.' };
      const row = attachments.getRow(id);
      if (!row) return { content: `첨부를 찾지 못했습니다: ${id}` };
      if (row.kind === 'image') {
        return { content: `'${row.filename}'은 사진입니다(${(row.size / 1024).toFixed(0)}KB). 사진은 대화에 첨부될 때 이미 함께 전달됩니다.` };
      }
      const maxChars = Math.min(40_000, Math.max(500, Number(args.max_chars) || 12_000));
      const content = attachments.readTextContent(row, maxChars);
      if (!content) {
        return {
          content: `'${row.filename}'의 내용을 텍스트로 읽지 못했습니다(형식: ${row.mime}, ${(row.size / 1024).toFixed(0)}KB). 파일은 서버 data/${row.path} 에 저장되어 있습니다. 사용자에게 이 사실을 알리고, 필요하면 텍스트로 붙여 달라고 안내하세요.`,
        };
      }
      return { content: `<file name="${row.filename}" (앞부분)>\n${content}\n</file>` };
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
