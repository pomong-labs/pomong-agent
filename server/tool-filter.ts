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
  | 'image'
  | 'automation'
  | 'server'
  | 'weather'
  | 'vault'
  | 'parcel'
  | 'market'
  | 'dday'
  | 'docker';

/** 어떤 요청에서도 필요한 최소 도구 */
export const CORE_TOOLS = [
  'chat_notify',
  'time_now',
  'memory_save',
  'memory_search',
  // v0.6.19: 지침 본문을 매 턴 바로 꺼내 쓸 수 있게 늘 켜 둔다.
  'read_skill',
  // v0.7.1: 단계별 워크플로우 실행(사용자가 만든 도구를 이름으로 부를 때)
  'run_workflow',
  'tasks_list',
  'tasks_add',
  'tasks_complete',
  // v0.6.15: 자연스러운 순간에 말풍선 리액션을 달 수 있게 늘 켜 둔다.
  'react_to_message',
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
  // v0.6.15: 그림 생성·편집·QR(결과는 파일함에도 저장된다)
  image: ['generate_image', 'edit_image', 'create_qr'],
  automation: ['job_create', 'automation_list', 'watch_create'],
  server: ['server_stats'],
  weather: ['weather_get'],
  vault: ['vault_list'],
  // v0.6.16: 택배 조회·택배 변동 알림
  parcel: ['track_parcel', 'watch_parcel'],
  // v0.6.16: 환율·주식·코인 시세
  market: ['get_market_quote'],
  // v0.6.16: D-Day 카운터
  dday: ['dday_list', 'dday_add', 'dday_delete'],
  // v0.6.16: 도커 컨테이너 관리(포몽 자신은 제어 차단)
  docker: ['manage_docker'],
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
  {
    group: 'image',
    re: /((그림|그려|이미지|사진|로고|아이콘|일러스트|포스터|썸네일|배너|이모티콘)[\s\S]{0,12}(만들|생성|그려|바꿔|편집|수정|고쳐))|(만들|그려|바꿔|고쳐)[\s\S]{0,8}(그림|이미지)|qr\s*코드|큐알|qr|와이파이\s*(연결|qr)/i,
  },
  { group: 'automation', re: /(예약\s*(실행|작업|만들)|매일|매주|매시간|자동화|스케줄|워치|감시|정기적|알림\s*만들)/i },
  { group: 'server', re: /(서버|cpu|램|ram|메모리|디스크|용량|관제|리소스|가동\s*시간)/i },
  { group: 'weather', re: /(날씨|기온|비\s*와|비가|눈이|우산|더워|추워|습도|미세먼지)/i },
  { group: 'vault', re: /(금고|비밀번호|계정\s*목록|아이디\s*뭐)/i },
  {
    group: 'parcel',
    re: /(택\s*배|운송장|송장|배송\s*(조회|상태|상황|현황|추적|완료|출발|중)|집화|간선\s*(상차|하차)|택배사|cj\s*대한통운|대한통운|한진|롯데\s*택배|로젠|우체국|경동\s*택배|쿠팡\s*택배|포스트박스)/i,
  },
  {
    group: 'market',
    re: /(환율|달러|엔화|엔\s*시세|유로|위안|파운드|주가|주식|시세|코인|비트코인|이더리움|리플|도지|나스닥|코스피|코스닥|s&p|다우|니케이|종목|티커|증시)/i,
  },
  {
    group: 'dday',
    re: /(디\s*데이|d\s*-?\s*day|기념일|결제일|몇\s*일\s*남|며칠\s*남|남은\s*날|카운트\s*다운|전역까지|생일까지)/i,
  },
  { group: 'docker', re: /(도커|docker|컨테이너|compose)/i },
];

