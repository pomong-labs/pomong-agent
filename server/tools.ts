import crypto from 'node:crypto';
import { db } from './db';
import { currentStats } from './system';
import * as vault from './vault';
import { weatherReport } from './weather';
import * as browser from './browser';
import * as jobs from './jobs';
import * as watchers from './watchers';
import * as memory from './memory';
import * as history from './history';
import * as loginRequests from './login-requests';
import * as vaultUnlock from './vault-unlock';
import { findServiceInText } from './services';
import * as attachments from './attachments';
import * as files from './files';
import * as mail from './mail';
import * as images from './images';
import * as reactions from './reactions';
import { publish } from './events';
import { webSearch, formatSearch } from './web-search';
import * as parcel from './parcel';
import * as parcelWatch from './parcel-watch';
import * as market from './market';
import * as ddays from './ddays';
import * as docker from './docker';
import type { ToolSpec } from './providers';

/** v0.6.3: 메일 계정을 아직 연결하지 않았을 때 안내 */
function mailNotConnectedMessage(): string {
  return '아직 연결된 메일 계정이 없습니다. 사용자에게 설정 > 이메일에서 네이버·지메일 계정을 연결(앱 비밀번호)해 달라고 안내하세요. 연결하면 메일 확인·검색·발송을 바로 할 수 있습니다.';
}

/** v0.6.3: 도구 인자로 받은 계정 주소 → 계정 id */
function resolveMailAccount(hint: unknown): string | undefined {
  const text = String(hint || '').trim().toLowerCase();
  if (!text) return undefined;
  const accounts = mail.listAccounts();
  const found =
    accounts.find((a) => a.email.toLowerCase() === text) ||
    accounts.find((a) => a.email.toLowerCase().includes(text) || a.label.toLowerCase().includes(text));
  return found?.id;
}

function formatMailDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

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

  /* --------------------- v0.6.0: 과거 대화 검색 --------------------- */
  {
    name: 'chat_history_search',
    description:
      '과거 대화 **전체**(지금 대화방 + 다른 대화방 모두)를 검색한다. 사용자가 예전에 말한 취향·조건, 지난번에 하던 작업, "저번에 그거 뭐였지" 같은 것을 확인할 때 쓴다. 대화가 아무리 쌓여도 필요한 말만 골라 방 이름·시각·발췌문을 돌려준다.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '찾을 낱말 (예: "무신사 로그인", "생일", "배포 규칙")' },
        session: { type: 'string', description: '특정 대화방 id만 보고 싶을 때 (보통은 비워 둔다)' },
        limit: { type: 'number', description: '최대 결과 수 (기본 8, 최대 30)' },
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
      '금고에 그 서비스 계정이 없을 때, 채팅 화면에 아이디·비밀번호를 받는 로그인 카드를 띄운다. 사용자가 카드에 입력해 저장하면 서버가 금고에 암호화 저장하고 AI에게 후속 턴을 줘 브라우저 로그인을 이어간다. 금고에 그 사이트 계정이 **이미 있으면**(잠겼더라도) 카드를 만들지 않고 금고 PIN 해제 카드만 띄운다. 계정이 없을 때 "직접 하세요"로 끝내지 말고 반드시 이 도구를 부른다.',
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
      '금고 계정으로 로그인을 **한 번에 끝낸다**: 아이디 입력 → 비밀번호 입력 → 로그인 버튼 클릭까지 서버가 직접 한다(값은 AI에게 전달되지 않는다). 로그인 화면에서 vault_find_for_site로 항목 id를 찾았으면 이것만 부르면 된다. ref는 비워 두어도 서버가 화면에서 찾는다. 이미 로그인된 사이트면 "이미 로그인된 상태"를 돌려주니 로그인을 반복하지 말고 하던 일을 이어간다. 인증번호(OTP)·캡차가 나오면 그때만 browser_handover를 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        vault_id: { type: 'string', description: '금고 항목 id (vault_find_for_site 결과)' },
        username_ref: { type: 'string', description: '아이디 입력창 ref (없거나 틀리면 서버가 다시 찾는다)' },
        password_ref: { type: 'string', description: '비밀번호 입력창 ref (없거나 틀리면 서버가 다시 찾는다)' },
        submit_ref: { type: 'string', description: '로그인 버튼 ref (없거나 틀리면 서버가 다시 찾는다)' },
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
      '화면의 버튼·링크를 누른다. ref는 browser_snapshot이 준 값(e1, e2 …). 누르지 못하면 최신 화면을 함께 돌려준다. 결제·구매 버튼과 삭제·계정 변경 버튼은 누를 수 없다. 메시지·문의 답장 전송 버튼은 사용자가 이번에 직접 부탁했을 때만 누를 수 있다.',
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
      '입력창에 글자를 넣는다. 비밀번호·카드번호·인증번호 입력은 하드블록이라 할 수 없다(사용자에게 넘긴다). 메시지·답장 입력창에 글을 쓴 뒤 바로 보내려면 pressEnter: true를 함께 넘긴다(누를 버튼이 따로 있으면 그 버튼을 browser_click으로 누른다).',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '입력창 ref' },
        text: { type: 'string', description: '넣을 내용' },
        submit: { type: 'boolean', description: '입력 후 Enter까지 누를지' },
        pressEnter: { type: 'boolean', description: 'submit과 같은 뜻(입력 후 Enter). 둘 중 하나만 넘겨도 된다' },
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

  /* ------------------ v0.6.3: 이메일(IMAP/SMTP) ------------------ */
  {
    name: 'mail_list',
    description:
      '연결된 메일함(네이버·지메일)의 최근 메일을 읽는다. "새 메일 왔어?", "안 읽은 메일 확인해줘", "메일함 정리해줘" 같은 요청에 쓴다. 제목·보낸사람·날짜와 uid를 돌려주고, 본문은 mail_read로 읽는다.',
    parameters: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: '안 읽은 메일만 볼지(기본 false)' },
        limit: { type: 'number', description: '가져올 개수 1~30 (기본 10)' },
        account: { type: 'string', description: '메일 계정 주소(여러 개 연결했을 때만)' },
      },
    },
  },
  {
    name: 'mail_read',
    description:
      '메일 한 통의 본문을 읽는다. mail_list·mail_search가 준 uid를 넣는다. 사용자가 "그 메일 내용 보여줘"라고 하거나 요약·답장을 해야 할 때 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'number', description: '메일 uid (mail_list 결과의 uid)' },
        account: { type: 'string', description: '메일 계정 주소(여러 개일 때만)' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'mail_search',
    description:
      '메일함을 제목·보낸사람·본문으로 검색한다. "지난주에 온 견적 메일 찾아줘" 같은 요청에 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어 (예: "견적", "쿠팡")' },
        limit: { type: 'number', description: '가져올 개수 1~30 (기본 10)' },
        account: { type: 'string', description: '메일 계정 주소(여러 개일 때만)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mail_send',
    description:
      '메일을 쓰는 도구. 호출하면 **바로 보내지 않고** 채팅에 확인 카드(받는 사람·제목·본문)를 띄운다. 사용자가 카드에서 "보내기"를 눌러야 실제로 발송된다. 초안을 만든 뒤 사용자에게 "카드에서 확인하고 보내기를 눌러 주세요"라고 알려 준다. 받는 사람·제목·본문은 사용자가 말한 내용 그대로, 정중한 메일 형식으로 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '받는 사람 이메일(여러 명이면 쉼표로)' },
        subject: { type: 'string', description: '메일 제목' },
        body: { type: 'string', description: '메일 본문(인사·맺음말 포함)' },
        cc: { type: 'string', description: '참조(선택)' },
        account: { type: 'string', description: '보내는 계정 주소(여러 개일 때만)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },

  /* ------------------ v0.5.5: 결과물 파일 저장 ------------------ */
  {
    name: 'file_save',
    description:
      '네가 만든 결과물(정리한 글·표·코드·메모 등)을 파일로 저장해 앱의 파일함(/files)에 보관한다. 사용자가 "파일로 저장해줘"·"문서로 만들어줘"라고 하거나, 길어서 다시 열어 볼 수 있게 남겨야 할 때 쓴다. 저장한 파일은 파일함에서 보기·내려받기·삭제할 수 있다.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '파일 이름(확장자 포함, 예: 회의정리.md)' },
        content: { type: 'string', description: '파일에 담을 텍스트' },
        content_base64: { type: 'string', description: '이미지·PDF 같은 바이너리를 base64로 넘길 때(content 대신 사용)' },
        mime: { type: 'string', description: '파일 형식(비우면 확장자로 판단)' },
      },
      required: ['name'],
    },
  },

  /* --------------- v0.6.15: 그림 생성·편집 · QR · 리액션 --------------- */
  {
    name: 'generate_image',
    description:
      '채팅방에서 그림을 새로 만든다. 사용자가 "고양이 그림 그려줘", "로고 만들어줘", "썸네일 만들어줘"처럼 그림·이미지 생성을 부탁하면 쓴다. ' +
      '그림은 파일함에 저장되고 채팅 말풍선에 바로 보이므로, 사용자에게 그림을 볼 수 없다고 말하지 말고 "만들었어요"라고 알려 준다. ' +
      '만들지 못하면(무료 한도·안전 정책) 그 이유를 도구가 알려 주니 그대로 짧게 전한다.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '그림 설명(영어가 결과가 좋다). 예: "a cozy winter cafe illustration, soft pastel colors, no text"',
        },
        aspect_ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'], description: '그림 비율(기본 1:1)' },
        model: { type: 'string', description: '이미지 모델을 직접 지정할 때만(보통 비워 둔다)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description:
      '이미 있는 사진을 고친다(배경 바꾸기, 스타일 변환, 요소 추가·제거, 색감 변경 등). 사용자가 채팅에 사진을 올리고 "이거 배경 바꿔줘"라고 하거나, 방금 만든 그림을 고쳐 달라고 하면 쓴다. ' +
      'source_image_id를 비우면 이 대화방에서 가장 최근 사진(올린 사진·만든 그림)을 고친다. 결과는 파일함에 저장되고 채팅에 바로 보인다.',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '어떻게 고칠지(예: "배경을 밤하늘로 바꾸고 별을 넣어 줘")' },
        source_image_id: { type: 'string', description: '고칠 사진의 첨부 id(비우면 이 방의 가장 최근 사진)' },
        aspect_ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'], description: '결과 비율(선택)' },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'create_qr',
    description:
      'QR 코드 이미지(PNG)를 만든다. 링크·글자·Wi-Fi 접속 정보를 담을 수 있고, 만든 QR은 파일함에 저장되고 채팅에 바로 보인다. ' +
      '"이 링크 QR로 만들어줘", "와이파이 QR 만들어줘" 같은 요청에 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'QR에 담을 문구(링크면 자동으로 https를 붙인다)' },
        url: { type: 'string', description: '담을 링크(text 대신 쓸 수 있다)' },
        kind: { type: 'string', enum: ['auto', 'url', 'text', 'wifi'], description: '종류(기본 auto)' },
        wifi_ssid: { type: 'string', description: 'Wi-Fi 이름(와이파이 QR일 때)' },
        wifi_password: { type: 'string', description: 'Wi-Fi 비밀번호(없으면 개방형)' },
        wifi_security: { type: 'string', enum: ['WPA', 'WEP', 'nopass'], description: 'Wi-Fi 보안 방식' },
        wifi_hidden: { type: 'boolean', description: '숨은 SSID 여부' },
        size: { type: 'number', description: 'PNG 크기(px, 256~2048, 기본 1024)' },
      },
    },
  },
  {
    name: 'react_to_message',
    description:
      '사용자의 말풍선에 이모지 리액션을 하나 단다. 고맙거나, 재밌거나, 축하하거나, 다정하게 공감할 만한 순간에만 가끔 쓴다. ' +
      `모든 메시지에 남발하지 말 것(한 대화에서 몇 번 정도). 예: ${reactions.REACTION_EXAMPLES.join(' ')}. ` +
      'message_id를 비우면 방금 받은 사용자 메시지에 달린다. 리액션은 채팅 말풍선 아래에 작은 뱃지로 보인다.',
    parameters: {
      type: 'object',
      properties: {
        emoji: { type: 'string', description: '이모지 하나' },
        message_id: { type: 'number', description: '리액션을 달 메시지 id(비우면 방금 받은 사용자 메시지)' },
        query: { type: 'string', description: '메시지 id를 모를 때, 그 말풍선에 들어 있는 글자 일부' },
      },
      required: ['emoji'],
    },
  },
  {
    name: 'track_parcel',
    description:
      '택배 송장번호로 지금 배송 상태·위치·이동 이력을 조회한다. "택배 어디쯤이야", "내 물건 언제 와", "배송 조회해줘"처럼 배송 상황을 물을 때 쓴다. ' +
      'API 키 없이 공개 조회 경로로 확인하며, 조회가 안 되면 이유를 그대로 알려 준다. 계속 지켜보다가 단계가 바뀔 때 알림을 받고 싶다는 요청이면 watch_parcel을 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'string', description: '운송장(송장) 번호 — 숫자만' },
        carrier: { type: 'string', description: '택배사 (선택: CJ대한통운, 우체국택배, 한진택배, 롯데택배, 로젠택배, 쿠팡, 경동택배 등). 없으면 자릿수로 추정한다' },
        events: { type: 'number', description: '보여줄 최근 이력 개수(기본 8, 최대 20)' },
      },
      required: ['number'],
    },
  },
  {
    name: 'watch_parcel',
    description:
      '택배를 등록해 두면 서버가 15~30분마다 스스로 조회해서 **단계가 바뀔 때만** 채팅으로 알려 주고 푸시를 보낸다(AI를 부르지 않아 토큰을 쓰지 않는다). ' +
      '배송이 완료되면 자동으로 멈춘다. "택배 오면 알려줘", "배송 상태 바뀌면 알려줘", "추적해 둬" 같은 요청에 add를 쓴다. list는 추적 중인 목록, remove는 중지.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'add=등록(기본), list=목록, remove=중지' },
        number: { type: 'string', description: '운송장 번호 (add·remove)' },
        carrier: { type: 'string', description: '택배사 이름 (선택)' },
        label: { type: 'string', description: '알아보기 쉬운 별칭 — 예: "무선 이어폰", "생일 선물" (add)' },
        interval_min: { type: 'number', description: '확인 주기(분, 기본 20 · 최소 10 · 최대 360)' },
      },
    },
  },
  {
    name: 'get_market_quote',
    description:
      '환율·주식·코인의 현재 시세와 전일 대비 변동을 조회한다(API 키 불필요). ' +
      '"달러 환율 얼마야", "삼성전자 주가", "애플 주식", "비트코인 시세", "코스피" 같은 요청에 쓴다. ' +
      '쉼표로 여러 개를 한 번에 볼 수 있다(최대 5개). 가격은 조회 시점 기준이며 실제 체결가와 다를 수 있다.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '종목·통화쌍 (예: "USD/KRW", "JPY/KRW", "삼성전자", "AAPL", "TSLA", "코스피", "BTC", "이더리움"). 쉼표로 여러 개',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'dday_list',
    description:
      '등록된 D-Day·기념일·결제일과 남은 일수(D-14, D-Day, D+3)를 조회한다. "디데이 뭐 있어", "전역까지 며칠", "생일까지 얼마나 남았어" 같은 요청에 쓴다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dday_add',
    description:
      'D-Day(기념일·결제일·시험일 등)를 등록한다. "전역 2027년 2월 24일로 디데이 추가해줘", "생일 매년 반복으로 넣어줘" 같은 요청에 쓴다. ' +
      '날짜는 반드시 YYYY-MM-DD 형식으로 계산해 넣는다(오늘 날짜는 time_now로 확인). 매년 반복(생일·기념일·카드 결제일)이면 repeat_yearly를 true로 한다.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'D-Day 이름 (예: 전역, 엄마 생일, 카드 결제일)' },
        date: { type: 'string', description: '목표 날짜 YYYY-MM-DD' },
        repeat_yearly: { type: 'boolean', description: '매년 반복 여부(생일·기념일·결제일이면 true)' },
        notes: { type: 'string', description: '메모 (선택)' },
      },
      required: ['title', 'date'],
    },
  },
  {
    name: 'dday_delete',
    description: '등록한 D-Day를 삭제한다. "전역 디데이 지워줘"처럼 지울 때 쓴다. 이름 일부로도 찾는다.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '지울 D-Day 이름(일부) 또는 id' } },
      required: ['query'],
    },
  },
  {
    name: 'manage_docker',
    description:
      '같은 서버에서 도는 도커 컨테이너를 조회(ps)·상세 확인(inspect)·로그 보기(logs)·시작(start)·중지(stop)·재시작(restart)·일시정지/해제(pause/unpause)한다. ' +
      '**포몽 에이전트 자신의 컨테이너(pomong-agent, pomong-browser 등)는 조회·로그만 되고 중지·재시작은 서버가 원천 차단한다.** ' +
      '삭제(rm)·정리(prune)·강제 종료(kill)·명령 실행(exec)은 어떤 경우에도 할 수 없다. ' +
      '상태를 바꾸는 동작은 사용자가 이번 대화에서 명시적으로 부탁했을 때만 실행하고, 부탁하지 않았다면 먼저 물어본다.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['ps', 'inspect', 'logs', 'start', 'stop', 'restart', 'pause', 'unpause'],
          description: '동작 (기본 ps=목록)',
        },
        container: { type: 'string', description: '컨테이너 이름 또는 id (조회·상태 변경 시 필수)' },
        tail: { type: 'number', description: 'logs에서 볼 줄 수(기본 60, 최대 300)' },
      },
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
    name: 'chat_history_search',
    label: '과거 대화 검색',
    summary: '대화가 아무리 쌓여도 예전에 한 말·하던 작업을 다른 방까지 찾아 기억해요.',
    example: '저번에 내가 말한 배송지 기억나?',
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
  {
    name: 'mail_list',
    label: '메일 확인',
    summary: '네이버·지메일 메일함을 직접 읽어 새 메일·안 읽은 메일을 알려줘요(앱 비밀번호로 연결).',
    example: '새로 온 메일 있어?',
  },
  {
    name: 'mail_read',
    label: '메일 본문 읽기',
    summary: '메일 한 통의 본문을 읽고 요약하거나 답장 내용을 만들어요.',
    example: '그 견적 메일 내용 요약해줘',
  },
  {
    name: 'mail_search',
    label: '메일 검색',
    summary: '제목·보낸사람·본문으로 지난 메일을 찾아줘요.',
    example: '지난주에 온 배송 메일 찾아줘',
  },
  {
    name: 'mail_send',
    label: '메일 보내기',
    summary: '메일 초안을 만들고 확인 카드를 띄워요. 카드에서 보내기를 눌러야 실제로 발송돼요.',
    example: '거래처에 일정 변경 메일 보내줘',
  },
  {
    name: 'file_save',
    label: '결과물 파일 저장',
    summary: 'AI가 만든 글·표·코드를 파일로 저장해 파일함에 보관해요.',
    example: '오늘 정리한 내용을 파일로 저장해줘',
  },
  {
    name: 'generate_image',
    label: '이미지 생성',
    summary: '말로 설명한 그림을 만들어 채팅에 바로 보여 주고 파일함에 저장해요(설정한 Gemini 키 사용).',
    example: '겨울 카페 일러스트 그려줘',
  },
  {
    name: 'edit_image',
    label: '이미지 편집',
    summary: '올린 사진이나 방금 만든 그림을 배경·스타일·요소까지 고쳐요.',
    example: '이 사진 배경을 밤하늘로 바꿔줘',
  },
  {
    name: 'create_qr',
    label: 'QR 코드 만들기',
    summary: '링크·문구·와이파이 정보를 담은 스캔용 QR 이미지를 만들어요.',
    example: 'example.com 와이파이 QR 만들어줘',
  },
  {
    name: 'react_to_message',
    label: '말풍선 리액션',
    summary: '고맙거나 축하할 만한 순간에 내 말풍선에 이모지 하나를 조용히 달아 줘요(남발하지 않아요).',
    example: '(도구가 알아서 판단해요)',
  },
  {
    name: 'track_parcel',
    label: '택배 배송 조회',
    summary: '송장번호로 배송 상태·위치·이동 이력을 바로 확인해요(API 키 불필요).',
    example: '내 택배 어디쯤이야? 운송장 1234567890',
  },
  {
    name: 'watch_parcel',
    label: '택배 변동 알림',
    summary: '택배를 등록해 두면 15~30분마다 스스로 조회해 단계가 바뀔 때만 알려줘요(배송 완료 시 자동 종료).',
    example: '이 택배 오면 알려줘',
  },
  {
    name: 'get_market_quote',
    label: '환율 · 주식 · 코인 시세',
    summary: '환율·국내외 주식·코인의 현재가와 전일 대비를 키 없이 조회해요.',
    example: '달러 환율이랑 삼성전자 주가 알려줘',
  },
  {
    name: 'dday_list',
    label: 'D-Day 목록',
    summary: '등록한 기념일·결제일과 남은 일수(D-14, D-Day, D+3)를 보여줘요.',
    example: '디데이 뭐 등록돼 있어?',
  },
  {
    name: 'dday_add',
    label: 'D-Day 등록',
    summary: '기념일·결제일·시험일을 등록해요. 매년 반복도 가능해요.',
    example: '생일 3월 26일 매년으로 등록해줘',
  },
  {
    name: 'dday_delete',
    label: 'D-Day 삭제',
    summary: '등록한 D-Day를 이름으로 찾아 지워요.',
    example: '전역 디데이 지워줘',
  },
  {
    name: 'manage_docker',
    label: '도커 컨테이너 관리',
    summary: '같은 서버의 다른 컨테이너를 조회·로그·재시작해요. 포몽 자신의 컨테이너는 제어가 차단돼요.',
    example: '도커 컨테이너 뭐 도는지 보여줘',
  },
];

