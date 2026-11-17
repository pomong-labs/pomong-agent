/**
 * UI 문자열 모음 (한국어 기본).
 * 언어 설정(v0.2)을 붙일 때 이 사전만 바꿔 끼우면 되도록 화면 문구를 한곳에 모아 둡니다.
 */
export const ko = {
  nav: {
    chat: '채팅',
    monitor: '관제실',
    vault: '금고',
    tasks: '할 일',
    settings: '설정',
    more: '더보기',
  },
  status: {
    online: '온라인',
    standby: '대기 중',
    healthy: '정상',
    warning: '주의',
    critical: '위험',
    checkNeeded: '점검 필요',
    loading: '불러오는 중',
    live: '실시간',
    connected: '연결됨',
  },
  common: {
    serverStatus: '서버 상태',
    cpu: 'CPU',
    ram: 'RAM',
    disk: '디스크',
    cores: '코어',
    load: '부하',
    back: '이전',
    next: '다음 단계',
    close: '닫기',
  },
} as const;

/** 현재 언어 사전 (v0.1.1은 한국어만) */
export const t = ko;
