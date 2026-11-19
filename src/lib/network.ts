import { ApiError } from './api';

/**
 * 네트워크 단절 판별 (v0.5.5)
 *
 * 아이폰에서 앱을 나가면 iOS가 진행 중인 fetch 연결을 끊는다. 그때 브라우저는
 * 보통 `TypeError: Load failed`(Safari), `Failed to fetch`(Chrome), `NetworkError`
 * 같은 예외를 던진다. 이건 **서버 오류가 아니라 화면 쪽 연결이 끊긴 것**이므로,
 * 오류 카드를 띄우지 않고 서버 작업을 이어서 지켜봐야 한다.
 *
 * 서버가 실제로 돌려준 JSON 오류(ApiError — API 키 오류·no_provider·5xx)는
 * 여기서 true가 아니므로 기존처럼 오류 카드로 보여 준다.
 */
const NETWORK_HINTS = [
  'load failed',
  'failed to fetch',
  'networkerror',
  'network error',
  'network request failed',
  'network connection was lost',
  'internet connection appears to be offline',
  'the network connection was lost',
  'fetch failed',
  'connection lost',
  'connection reset',
  'econnreset',
  'etimedout',
  'timed out',
  'aborted',
];

export function isNetworkError(err: unknown): boolean {
  if (!err || err instanceof ApiError) return false;
  const name = typeof (err as { name?: unknown })?.name === 'string' ? String((err as { name?: string }).name) : '';
  if (name === 'AbortError' || name === 'NetworkError' || name === 'TimeoutError') return true;
  const message = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').toLowerCase();
  if (!message.trim()) return false;
  return NETWORK_HINTS.some((hint) => message.includes(hint));
}

/** 서버가 아직 이 대화를 처리하고 있다고 볼 수 있는 상태 */
export function isBusyState(state: string | null | undefined): boolean {
  return state === 'thinking' || state === 'working' || state === 'responding';
}

/* ------------------------------------------------------------------ */
/* 끊긴 턴을 어떻게 마무리할지 결정 (v0.5.5)                             */
/* ------------------------------------------------------------------ */

export interface TurnProbe {
  /** 내가 보낸 뒤로 새 AI 답장이 DB에 생겼는가 */
  freshReply: boolean;
  /** 서버가 이 대화방의 턴을 아직 돌리고 있는가(/api/chat/running) */
  running: boolean;
  /** 서버 상태가 생각 중·작업 중·응답 중인가(/api/agent/status) */
  busy: boolean;
  /** 서버 상태가 진짜 오류인가(마지막 오류 문구) */
  agentError: string | null;
  /** 내 메시지가 서버에 저장돼 있는가 */
  delivered: boolean;
}

export type TurnDecision =
  /** 새 답장이 있다 → 화면에 붙이고 끝 */
  | 'reply'
  /** 서버가 아직 작업 중 → 진행 UI를 유지하고 계속 기다린다 */
  | 'wait'
  /** 서버가 실제 오류로 끝났다 → 오류 카드 */
  | 'error'
  /** 요청이 서버에 닿지 않았다 → 다시 보내도록 안내 */
  | 'lost'
  /** 서버는 끝났고 답장은 없다(사용자 중지 등) → 조용히 정리 */
  | 'ended';

export function decideTurnOutcome(probe: TurnProbe): TurnDecision {
  if (probe.freshReply) return 'reply';
  if (probe.running || probe.busy) return 'wait';
  if (probe.agentError) return 'error';
  if (!probe.delivered) return 'lost';
  return 'ended';
}