/**
 * v0.6.6: 도구 관리자('더보기 → 도구(스킬) 관리')에 쓰는 이름표.
 * 카탈로그에 설명이 있는 도구는 그 라벨을 쓰고, 나머지는 여기서 채운다.
 */
export const TOOL_LABELS: Record<string, string> = {
  ...Object.fromEntries(TOOL_CATALOG.map((entry) => [entry.name, entry.label])),
  chat_notify: '중간 안내 말풍선',
  memory_search: '기억 검색',
  memory_delete: '기억 삭제',
  browser_snapshot: '화면 읽기',
  browser_click: '클릭',
  browser_type: '입력',
  browser_extract: '글자 추출',
  browser_screenshot: '스크린샷',
  browser_close: '브라우저 닫기',
  browser_fill_vault: '금고 비밀번호 채우기',
  automation_list: '예약·감시 목록',
  attachment_read: '첨부 다시 읽기',
  track_parcel: '택배 배송 조회',
  watch_parcel: '택배 변동 알림',
  get_market_quote: '시세 조회',
  dday_list: 'D-Day 목록',
  dday_add: 'D-Day 등록',
  dday_delete: 'D-Day 삭제',
  manage_docker: '도커 관리',
};

export interface ToolResult {
  content: string;
  meta?: 'tasks' | 'server_stats' | 'browser';
  /**
   * v0.5.3: 서버가 턴을 마무리할 때 쓰는 신호.
   * (가벼운 모델이 로그인 카드 도구를 빠뜨렸는지 서버가 판단한다)
   */
  flags?: {
    /** 금고에 그 서비스 계정이 없었다 */
    vaultEmpty?: boolean;
    /** 이번 실행에서 채팅 로그인 카드를 만들었다 */
    loginCardCreated?: boolean;
    /** v0.5.4: 금고 PIN 입력 카드를 채팅에 띄웠다 */
    vaultLockedCardCreated?: boolean;
    /** v0.6.1: 금고에 그 사이트 계정이 이미 있어 로그인 카드를 만들지 않았다 */
    vaultHasAccount?: boolean;
    /** v0.6.1: 사이트가 이미 로그인된 상태였다 */
    alreadyLoggedIn?: boolean;
    /** v0.6.3: 발송 확인 카드로 띄운 메일 초안 id */
    mailDraftId?: string;
    /** v0.6.15: 이번 턴에 만든 그림 첨부 id — 답변 말풍선에 붙인다 */
    images?: string[];
  };
}

