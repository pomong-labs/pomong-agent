/**
 * v0.6.3 — 요청에 맞는 도구만 골라 넘기기(동적 도구 필터링)
 *
 * 도구가 40개를 넘어가면서 매 턴 모든 스키마를 모델에 보내면
 *   · 토큰을 많이 쓰고
 *   · 모델이 엉뚱한 도구를 고르는 일이 늘어난다.
 * 이번 요청의 의도(브라우저·메일·검색·기억·파일·자동화·서버·날씨)를 보고
 * 필요한 그룹만 남긴다. 판단이 서지 않으면(아무 의도도 안 잡히거나 너무 여럿이면)
 * 예전처럼 모든 도구를 넘긴다 — 기능이 사라지는 것보다 낫다.
 */

export type ToolGroup =
  | 'core'
  | 'browser'
  | 'mail'
  | 'web'
  | 'memory'
  | 'files'
  | 'automation'
  | 'server'
  | 'weather'
  | 'vault';

/** 어떤 요청에서도 필요한 최소 도구 */
export const CORE_TOOLS = [
  'chat_notify',
  'time_now',
  'memory_save',
  'memory_search',
  'tasks_list',
  'tasks_add',
  'tasks_complete',
];

export const TOOL_GROUPS: Record<ToolGroup, string[]> = {
  core: CORE_TOOLS,
  browser: [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_extract',
    'browser_screenshot',
    'browser_handover',
    'browser_close',
    'browser_fill_vault',
    'browser_login_with_vault',
    'vault_find_for_site',
    'vault_request_login',
  ],
  mail: ['mail_list', 'mail_read', 'mail_search', 'mail_send'],
  web: ['web_search'],
  memory: ['memory_delete', 'chat_history_search'],
  files: ['attachment_read', 'file_save'],
  automation: ['job_create', 'automation_list', 'watch_create'],
  server: ['server_stats'],
  weather: ['weather_get'],
  vault: ['vault_list'],
};

const INTENT_PATTERNS: { group: ToolGroup; re: RegExp }[] = [
  {
    group: 'browser',
    re: /(브라우저|사이트|홈페이지|웹페이지|로그인|로그아웃|클릭|입력창|장바구니|주문|결제|예매|좌석|접속|열어\s*(줘|봐|서)|재고|배송\s*(조회|상태)|회원가입|가입|업로드|다운로드|크롤링|스크래핑|깃허브|github|쿠팡|인스타|유튜브|디스코드|인증\s*번호|캡차)/i,
  },
  { group: 'mail', re: /(메일|이메일|메일함|받은\s*편지|보낸\s*편지|지메일|gmail|네이버\s*메일|inbox|답장\s*보내|메일\s*보내)/i },
  { group: 'web', re: /(검색|찾아\s*(줘|봐|보)|알아봐|최신|뉴스|가격|최저가|비교|추천|정보\s*좀|어디서\s*팔)/i },
  { group: 'memory', re: /(기억|저번|예전|지난번|잊어|기억나)/i },
  { group: 'files', re: /(첨부|파일|사진|이미지|pdf|문서|스크린샷)/i },
  { group: 'automation', re: /(예약\s*(실행|작업|만들)|매일|매주|매시간|자동화|스케줄|워치|감시|정기적|알림\s*만들)/i },
  { group: 'server', re: /(서버|cpu|램|ram|메모리|디스크|용량|관제|리소스|가동\s*시간)/i },
  { group: 'weather', re: /(날씨|기온|비\s*와|비가|눈이|우산|더워|추워|습도|미세먼지)/i },
  { group: 'vault', re: /(금고|비밀번호|계정\s*목록|아이디\s*뭐)/i },
];

export interface ToolFilterInput {
  userRequest: string;
  /** 이번 턴에 사진이 붙었는지 */
  hasImage?: boolean;
  /** 파일(문서)이 붙었는지 */
  hasFile?: boolean;
  /** 브라우저 작업이 이미 진행 중인 턴인지(이어서 하기) */
  browserActive?: boolean;
}

export interface ToolFilterResult {
  /** 모델에 넘길 도구 이름 목록. null 이면 전체 허용 */
  tools: string[] | null;
  groups: ToolGroup[];
  reason: 'intent' | 'broad' | 'all';
}

/** 의도를 감지해 필요한 도구 이름만 고른다(순수 함수). */
export function selectToolNames(input: ToolFilterInput): ToolFilterResult {
  const text = String(input.userRequest || '');
  const groups = new Set<ToolGroup>();
  for (const { group, re } of INTENT_PATTERNS) {
    if (re.test(text)) groups.add(group);
  }
  if (input.hasImage || input.hasFile || (input.userRequest || '').trim() === '') groups.add('files');
  if (input.browserActive) groups.add('browser');

  // 아무 의도도 안 잡히면(짧은 인사·잡담) 예전처럼 전체 허용 — 기능이 줄어들지 않게.
  if (groups.size === 0) return { tools: null, groups: [], reason: 'all' };
  // 여러 가지가 섞인 복합 요청은 넓게 — 필요한 도구를 빼먹는 쪽이 더 위험하다.
  if (groups.size >= 5) return { tools: null, groups: [...groups], reason: 'broad' };

  const names = new Set<string>(CORE_TOOLS);
  for (const group of groups) {
    for (const name of TOOL_GROUPS[group]) names.add(name);
  }
  return { tools: [...names], groups: [...groups], reason: 'intent' };
}
