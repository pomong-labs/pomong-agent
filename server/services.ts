import { db } from './db';
import { browserStateHosts } from './browser';

/**
 * 앱 및 서비스 연결 카탈로그 (v0.5.0)
 *
 * 금고에 그 서비스의 로그인 항목이 있거나, 브라우저 로그인 세션(browser-state.json)에
 * 그 도메인의 쿠키가 남아 있으면 '연결됨'으로 표시한다.
 * 각 카드의 "시킬 수 있는 일 예시"는 채팅 입력창에 그대로 들어간다.
 */

export type ServiceCategory = 'dev' | 'shopping' | 'life' | 'social';

export interface ServiceEntry {
  id: string;
  name: string;
  category: ServiceCategory;
  /** 금고 항목·브라우저 쿠키 매칭에 쓰는 도메인/이름 조각 */
  match: string[];
  loginUrl: string;
  tint: string;
  color: string;
  emoji: string;
  examples: string[];
  note?: string;
  /** v0.5.4: 이 사이트 로그인 화면의 실제 특이사항(자동 로그인 중 막힐 때 AI가 바로 판단하도록) */
  loginNote?: string;
}

export const SERVICE_CATEGORIES: { id: ServiceCategory | 'all'; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'dev', label: '개발·생산성' },
  { id: 'shopping', label: '쇼핑' },
  { id: 'life', label: '생활·여행' },
  { id: 'social', label: '메일·SNS' },
];

export const SERVICES: ServiceEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'dev',
    match: ['github', '깃허브'],
    loginUrl: 'https://github.com/login',
    tint: '#F1F3F8',
    color: '#1F2328',
    emoji: '🐙',
    examples: ['내 깃허브 레포 중에 마지막 커밋이 오래된 것 알려줘', 'khjkr/pomong-agent 열린 이슈 확인해줘', '이번 주 커밋 요약해줘'],
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'dev',
    match: ['notion', '노션'],
    loginUrl: 'https://www.notion.so/login',
    tint: '#F4F4F2',
    color: '#2F2F2B',
    emoji: '📓',
    examples: ['노션 포몽랩스 페이지에서 할 일 확인해줘', '통합 작업 보드에 새 카드 추가해줘', '이번 주 회의 메모 정리해줘'],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'social',
    match: ['gmail', '지메일', 'google', '구글'],
    loginUrl: 'https://accounts.google.com/',
    tint: '#FDEEEC',
    color: '#D9544D',
    emoji: '✉️',
    loginNote:
      '구글은 2단계 로그인입니다(아이디 입력 → 다음 → 비밀번호). 로그인 중 패스키·2단계 인증·\"이 브라우저를 기억하시겠습니까?\" 화면이 나오면 자동으로 끝낼 수 없으니 화면에 적힌 문구를 그대로 알려 주세요.',
    examples: ['안 읽은 메일 중요한 것만 알려줘', '이번 주에 온 영수증 메일 찾아줘', '메일 답장 초안 써줘'],
  },
  {
    id: 'naver',
    name: '네이버',
    category: 'social',
    match: ['naver', '네이버'],
    loginUrl: 'https://nid.naver.com/nidlogin.login',
    tint: '#EAF7EE',
    color: '#03C75A',
    emoji: '🟢',
    examples: ['네이버 메일에서 새 메일 확인해줘', '네이버 페이 결제 내역 확인해줘', '네이버 예약 확인해줘'],
  },
  {
    id: 'coupang',
    name: '쿠팡',
    category: 'shopping',
    match: ['coupang', '쿠팡'],
    loginUrl: 'https://login.coupang.com/login/login.pang',
    tint: '#FFF3EC',
    color: '#E86C2C',
    emoji: '📦',
    examples: ['내 쿠팡 주문 배송 상태 알려줘', '이 상품 재고 확인해줘', '장바구니에 뭐가 있는지 봐줘'],
  },
  {
    id: 'musinsa',
    name: '무신사',
    category: 'shopping',
    match: ['musinsa', '무신사'],
    loginUrl: 'https://member.one.musinsa.com/login',
    tint: '#F2F2F4',
    color: '#1C1C1E',
    emoji: '👕',
    loginNote:
      '무신사 로그인은 member.one.musinsa.com/login 의 React 화면입니다. 아이디·비밀번호 input이 숨은 필드(encryptMemberId/encryptPassword)와 reCAPTCHA(isCheckGoogleRecaptcha)를 함께 쓰므로, 로그인 버튼을 눌러도 화면이 그대로면 캡차·이메일 인증·비밀번호 오류를 먼저 의심하고 화면 문구를 사용자에게 그대로 전하세요.',
    examples: ['무신사 장바구니 확인해줘', '내 사이즈로 재입고된 무스탕 찾아줘', '주문한 옷 배송 조회해줘'],
  },
  {
    id: 'yanolja',
    name: '야놀자',
    category: 'life',
    match: ['yanolja', '야놀자'],
    loginUrl: 'https://www.yanolja.com/',
    tint: '#F3EEFF',
    color: '#7C63F6',
    emoji: '🏨',
    examples: ['이번 주말 인제 근처 숙소 가격 비교해줘', '내 야놀자 예약 확인해줘', '춘천 호텔 최저가 알려줘'],
  },
  {
    id: 'srt',
    name: 'SRT',
    category: 'life',
    match: ['srt', 'SR'],
    loginUrl: 'https://etk.srail.kr/',
    tint: '#EAF1FF',
    color: '#3A78D6',
    emoji: '🚄',
    examples: ['이번 주 금요일 익산→서울 SRT 표 알려줘', '내 SRT 예약 확인해줘', '다음 주 귀경 열차 시간표 봐줘'],
  },
  {
    id: 'catchtable',
    name: '캐치테이블',
    category: 'life',
    match: ['catchtable', '캐치테이블'],
    loginUrl: 'https://app.catchtable.co.kr/',
    tint: '#FFEFF3',
    color: '#F2568B',
    emoji: '🍽️',
    examples: ['이번 주말 저녁 예약 가능한 식당 찾아줘', '내 예약 확인해줘', '인제 맛집 예약 가능한 곳 알려줘'],
  },
  {
    id: 'kurly',
    name: '컬리',
    category: 'shopping',
    match: ['kurly', '컬리', '마켓컬리'],
    loginUrl: 'https://www.kurly.com/member/login',
    tint: '#F3EFFF',
    color: '#5F0080',
    emoji: '🥬',
    examples: ['컬리 장바구니 확인해줘', '이번 주 장보기 목록으로 주문할 만한 것 찾아줘', '주문한 상품 배송 상태 알려줘'],
  },
  {
    id: 'oliveyoung',
    name: '올리브영',
    category: 'shopping',
    match: ['oliveyoung', '올리브영'],
    loginUrl: 'https://www.oliveyoung.co.kr/store/member/loginForm.do',
    tint: '#EDF8EE',
    color: '#3FA34D',
    emoji: '🧴',
    examples: ['올리브영 세일 품목 알려줘', '내 장바구니 확인해줘', '이 제품 재고 있는 매장 찾아줘'],
  },
  {
    id: 'kmong',
    name: '크몽',
    category: 'dev',
    match: ['kmong', '크몽'],
    // v0.5.3: 크몽은 /login 전용 주소가 없어 404가 뜬다. 메인에서 로그인 버튼/모달로 들어간다.
    loginUrl: 'https://kmong.com/',
    tint: '#FFF4E5',
    color: '#E49B18',
    emoji: '💼',
    examples: ['크몽 새 메시지 확인해줘', '내 판매 통계 알려줘', '이번 주 주문 확인해줘'],
    note: '로그인 전용 주소(/login) 없음 — 메인 오른쪽 위 로그인 버튼으로 들어갑니다.',
    loginNote: '크몽은 헤더의 [로그인] 버튼을 누르면 모달이 열립니다. kmong.com/login 은 404이므로 열지 마세요. 로그인 후에는 휴대폰/이메일 인증이 나올 수 있습니다.',
  },
  {
    id: 'routenote',
    name: 'RouteNote',
    category: 'dev',
    match: ['routenote'],
    loginUrl: 'https://routenote.com/login',
    tint: '#EAF6FF',
    color: '#2F86D8',
    emoji: '🎵',
    examples: ['RouteNote 스트리밍 통계 알려줘', '이번 달 정산 금액 확인해줘', '발매 예정 음원 상태 봐줘'],
  },
];