export interface ToolContext {
  /** 채팅 세션 id (로그인 카드를 그 세션 화면에 붙인다) */
  session?: string;
  /** v0.6.1: 이번 턴에 사용자가 실제로 보낸 문장(전송·답장을 직접 부탁했는지 판단) */
  userRequest?: string;
}

/**
 * 금고가 잠겨 있을 때의 공통 응답 (v0.5.4)
 *
 * 말로만 "금고 탭에서 PIN을 푸세요"라고 하면 사용자가 다른 화면으로 가야 했다.
 * 이제 채팅에 PIN 입력 카드를 띄우고, PIN이 맞으면 서버가 잠금을 풀고
 * 이어서 AI가 하던 로그인/입력을 계속한다.
 */
function lockedVaultResponse(
  ctx: ToolContext,
  input: { tool: string; vaultId?: string; field?: string; ref?: string; service?: string; loginUrl?: string; note?: string }
): ToolResult {
  if (!vault.vaultConfigured()) {
    return {
      content:
        '금고가 아직 만들어지지 않았습니다. 사용자에게 "금고를 먼저 만들어 주세요"라고 말로만 안내하지 말고, vault_request_login으로 채팅 로그인 카드를 띄우세요. 카드에서 아이디·비밀번호와 새 PIN을 함께 받으면 금고가 만들어지고 바로 로그인합니다.',
    };
  }
  const intent = JSON.stringify({
    tool: input.tool,
    vaultId: input.vaultId ?? null,
    field: input.field ?? null,
    ref: input.ref ?? null,
  });
  const card = vaultUnlock.create({
    sessionId: ctx.session || 'default',
    service: input.service ?? null,
    loginUrl: input.loginUrl ?? null,
    vaultId: input.vaultId ?? null,
    intent,
    note: input.note ?? '금고가 잠겨 있어 자동 입력을 시작하지 못했습니다.',
  });
  return {
    content:
      `채팅 화면에 금고 PIN 입력 카드를 띄웠습니다(id: ${card.id}). 지금 멈추고 사용자에게 "아래 카드에 금고 PIN을 입력해 주시면 바로 이어서 로그인할게요!"라고 안내하며 답변을 마치세요. ` +
      '사용자가 PIN을 넣으면 서버가 잠금을 풀고 자동으로 후속 작업을 이어갑니다. PIN을 직접 물어보거나 추측하지 마세요.',
    flags: { vaultLockedCardCreated: true },
  };
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
  // v0.6.0: 브라우저 조작은 한 번에 하나만 실행한다(에이전트·예약·사람 입력이 겹치지 않게).
  if (name.startsWith('browser_')) {
    return browser.withBrowserLock(name, () => runToolInner(name, args, ctx));
  }
  return runToolInner(name, args, ctx);
}

