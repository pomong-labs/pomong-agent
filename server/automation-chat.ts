import { addLog, db } from './db';
import { publish } from './events';

/**
 * 자동화(예약·워치) 결과를 메인 채팅방에 "선톡"으로 남긴다 (v0.5.2)
 *
 * 예전에는 자동화 탭 로그에만 남아 사용자가 그 탭을 열어야 결과를 볼 수 있었다.
 * 이제 결과를 `default` 세션의 assistant 말풍선으로 저장하고 SSE(`chat`)로 즉시 띄우며,
 * 같은 이벤트가 웹 푸시(알림을 누르면 `/` = 채팅)로도 이어진다.
 * 푸시 본문에는 결과 요약만 넣고(180자), 자세한 내용은 채팅 말풍선에 남긴다.
 */

export const AUTOMATION_SESSION = 'default';

export type AutomationKind = 'job' | 'watch' | 'monitor' | 'parcel';

export interface AutomationChatInput {
  kind: AutomationKind;
  /** 말풍선 첫 줄 배지 — 예: '예약 알림: 아침 브리핑' */
  badge: string;
  /** 결과 본문(여러 줄 가능) */
  body: string;
  /** 어느 대화방에 남길지 (기본 default — 자동화 결과를 모으는 방) */
  session?: string;
  jobId?: string;
  runId?: string;
  watcherId?: string;
  eventId?: string;
  /** 푸시 알림 제목/본문을 따로 주고 싶을 때 */
  notifyTitle?: string;
  notifyBody?: string;
}

export interface AutomationChatResult {
  messageId: number;
  content: string;
  createdAt: string;
  /** v0.7.1: 이 말풍선이 들어간 대화방(푸시 딥링크용) */
  session: string;
}

const MAX_BODY_CHARS = 3500;

/** 결과를 채팅 말풍선으로 저장하고 SSE로 밀어 준다. 실패하면 null. */
export function postAutomationMessage(input: AutomationChatInput): AutomationChatResult | null {
  const body = String(input.body || '').trim().slice(0, MAX_BODY_CHARS);
  const emoji = input.kind === 'job' ? '⏰' : input.kind === 'monitor' ? '🛡️' : input.kind === 'parcel' ? '📦' : '👀';
  const content = `${emoji} [${input.badge}]${body ? `\n${body}` : ''}`;
  const session = input.session || AUTOMATION_SESSION;
  const meta = {
    type: 'notice' as const,
    automation: input.kind,
    badge: input.badge,
    jobId: input.jobId || null,
    runId: input.runId || null,
    watcherId: input.watcherId || null,
    eventId: input.eventId || null,
  };
  try {
    const createdAt = new Date().toISOString();
    const info = db
      .prepare('INSERT INTO messages(session_id, role, content, meta, created_at) VALUES(?,?,?,?,?)')
      .run(session, 'assistant', content, JSON.stringify(meta), createdAt);
    const messageId = Number(info.lastInsertRowid);
    publish({
      type: 'chat',
      title: input.notifyTitle || `${input.badge} · 결과가 도착했어요`,
      body: (input.notifyBody || body || content).slice(0, 180),
      data: {
        message: {
          id: messageId,
          role: 'assistant',
          content,
          meta,
          createdAt,
        },
        session,
        automation: input.kind,
        jobId: input.jobId || null,
        runId: input.runId || null,
        watcherId: input.watcherId || null,
      },
    });
    addLog('info', `${input.kind === 'job' ? '예약' : '워치'} 결과를 채팅방에 전달 · ${input.badge}`);
    return { messageId, content, createdAt, session };
  } catch (err) {
    addLog('warn', `자동화 결과를 채팅방에 남기지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
