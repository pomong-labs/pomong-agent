import type { ChatMessage, TaskRun } from './api';

/**
 * 대화·작업 카드 병합 (v0.6.4)
 *
 * 채팅 한 칸에는 세 갈래에서 같은 메시지가 도착한다.
 *   ① 내가 보낸 낙관적 말풍선(음수 id)  ② SSE 실시간 이벤트  ③ POST 응답·새로고침 스냅샷
 * 예전에는 목록을 통째로 갈아 끼워서, 응답이 도착할 때 말풍선이 잠깐 사라졌다 다시 나타났다(깜빡임).
 * 여기서는 **id 기준으로 합치기만** 하고, 이미 서버에 저장된 내 말풍선이 오면 낙관적 말풍선을 조용히 걷어낸다.
 *
 * 화면(store)과 스모크 테스트가 같은 함수를 쓰도록 순수 함수로 따로 두었다.
 */

/** 같은 id 는 서버 쪽 내용을 남기고, 아직 서버에 없는 말풍선은 그대로 붙여 둔다. */
export function mergeMessages(prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return prev;
  // 서버가 이미 저장한 내 말풍선이면 낙관적(음수 id) 말풍선은 버린다(잠깐 두 개로 보이는 깜빡임 방지).
  const savedContents = new Set(incoming.filter((m) => m.role === 'user').map((m) => `${m.role}:${m.content}`));
  const optimistic = prev.filter((m) => m.id < 0 && !savedContents.has(`${m.role}:${m.content}`));
  const byId = new Map<number, ChatMessage>();
  for (const m of prev) if (m.id > 0) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const real = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  const next = [...optimistic, ...real];
  if (next.length === prev.length && next.every((m, i) => m.id === prev[i]?.id)) return prev;
  return next;
}

/** 작업 카드 목록 — 같은 id 는 최신(진행률이 더 찬) 것을 남긴다. */
export function mergeTaskRuns(prev: TaskRun[], incoming: TaskRun[]): TaskRun[] {
  if (!incoming.length) return prev;
  const byId = new Map<string, TaskRun>();
  for (const run of [...prev, ...incoming]) {
    const before = byId.get(run.id);
    const beforeSteps = before ? before.items.length + before.steps : -1;
    if (!before || run.items.length + run.steps >= beforeSteps || run.endedAt) byId.set(run.id, run);
  }
  const next = Array.from(byId.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
  if (
    next.length === prev.length &&
    next.every((run, i) => {
      const before = prev[i];
      return (
        Boolean(before) &&
        run.id === before.id &&
        run.status === before.status &&
        run.title === before.title &&
        run.steps === before.steps &&
        run.items.length === before.items.length
      );
    })
  ) {
    return prev;
  }
  return next;
}