async function runToolInner(name: string, args: Record<string, unknown>, ctx: ToolContext = {}): Promise<ToolResult> {
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
        return lockedVaultResponse(ctx, {
          tool: 'vault_list',
          note: '금고 목록을 보려면 PIN이 필요합니다.',
        });
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
        const result = await browser.click({
          ref: args.ref ? String(args.ref) : undefined,
          text: args.text ? String(args.text) : undefined,
          userRequest: ctx.userRequest,
        });
        return { content: result.snapshot, meta: 'browser' };
      } catch (err) {
        return { content: `누르지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'browser_type': {
      // v0.5.4: `[금고...]` 같은 자리표시자를 타이핑하려 하면 즉시 막고 올바른 도구를 알려 준다.
      const typedText = String(args.text || '');
      if (/[\[【]\s*(금고|vault|저장된|보관된|saved)/i.test(typedText) || /^\s*[\[【][^\]】]*[\]】]\s*$/.test(typedText)) {
        return {
          content:
            '[차단] 대괄호로 감싼 임시 문구(예: [금고의 비밀번호])는 입력할 수 없습니다. 실제 값은 네가 알 필요도, 타이핑할 필요도 없습니다. ' +
            '아이디·비밀번호를 한 번에 넣으려면 browser_login_with_vault(vault_id), 한 칸만 채우려면 browser_fill_vault(vault_id, field, ref)를 쓰세요. ' +
            'vault_id를 모르면 vault_find_for_site(site_or_service)로 먼저 찾으세요.',
        };
      }
      try {
        const result = await browser.typeInto({
          ref: args.ref ? String(args.ref) : undefined,
          text: String(args.text || ''),
          // v0.6.1: 모델이 pressEnter / submit 어느 쪽으로 불러도 Enter까지 누르게 맞춘다.
          submit: Boolean(args.submit ?? args.pressEnter),
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
    case 'chat_history_search': {
      const query = String(args.query || '').trim();
      if (!query) return { content: '무엇을 찾을지 알려 주세요. 예) "무신사 로그인", "생일", "배포 규칙"' };
      try {
        const limit = Number(args.limit) || 8;
        const result = history.searchChatHistory(query, {
          session: args.session ? String(args.session) : null,
          limit,
        });
        return { content: history.formatHistory(result) };
      } catch (err) {
        return { content: `과거 대화를 찾지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
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
      /**
       * v0.6.18: 브라우저에 그 사이트 로그인 세션(쿠키)이 남아 있으면
       * 금고 계정이 없다는 이유로 로그인 카드를 먼저 띄우지 않는다.
       */
      const knownService = findServiceInText(term);
      const session = browser.sessionCookieState(knownService ? knownService.match : [term]);
      const sessionLine =
        session.state === 'logged_in'
          ? `\n[로그인 세션] 브라우저에 ${session.host} 로그인 쿠키가 살아 있습니다(${
              session.expiresAt ? `만료 ${session.expiresAt.slice(0, 10)}` : '세션 쿠키'
            }). 로그인 페이지를 먼저 열지 말고, 사용자가 말한 목적지 페이지(메시지함·마이페이지 등)를 browser_open으로 바로 열어 로그인 상태를 확인하세요. 이미 로그인돼 있으면 로그인 도구를 부르지 마세요.`
          : '';
      if (!matches.length) {
        // v0.5.3: 카드 도구를 빼먹고 "직접 하세요"로 끝내는 일을 막는다(첫 줄에 필수 행동).
        const service = knownService;
        const catalog = service
          ? `\n\n[서비스 카탈로그] ${service.name} · login_url=${service.loginUrl}${service.note ? ` · ${service.note}` : ''}${
              service.loginNote ? `\n[로그인 화면 특이사항] ${service.loginNote}` : ''
            }`
          : '\n\n[서비스 카탈로그] 일치하는 서비스를 찾지 못했습니다. login_url은 사용자가 말한 사이트의 실제 로그인 주소를 쓰세요.';
        if (session.state === 'logged_in') {
          return {
            content:
              `금고에는 '${term}' 계정이 없지만 브라우저에 이 사이트 로그인 세션이 남아 있습니다.${sessionLine}\n` +
              `그러니 vault_request_login(로그인 카드)을 만들지 말고, 먼저 사용자가 말한 목적지 페이지를 browser_open으로 열어 로그인 상태를 확인하세요. 화면에 로그인 버튼만 있고 마이페이지·메시지함 같은 흔적이 없어 로그인 화면이면 그때만 vault_request_login으로 카드를 띄웁니다.${catalog}`,
          };
        }
        return {
          content:
            `[필수] vault_request_login 도구를 지금 호출하세요. 이것 없이 답변을 끝내면 사용자 화면에는 로그인 카드가 뜨지 않습니다.\n` +
            `금고에 '${term}' 계정이 없습니다. 사용자에게 직접 하라고 안내하지 말고, vault_request_login(service, login_url)으로 채팅에 로그인 카드를 띄운 뒤 "아래 카드에 계정 정보를 입력해 주시면 제가 바로 로그인해 드릴게요!"라고 답하세요.${sessionLine}${catalog}`,
          flags: { vaultEmpty: true },
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
        content: `금고에서 '${term}' 계정 ${matches.length}개를 찾았습니다(비밀번호는 표시하지 않음):\n${lines.join('\n')}\n입력은 browser_fill_vault(vault_id, field, ref)로 서버가 직접 합니다.${sessionLine}${hint}`,
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
      /**
       * v0.6.1: 금고에 그 사이트 계정이 이미 있는데 로그인 카드까지 띄워
       * 금고 PIN 카드와 둘 다 나오던 문제(IMG_3605)를 막는다.
       * 계정이 있으면 새 로그인 카드를 만들지 않고, 잠겨 있을 때는 PIN 해제 카드만 띄운다.
       * (사용자가 "새 계정 추가"를 직접 부탁한 경우만 예외)
       */
      const wantsNewAccount = /(새\s*계정|다른\s*계정|계정\s*추가|추가\s*등록|새로\s*(등록|추가))/.test(ctx.userRequest || '');
      /**
       * v0.6.18: 브라우저에 그 사이트 로그인 세션이 살아 있으면 로그인 카드를 띄우지 않는다.
       * (목적지 페이지를 먼저 열어 보라는 지침과 함께) — 불필요한 재로그인 방지.
       */
      if (!wantsNewAccount) {
        const entry = findServiceInText(service);
        const session = browser.sessionCookieState(entry ? entry.match : [siteHost || service]);
        if (session.state === 'logged_in') {
          return {
            content:
              `로그인 카드를 만들지 않았습니다. 브라우저에 ${session.host} 로그인 세션이 살아 있습니다. ` +
              `사용자가 말한 목적지 페이지를 browser_open으로 먼저 열어 로그인 상태를 확인하고, 로그인 화면일 때만 다시 요청하세요.`,
          };
        }
      }
      if (!wantsNewAccount) {
        const host = siteHost || (() => {
          try {
            return new URL(loginUrl).host;
          } catch {
            return '';
          }
        })();
        const catalogName = findServiceInText(service)?.name || '';
        const account =
          [service, host, catalogName]
            .filter(Boolean)
            .map((term) => vault.findForSite(String(term)).find((m) => m.type === 'login'))
            .find(Boolean) || null;
        if (account) {
          if (!vault.vaultUnlocked()) {
            return lockedVaultResponse(ctx, {
              tool: 'browser_login_with_vault',
              vaultId: account.id,
              service,
              loginUrl,
              note: `금고에 '${account.title}' 계정이 이미 저장돼 있습니다. 새 계정을 받을 필요 없이 금고 PIN만 풀면 바로 로그인할 수 있습니다.`,
            });
          }
          return {
            content:
              `로그인 카드를 만들지 않았습니다. 금고에 '${account.title}' 계정이 이미 있습니다(id: ${account.id}). ` +
              `먼저 사용자가 말한 목적지 페이지(예: 메시지함·마이페이지)를 browser_open으로 열어 이미 로그인돼 있는지 확인하고, 로그인 화면일 때만 browser_login_with_vault(vault_id: ${account.id})를 부르세요.`,
            flags: { vaultHasAccount: true },
          };
        }
      }
      // 이미 대기 중인 같은 서비스 카드가 있으면 새로 만들지 않고 그것을 안내한다.
      const open = loginRequests
        .listForSession(ctx.session || 'default')
        .find((r) => r.status === 'pending' && r.service.toLowerCase() === service.toLowerCase());
      const card = open ||
        loginRequests.create({ sessionId: ctx.session || 'default', service, loginUrl, siteHost, note: noteText });
      return {
        content: `채팅 화면에 '${service}' 로그인 카드를 띄웠습니다(id: ${card.id}). 이제 브라우저를 열지 말고 사용자에게 "아래 카드에 계정 정보를 입력해 주시면 제가 바로 로그인해 드릴게요!"라고 안내하며 답변을 마치세요. 사용자가 카드를 저장하면 자동으로 이어서 로그인합니다.`,
        flags: { loginCardCreated: true },
      };
    }
    case 'browser_fill_vault': {
      const vaultId = String(args.vault_id || '');
      const field = String(args.field || '') === 'password' ? 'password' : 'username';
      const ref = String(args.ref || '');
      if (!vaultId || !ref) return { content: '금고 항목 id와 입력창 ref가 필요합니다.' };
      /**
       * v0.6.18: 지금 화면이 이미 로그인된 상태(로그인 버튼·비밀번호 칸 없이
       * 마이페이지·로그아웃·메시지함이 보임)면 금고 값을 채우지 않는다.
       */
      const state = await browser.currentLoginState();
      if (state?.loggedIn) {
        return {
          content: `이미 로그인된 상태입니다(${state.title || state.url})${
            state.hints.length ? ` · 화면 근거: ${state.hints.join(', ')}` : ''
          }. 금고 값을 채우지 않았습니다. 로그인을 다시 시도하지 말고 사용자가 요청한 작업을 바로 이어서 하세요.`,
          flags: { alreadyLoggedIn: true },
        };
      }
      try {
        const values = vault.secretForFill(vaultId);
        const value = field === 'password' ? values.secret : values.username;
        if (!value) return { content: `이 항목에는 ${field === 'password' ? '비밀번호' : '아이디'}가 저장되어 있지 않습니다.` };
        const result = await browser.fillFromVault(ref, value, field, { submit: Boolean(args.submit) });
        return { content: `${field === 'password' ? '비밀번호' : '아이디'}를 금고에서 채웠습니다(값은 기록하지 않음).${args.submit ? ' Enter로 전송했습니다.' : ''}\n\n${result.snapshot}`, meta: 'browser' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('잠겨')) {
          return lockedVaultResponse(ctx, {
            tool: 'browser_fill_vault',
            vaultId,
            field,
            ref,
            note: '금고가 잠겨 있어 자동 입력을 시작하지 못했습니다.',
          });
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
        // v0.6.1: 이미 로그인된 사이트 — 로그인을 반복하지 말고 하던 일로 돌아가게 한다.
        if (result.alreadyLoggedIn) {
          return {
            content: `이미 로그인된 상태입니다(${result.title || result.url})${
              result.loginHints.length ? ` · 화면 근거: ${result.loginHints.join(', ')}` : ''
            }. 로그인 과정을 건너뛰었으니 다시 로그인하지 말고, 사용자가 요청한 작업(메시지함 이동·답장 등)을 바로 이어서 하세요.\n\n${result.snapshot}`,
            meta: 'browser',
            flags: { alreadyLoggedIn: true },
          };
        }
        const done = `아이디 ${result.filledUsername ? '입력 완료' : '칸을 찾지 못해 건너뜀'} · 비밀번호 입력 완료 · ${
          result.submitted === 'click'
            ? '로그인 버튼 클릭'
            : result.submitted === 'form'
              ? '폼 전송'
              : result.submitted === 'enter'
                ? 'Enter로 전송'
                : '전송하지 않음'
        }${result.steps === 'two_step' ? ' · 2단계 로그인(아이디 → 다음 → 비밀번호) 자동 진행' : ''}${
          result.submitReady ? '' : ' · 로그인 버튼이 잠겨 있었음'
        } (값은 기록하지 않음).`;
        const noticeLine = result.notice ? `\n\n※ 화면에 이렇게 적혀 있습니다: "${result.notice}"` : '';
        const diag = result.stillOnLogin
          ? `\n\n[화면 구조] 입력칸 ${result.diagnostics.inputs.length}개 · 폼 ${result.diagnostics.formCount}개 · 버튼 ${result.diagnostics.buttons
              .slice(0, 5)
              .map((b) => `${b.text || '?'}${b.disabled ? '(잠김)' : ''}`)
              .join(', ')}`
          : '';
        const next = result.stillOnLogin
          ? result.blocked
            ? `\n\n※ 자동으로 더 진행할 수 없습니다(사유: ${browser.LOGIN_BLOCK_LABELS[result.blocked]}). ${
                result.handoverOpened
                  ? '서버가 화면을 사용자에게 자동으로 넘겼습니다 — 사용자는 브라우저 탭의 전체화면 화면에서 인증을 마치면 됩니다. 사용자에게 "브라우저 화면에서 인증을 마쳐 주세요"라고 안내하고, 같은 도구를 다시 부르지 마세요.'
                  : 'browser_handover(reason: ...)로 화면을 넘기고, 같은 도구를 다시 부르지 마세요.'
              }`
            : '\n\n※ 아직 로그인 화면으로 보입니다. 아이디·비밀번호가 틀렸거나 인증번호(OTP)·캡차·2단계 인증일 수 있습니다. 화면에 인증번호·캡차가 있으면 browser_handover로 사용자에게 넘기고, 그냥 로그인 실패 문구라면 사용자에게 금고의 계정 정보를 확인해 달라고 알려 주세요.'
          : '\n\n※ 로그인 화면을 벗어났습니다. 이어서 하려던 일을 계속하세요.';
        return { content: `${done}${noticeLine}${diag}${next}\n\n${result.snapshot}`, meta: 'browser' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('잠겨')) {
          return lockedVaultResponse(ctx, {
            tool: 'browser_login_with_vault',
            vaultId,
            note: '금고가 잠겨 있어 자동 로그인을 시작하지 못했습니다.',
          });
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
    case 'file_save': {
      const name = String(args.name || '').trim();
      if (!name) return { content: '저장할 파일 이름이 필요합니다.' };
      const base64 = typeof args.content_base64 === 'string' ? args.content_base64.trim() : '';
      const text = typeof args.content === 'string' ? args.content : '';
      let data: Buffer;
      if (base64) {
        const cleaned = base64.replace(/^data:[^;]+;base64,/, '');
        data = Buffer.from(cleaned, 'base64');
      } else if (text.trim()) {
        data = Buffer.from(text, 'utf8');
      } else {
        return { content: '저장할 내용이 비어 있습니다. content에 글을 담아 주세요.' };
      }
      try {
        const saved = files.saveFile({
          name,
          data,
          source: 'agent',
          mime: args.mime ? String(args.mime) : undefined,
          sessionId: ctx.session || null,
        });
        return {
          content: `파일함에 저장했습니다: ${saved.name} (${saved.size < 1024 ? `${saved.size}B` : `${(saved.size / 1024).toFixed(1)}KB`}). 주소 ${saved.downloadUrl} — 사용자에게 "파일함(/files)에서 다시 열거나 내려받을 수 있어요"라고 알려 주세요.`,
        };
      } catch (err) {
        return { content: `파일을 저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    /* ------------------ v0.6.3: 이메일(IMAP/SMTP) ------------------ */
    case 'mail_list': {
      if (!mail.hasAccounts()) return { content: mailNotConnectedMessage() };
      try {
        const accountId = resolveMailAccount(args.account);
        const result = await mail.listMessages({
          accountId,
          unreadOnly: Boolean(args.unread_only),
          limit: Number(args.limit) || 10,
        });
        if (!result.messages.length) {
          return {
            content: args.unread_only
              ? `${result.account} 메일함에 안 읽은 메일이 없습니다.`
              : `${result.account} 메일함이 비어 있습니다.`,
          };
        }
        const lines = result.messages.map((m, i) =>
          `${i + 1}. [uid ${m.uid}] ${m.seen ? '' : '(안 읽음) '}${m.subject}\n   · 보낸사람: ${m.fromName} <${m.from}> · ${formatMailDate(m.date)}`
        );
        return {
          content: `${result.account} 메일함 · 최근 ${result.messages.length}통\n${lines.join('\n')}\n\n본문은 mail_read(uid)로 읽으세요.`,
        };
      } catch (err) {
        return { content: `메일함을 열지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'mail_read': {
      if (!mail.hasAccounts()) return { content: mailNotConnectedMessage() };
      const uid = Number(args.uid);
      if (!Number.isFinite(uid) || uid <= 0) return { content: '메일 uid가 필요합니다. mail_list 결과의 uid를 넣어 주세요.' };
      try {
        const message = await mail.readMessage(uid, resolveMailAccount(args.account));
        const body = (message.text || mail.htmlToText(message.html) || '(본문 없음)').slice(0, 8000);
        const attach = message.attachments.length
          ? `\n\n[첨부] ${message.attachments.map((a) => `${a.filename} (${a.contentType}, ${Math.round(a.size / 1024)}KB)`).join(', ')}`
          : '';
        return {
          content: `<mail uid="${message.uid}">\n보낸사람: ${message.fromName} <${message.from}>\n받는사람: ${message.to.join(', ')}\n날짜: ${formatMailDate(message.date)}\n제목: ${message.subject}\n\n${body}${attach}\n</mail>`,
        };
      } catch (err) {
        return { content: `메일을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'mail_search': {
      if (!mail.hasAccounts()) return { content: mailNotConnectedMessage() };
      const query = String(args.query || '').trim();
      if (!query) return { content: '검색어를 입력해 주세요.' };
      try {
        const result = await mail.searchMessages(query, {
          accountId: resolveMailAccount(args.account),
          limit: Number(args.limit) || 10,
        });
        if (!result.messages.length) return { content: `'${query}'로 찾은 메일이 없습니다.` };
        const lines = result.messages.map(
          (m, i) => `${i + 1}. [uid ${m.uid}] ${m.subject}\n   · ${m.fromName} <${m.from}> · ${formatMailDate(m.date)}`
        );
        return { content: `'${query}' 검색 결과 ${result.messages.length}통\n${lines.join('\n')}` };
      } catch (err) {
        return { content: `메일을 검색하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'mail_send': {
      if (!mail.hasAccounts()) return { content: mailNotConnectedMessage() };
      try {
        const draft = mail.createDraft({
          to: args.to,
          subject: args.subject,
          text: args.body,
          cc: args.cc,
          accountId: resolveMailAccount(args.account),
          session: ctx.session || null,
        });
        return {
          content: `메일 초안을 만들었습니다. **아직 보내지 않았습니다.**\n받는 사람: ${draft.to.join(', ')}\n제목: ${draft.subject}\n본문: ${draft.text.slice(0, 400)}${draft.text.length > 400 ? '…' : ''}\n\n사용자에게 "아래 카드에서 내용을 확인하고 보내기를 눌러 주세요"라고 알려 주세요. 발송은 사용자가 카드에서 확인해야만 이뤄집니다.`,
          flags: { mailDraftId: draft.id },
        };
      } catch (err) {
        return { content: `메일 초안을 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    /* --------------- v0.6.15: 그림 생성·편집 · QR · 리액션 --------------- */
    case 'generate_image': {
      const result = await images.generateImageTool({
        sessionId: ctx.session || 'default',
        prompt: String(args.prompt || ''),
        aspectRatio: String(args.aspect_ratio || '') || undefined,
        model: String(args.model || '') || undefined,
      });
      return {
        content: result.content,
        ...(result.attachmentIds?.length ? { flags: { images: result.attachmentIds } } : {}),
      };
    }
    case 'edit_image': {
      const result = await images.editImageTool({
        sessionId: ctx.session || 'default',
        instruction: String(args.instruction || ''),
        sourceImageId: String(args.source_image_id || '') || undefined,
        aspectRatio: String(args.aspect_ratio || '') || undefined,
      });
      return {
        content: result.content,
        ...(result.attachmentIds?.length ? { flags: { images: result.attachmentIds } } : {}),
      };
    }
    case 'create_qr': {
      const result = await images.createQrTool({
        sessionId: ctx.session || 'default',
        text: String(args.text || ''),
        url: String(args.url || ''),
        kind: String(args.kind || 'auto'),
        wifiSsid: String(args.wifi_ssid || ''),
        wifiPassword: String(args.wifi_password || ''),
        wifiSecurity: String(args.wifi_security || ''),
        wifiHidden: Boolean(args.wifi_hidden),
        size: Number(args.size) || undefined,
      });
      return {
        content: result.content,
        ...(result.attachmentIds?.length ? { flags: { images: result.attachmentIds } } : {}),
      };
    }
    case 'react_to_message': {
      const session = ctx.session || 'default';
      const target = reactions.resolveTarget(session, { messageId: args.message_id, query: args.query });
      if ('error' in target) return { content: target.error };
      const added = reactions.addReaction({ sessionId: session, messageId: target.row.id, emoji: args.emoji });
      if (!added.ok) return { content: added.error || '리액션을 달지 못했습니다.' };
      publish({
        type: 'chat_reaction',
        title: '리액션',
        body: '',
        data: {
          session,
          messageId: target.row.id,
          emoji: added.emoji,
          reactions: added.reactions || [],
        },
      });
      return {
        content:
          `${target.row.id}번 말풍선에 ${added.emoji} 리액션을 달았습니다(지금: ${(added.reactions || []).join(' ')}). ` +
          '사용자에게 리액션을 달았다고 길게 설명하지 말고, 하던 대화를 자연스럽게 이어가세요.',
      };
    }
    case 'track_parcel': {
      const result = await parcel.lookupParcel({ number: args.number, carrier: args.carrier });
      if (!result.ok) return { content: `배송 조회 실패 — ${result.reason}` };
      return { content: parcel.formatParcel(result, { events: Number(args.events) || 8 }) };
    }
    case 'watch_parcel': {
      const action = String(args.action || 'add').trim().toLowerCase();
      if (action === 'list') {
        const watches = parcelWatch.listParcelWatches();
        if (!watches.length) return { content: '추적 중인 택배가 없습니다. "이 택배 오면 알려줘"처럼 등록할 수 있습니다.' };
        return {
          content: [
            `택배 추적 ${watches.length}개`,
            ...watches.map((item) => {
              const state = item.stateLabel ? ` · 지금 ${item.stateLabel}` : ' · 아직 첫 확인 전';
              const cycle = item.enabled ? ` · ${item.intervalMin}분마다 확인` : ' · 추적 종료';
              return `- ${item.label} (${item.carrierLabel} ${item.trackingNumber})${state}${cycle}`;
            }),
          ].join('\n'),
        };
      }
      if (action === 'remove' || action === 'stop') {
        const removed = parcelWatch.stopParcelWatch(args.number || args.label || args.watch_id);
        if (removed.error) return { content: removed.error };
        return {
          content: `택배 추적을 멈췄습니다: ${removed.removed.map((item) => `${item.label} (${item.trackingNumber})`).join(', ')}`,
        };
      }
      if (action !== 'add') return { content: `지원하지 않는 동작입니다: ${action} (add · list · remove)` };
      const number = parcel.normalizeTrackingNumber(args.number);
      if (number.length < 8) return { content: '운송장 번호(숫자)를 다시 확인해 주세요. 8자리 이상이어야 합니다.' };
      const snapshot = await parcel.lookupParcel({ number, carrier: args.carrier });
      if (!snapshot.ok) return { content: `추적을 걸지 못했습니다 — ${snapshot.reason}` };
      if (snapshot.stateId === parcel.DELIVERED_STATE) {
        return {
          content: `이미 배송 완료된 택배입니다(마지막 ${parcel.stateLabel(snapshot.stateId, snapshot.stateText)}). 추적을 걸지 않았습니다.\n${parcel.formatParcel(snapshot, { events: 3 })}`,
        };
      }
      const created = parcelWatch.createParcelWatch({
        carrier: snapshot.carrierId,
        trackingNumber: number,
        label: String(args.label || snapshot.carrierLabel),
        sessionId: ctx.session || 'default',
        intervalMin: Number(args.interval_min) || undefined,
        snapshot,
      });
      if ('error' in created) return { content: created.error };
      return {
        content: [
          `📦 추적을 시작했습니다: ${created.label} (${created.carrierLabel} ${created.trackingNumber})`,
          `지금 상태: ${parcel.stateLabel(snapshot.stateId, snapshot.stateText)} · ${snapshot.lastLocation || '위치 미확인'}`,
          `${created.intervalMin}분마다 서버가 스스로 조회해서 **단계가 바뀌었을 때만** 채팅과 휴대폰 알림으로 알려 드립니다(AI를 부르지 않아 토큰을 쓰지 않습니다). 배송이 완료되면 자동으로 멈춥니다.`,
          '사용자에게 방금 등록한 사실과 알림 방식(단계가 바뀔 때만)을 짧게 알려 주세요.',
        ].join('\n'),
      };
    }
    case 'get_market_quote': {
      const result = await market.lookupQuotes(String(args.query || ''));
      if (!result.ok) return { content: `시세 조회 실패 — ${result.reason}` };
      return { content: market.formatQuotes(result) };
    }
    case 'dday_list': {
      const list = ddays.listDDays();
      if (!list.length) return { content: '등록된 D-Day가 없습니다. "전역 2027-02-24로 디데이 추가해줘"처럼 등록할 수 있습니다.' };
      return { content: `D-Day ${list.length}개\n${list.map((item) => `- ${ddays.ddayLine(item)}`).join('\n')}` };
    }
    case 'dday_add': {
      const result = ddays.createDDay({ title: args.title, date: args.date, repeatYearly: args.repeat_yearly, notes: args.notes });
      if (!result.ok) return { content: result.error };
      return { content: `D-Day를 등록했습니다: ${ddays.ddayLine(result.dday)}` };
    }
    case 'dday_delete': {
      const result = ddays.deleteDDay(args.query);
      if (result.error) return { content: result.error };
      return { content: `D-Day를 삭제했습니다: ${result.removed.map((item) => item.title).join(', ')}` };
    }
    case 'manage_docker': {
      return docker.manageDockerBehavior(
        { action: args.action, container: args.container, tail: args.tail },
        { userRequest: ctx.userRequest }
      );
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