export interface ServiceView extends ServiceEntry {
  connected: boolean;
  /** vault = 금고에 계정 저장됨, session = 브라우저 로그인 세션 있음 */
  via: ('vault' | 'session')[];
}

function lower(value: string | null | undefined): string {
  return String(value || '').toLowerCase();
}

/** 금고 제목·메모에서 서비스 이름/도메인을 찾는다(복호화 없음). */
function vaultMatches(): { haystack: string } {
  const rows = db.prepare('SELECT title, notes, username FROM vault_items').all() as {
    title: string;
    notes: string | null;
    username: string | null;
  }[];
  return { haystack: rows.map((r) => `${lower(r.title)} ${lower(r.notes)} ${lower(r.username)}`).join(' | ') };
}

export function listServices(): { services: ServiceView[]; connectedCount: number; categories: typeof SERVICE_CATEGORIES } {
  const vault = vaultMatches();
  const hosts = browserStateHosts().join(' ');
  const services = SERVICES.map((entry) => {
    const via: ('vault' | 'session')[] = [];
    const matchedVault = entry.match.some((m) => vault.haystack.includes(lower(m)));
    const matchedSession = entry.match.some((m) => m.length > 3 && hosts.includes(lower(m)));
    if (matchedVault) via.push('vault');
    if (matchedSession) via.push('session');
    return { ...entry, connected: via.length > 0, via };
  });
  return {
    services,
    connectedCount: services.filter((s) => s.connected).length,
    categories: SERVICE_CATEGORIES,
  };
}

export function findService(query: string): ServiceEntry | null {
  const q = lower(query).replace(/\s+/g, '');
  if (!q) return null;
  return (
    SERVICES.find((entry) => lower(entry.id) === q) ||
    SERVICES.find((entry) => entry.match.some((m) => q.includes(lower(m)) || lower(m).includes(q))) ||
    null
  );
}

/**
 * 문장(사용자 요청·AI 답변) 안에서 서비스를 찾는다 (v0.5.3).
 * 로그인 카드를 서버가 대신 띄울 때 서비스명·로그인 주소를 고르는 데 쓴다.
 */
export function findServiceInText(text: string): ServiceEntry | null {
  const haystack = lower(text);
  if (!haystack.trim()) return null;
  let best: { entry: ServiceEntry; length: number } | null = null;
  for (const entry of SERVICES) {
    for (const term of [entry.id, ...entry.match]) {
      const needle = lower(term);
      if (needle.length < 2 || !haystack.includes(needle)) continue;
      if (!best || needle.length > best.length) best = { entry, length: needle.length };
    }
  }
  return best ? best.entry : null;
}
