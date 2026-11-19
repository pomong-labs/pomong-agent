import { addLog } from './db';

/**
 * 백그라운드 동시 작업 큐 (v0.6.0)
 *
 * 예약 실행(자동화)·워치·무거운 브라우저 작업이 도는 동안에도 일반 채팅이
 * 순서를 기다리지 않고 즉시 처리되도록 **레인(lane)별 실행 구조**를 분리한다.
 *
 *   chat      : 채팅방 대화 (방마다 따로, 동시 6)
 *   automation: 예약 작업 (동시 2)
 *   watch     : 웹 변화 감시 (동시 2)
 *   browser   : 브라우저를 실제로 조작하는 단계 (동시 1 — 자원 경합 방지)
 *   monitor   : 서버 감시 점검 (동시 1)
 *
 * 브라우저만 자원이 하나라서 **뮤텍스**(browserLock)로 안전하게 조율하고,
 * 나머지 레인은 서로 기다리지 않는다.
 */

export type Lane = 'chat' | 'automation' | 'watch' | 'browser' | 'monitor';

interface QueueEntry {
  id: number;
  lane: Lane;
  label: string;
  enqueuedAt: number;
  startedAt: number | null;
}

interface LaneState {
  concurrency: number;
  running: QueueEntry[];
  waiting: { entry: QueueEntry; run: () => void }[];
  completed: number;
  failed: number;
  lastFinishedAt: string | null;
}

const CONCURRENCY: Record<Lane, number> = {
  chat: 6,
  automation: 2,
  watch: 2,
  browser: 1,
  monitor: 1,
};

const LANE_LABEL: Record<Lane, string> = {
  chat: '대화',
  automation: '예약 작업',
  watch: '감시',
  browser: '브라우저',
  monitor: '서버 점검',
};

const states: Record<Lane, LaneState> = {
  chat: { concurrency: CONCURRENCY.chat, running: [], waiting: [], completed: 0, failed: 0, lastFinishedAt: null },
  automation: { concurrency: CONCURRENCY.automation, running: [], waiting: [], completed: 0, failed: 0, lastFinishedAt: null },
  watch: { concurrency: CONCURRENCY.watch, running: [], waiting: [], completed: 0, failed: 0, lastFinishedAt: null },
  browser: { concurrency: CONCURRENCY.browser, running: [], waiting: [], completed: 0, failed: 0, lastFinishedAt: null },
  monitor: { concurrency: CONCURRENCY.monitor, running: [], waiting: [], completed: 0, failed: 0, lastFinishedAt: null },
};

let seq = 0;

function pump(lane: Lane): void {
  const state = states[lane];
  while (state.running.length < state.concurrency && state.waiting.length) {
    const next = state.waiting.shift();
    if (!next) break;
    next.entry.startedAt = Date.now();
    state.running.push(next.entry);
    next.run();
  }
}

/**
 * 레인에 작업을 넣고 실행한다. 여유가 있으면 바로, 아니면 줄을 서서 실행된다.
 * (다른 레인의 작업은 이 대기와 무관하게 계속 흐른다)
 */
export async function runInLane<T>(lane: Lane, label: string, fn: () => Promise<T>): Promise<T> {
  const state = states[lane];
  seq += 1;
  const entry: QueueEntry = { id: seq, lane, label: label.slice(0, 80), enqueuedAt: Date.now(), startedAt: null };

  return new Promise<T>((resolve, reject) => {
    const execute = () => {
      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            state.completed += 1;
            resolve(value);
          },
          (err) => {
            state.failed += 1;
            reject(err);
          }
        )
        .finally(() => {
          state.running = state.running.filter((r) => r.id !== entry.id);
          state.lastFinishedAt = new Date().toISOString();
          pump(lane);
        });
    };
    state.waiting.push({ entry, run: execute });
    pump(lane);
  });
}

/* ------------------------------------------------------------------ */
/* 브라우저 자원 뮤텍스 (동시 1)                                        */
/* ------------------------------------------------------------------ */

let browserBusy: { label: string; since: number } | null = null;
const browserWaiters: { label: string; grant: () => void }[] = [];

/** 브라우저 조작 구간을 하나씩만 실행한다(에이전트·예약·사람 입력이 겹치지 않게). */
export async function browserLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (browserBusy) {
    await new Promise<void>((resolve) => browserWaiters.push({ label: label.slice(0, 60), grant: resolve }));
  }
  browserBusy = { label: label.slice(0, 60), since: Date.now() };
  try {
    return await fn();
  } finally {
    browserBusy = null;
    const next = browserWaiters.shift();
    if (next) next.grant();
  }
}

/* ------------------------------------------------------------------ */
/* 상태 조회 (화면 표시용)                                              */
/* ------------------------------------------------------------------ */

export interface LaneView {
  lane: Lane;
  label: string;
  concurrency: number;
  running: number;
  queued: number;
  active: { label: string; since: string; seconds: number }[];
  waiting: { label: string; seconds: number }[];
  completed: number;
  failed: number;
  lastFinishedAt: string | null;
}

export interface QueueView {
  at: string;
  totalRunning: number;
  totalQueued: number;
  browserBusy: { label: string; seconds: number } | null;
  lanes: LaneView[];
}

export function queueSnapshot(): QueueView {
  const now = Date.now();
  const lanes = (Object.keys(states) as Lane[]).map((lane) => {
    const state = states[lane];
    return {
      lane,
      label: LANE_LABEL[lane],
      concurrency: state.concurrency,
      running: state.running.length,
      queued: state.waiting.length,
      active: state.running.map((r) => ({
        label: r.label,
        since: new Date(r.startedAt || r.enqueuedAt).toISOString(),
        seconds: Math.round((now - (r.startedAt || r.enqueuedAt)) / 1000),
      })),
      waiting: state.waiting.map((w) => ({
        label: w.entry.label,
        seconds: Math.round((now - w.entry.enqueuedAt) / 1000),
      })),
      completed: state.completed,
      failed: state.failed,
      lastFinishedAt: state.lastFinishedAt,
    };
  });
  return {
    at: new Date(now).toISOString(),
    totalRunning: lanes.reduce((sum, l) => sum + l.running, 0),
    totalQueued: lanes.reduce((sum, l) => sum + l.queued, 0),
    browserBusy: browserBusy
      ? { label: browserBusy.label, seconds: Math.round((now - browserBusy.since) / 1000) }
      : null,
    lanes,
  };
}

/** 큐가 막혀 오래 대기하는 작업이 있는지 (감시 알림용) */
export function stuckWork(thresholdSec = 300): { lane: Lane; label: string; seconds: number }[] {
  const now = Date.now();
  const out: { lane: Lane; label: string; seconds: number }[] = [];
  for (const lane of Object.keys(states) as Lane[]) {
    for (const wait of states[lane].waiting) {
      const seconds = Math.round((now - wait.entry.enqueuedAt) / 1000);
      if (seconds >= thresholdSec) out.push({ lane, label: wait.entry.label, seconds });
    }
  }
  return out;
}

let logged = false;
/** 큐가 처음 정체되면 로그를 한 번 남긴다. */
export function noteStuckWork(): void {
  const stuck = stuckWork();
  if (!stuck.length || logged) return;
  logged = true;
  addLog('warn', `작업 큐 정체 · ${stuck.map((s) => `${LANE_LABEL[s.lane]} ${s.label}(${s.seconds}초)`).join(', ')}`);
}