export interface ToolFilterInput {
  userRequest: string;
  /** 이번 턴에 사진이 붙었는지 */
  hasImage?: boolean;
  /** 파일(문서)이 붙었는지 */
  hasFile?: boolean;
  /** 브라우저 작업이 이미 진행 중인 턴인지(이어서 하기) */
  browserActive?: boolean;
  /**
   * v0.6.19: 이번 턴에 적용되는 사용자 지침(커스텀 스킬) 본문.
   * 지침이 브라우저·택배·시세 같은 도구를 요구하면 그 그룹도 함께 넘긴다.
   */
  skillText?: string;
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
  // v0.6.19: 사용자 지침도 같은 의도 분석에 넣는다.
  //  지침이 "택배 조회해서 알려줘" 같은 도구 사용을 요구하면 그 그룹이 빠지지 않게.
  const skillText = String(input.skillText || '').trim();
  const haystack = skillText ? `${text}\n${skillText}` : text;
  const groups = new Set<ToolGroup>();
  for (const { group, re } of INTENT_PATTERNS) {
    if (re.test(haystack)) groups.add(group);
  }
  if (input.hasImage || input.hasFile || (input.userRequest || '').trim() === '') groups.add('files');
  // 사진을 고쳐 달라는 요청이면 편집 도구까지 함께 넘긴다(첨부 id로 찾는다).
  if (groups.has('image')) groups.add('files');
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

/* ------------------------------------------------------------------ */
/* v0.6.6 — 기본 도구 ON/OFF (도구 관리자)                             */
/* ------------------------------------------------------------------ */

/** 도구 관리자 화면에 보여줄 그룹 */
export interface ToolGroupMeta {
  id: ToolGroup;
  label: string;
  desc: string;
  emoji: string;
}

export const TOOL_GROUP_META: ToolGroupMeta[] = [
  { id: 'core', label: '기본 대화', desc: '할 일·기억·알림처럼 대화 중 늘 쓰는 도구', emoji: '💬' },
  { id: 'browser', label: '브라우저', desc: '사이트 열기·클릭·입력·로그인 대행', emoji: '🌐' },
  { id: 'web', label: '웹 검색', desc: '최신 정보·가격·뉴스 찾아보기', emoji: '🔎' },
  { id: 'mail', label: '이메일', desc: '메일함 확인·검색·읽기·발송', emoji: '✉️' },
  { id: 'memory', label: '기억', desc: '오래된 대화·기억 검색과 정리', emoji: '🧠' },
  { id: 'files', label: '파일', desc: '첨부 읽기·결과물 저장', emoji: '📎' },
  { id: 'image', label: '이미지 · QR', desc: '그림 생성·편집, QR 코드 만들기', emoji: '🎨' },
  { id: 'automation', label: '자동화', desc: '예약 실행·변경 감시 만들기', emoji: '⏰' },
  { id: 'server', label: '서버 관제', desc: 'CPU·메모리·디스크 상태 보기', emoji: '🖥️' },
  { id: 'weather', label: '날씨', desc: '현재 날씨와 예보', emoji: '🌤️' },
  { id: 'vault', label: '금고', desc: '저장한 계정 이름 확인', emoji: '🔐' },
  { id: 'parcel', label: '택배', desc: '배송 조회·단계가 바뀔 때 알림', emoji: '📦' },
  { id: 'market', label: '시세', desc: '환율·주식·코인 현재가와 전일 대비', emoji: '💹' },
  { id: 'dday', label: '디데이', desc: '기념일·결제일·남은 날짜', emoji: '📅' },
  { id: 'docker', label: '도커', desc: '컨테이너 조회·로그·재시작 (포몽 자신 제외)', emoji: '🐳' },
];

export interface ToolPrefs {
  /** 통째로 끈 그룹 */
  disabledGroups: ToolGroup[];
  /** 그룹은 켜 둔 채 개별로 끈 도구 */
  disabledTools: string[];
}

export const DEFAULT_TOOL_PREFS: ToolPrefs = { disabledGroups: [], disabledTools: [] };

const ALL_TOOL_NAMES = new Set(Object.values(TOOL_GROUPS).flat());
const ALL_GROUPS = new Set<ToolGroup>(Object.keys(TOOL_GROUPS) as ToolGroup[]);

/** 저장된 설정(JSON)을 안전한 형태로 다듬는다. */
export function normalizeToolPrefs(value: unknown): ToolPrefs {
  const raw = (value ?? {}) as Partial<Record<keyof ToolPrefs, unknown>>;
  const groups = Array.isArray(raw.disabledGroups) ? raw.disabledGroups : [];
  const tools = Array.isArray(raw.disabledTools) ? raw.disabledTools : [];
  return {
    disabledGroups: [...new Set(groups.map((g) => String(g)).filter((g): g is ToolGroup => ALL_GROUPS.has(g as ToolGroup)))],
    disabledTools: [...new Set(tools.map((t) => String(t)).filter((t) => ALL_TOOL_NAMES.has(t)))],
  };
}

/** 설정에서 꺼진 도구 이름 (그룹을 끄면 그 그룹 도구 전부) */
export function disabledToolNames(prefs: ToolPrefs): Set<string> {
  const off = new Set<string>(prefs.disabledTools);
  for (const group of prefs.disabledGroups) {
    for (const name of TOOL_GROUPS[group]) off.add(name);
  }
  return off;
}

/** 모델에 넘길 도구 목록에서 꺼진 도구를 뺀다. */
export function filterToolsByPrefs<T extends { name: string }>(specs: T[], prefs: ToolPrefs): T[] {
  const off = disabledToolNames(prefs);
  if (off.size === 0) return specs;
  return specs.filter((spec) => !off.has(spec.name));
}
