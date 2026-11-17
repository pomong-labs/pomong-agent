export type AgentState = 'idle' | 'thinking' | 'working' | 'responding' | 'error';

export interface AgentStatus {
  state: AgentState;
  detail: string;
  since: string;
  /** 진행 중인 요청이 시작된 시각 (탭을 옮겼다 돌아와도 경과를 표시할 수 있게) */
  startedAt: string | null;
  lastError: string | null;
}

const LABELS: Record<AgentState, string> = {
  idle: '대기 중',
  thinking: '생각 중',
  working: '작업 중',
  responding: '응답 중',
  error: '오류',
};

let current: AgentStatus = {
  state: 'idle',
  detail: '',
  since: new Date().toISOString(),
  startedAt: null,
  lastError: null,
};

export function setAgentState(state: AgentState, detail = ''): void {
  const now = new Date().toISOString();
  current = {
    ...current,
    state,
    detail,
    since: now,
    startedAt: state === 'idle' || state === 'error' ? null : current.startedAt || now,
    lastError: state === 'error' ? detail || current.lastError : null,
  };
}

export function getAgentStatus(): AgentStatus & { label: string } {
  // 오류 표시가 계속 남아 있지 않도록 5분이 지나면 대기 상태로 돌린다.
  if (current.state === 'error' && Date.now() - new Date(current.since).getTime() > 5 * 60 * 1000) {
    current = { ...current, state: 'idle', detail: '', since: new Date().toISOString(), startedAt: null };
  }
  return { ...current, label: LABELS[current.state] };
}

export function agentStateLabel(state: AgentState): string {
  return LABELS[state];
}
