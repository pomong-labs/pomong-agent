import crypto from 'node:crypto';
import { Cron } from 'croner';
import { addLog, db } from './db';

/**
 * 예약 실행(스케줄러). Phase 1의 jobs/job_runs 테이블을 실제로 채운다.
 * - cron 5필드 + 프리셋, 잡별 타임존
 * - 다음 실행은 매 tick 재계산(서머타임·시계 변경 안전)
 * - 놓친 실행: 2시간 이내면 1회 따라잡기, 그 이후는 missed 기록
 * - 겹침: 같은 잡이 실행 중이면 skipped_overlap
 * - 동시 실행 1(설정 2), 대기열 없음(서버 자원 보호)
 */

export type JobRunStatus = 'running' | 'ok' | 'failed' | 'skipped_overlap' | 'missed' | 'approval_needed';

export interface JobRow {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  tools_allow: string | null;
  max_steps: number;
  notify: string | null;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  status: JobRunStatus;
  trigger: string;
  started_at: string;
  ended_at: string | null;
  steps: number;
  result: string | null;
  error: string | null;
}

export interface JobView {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  toolsAllow: string[] | null;
  maxSteps: number;
  notify: string[];
  enabled: boolean;
  nextRunAt: string | null;
  nextRuns: string[];
  scheduleLabel: string;
  lastRunAt: string | null;
  lastStatus: JobRunStatus | null;
  createdAt: string;
  running: boolean;
  lastRun?: JobRunView | null;
}

export interface JobRunView {
  id: string;
  jobId: string;
  status: JobRunStatus;
  trigger: string;
  startedAt: string;
  endedAt: string | null;
  steps: number;
  result: string | null;
  error: string | null;
}

export const MAX_JOBS = 20;
const CATCHUP_WINDOW_MS = 2 * 60 * 60 * 1000;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 화면에 보여줄 사람용 주기 표기 */
export function scheduleLabel(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const hm = (h: string, m: string) => {
    const hh = h === '*' ? null : Number(h);
    const mm = m === '*' ? 0 : Number(m);
    if (hh === null || Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  if (dom === '*' && mon === '*' && dow === '*') {
    const time = hm(hour, min);
    if (time) return `매일 ${time}`;
    if (min.startsWith('*/')) return `${min.slice(2)}분마다`;
    if (hour === '*' && /^\d+$/.test(min)) return `매시간 :${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && dow === '1-5') {
    const time = hm(hour, min);
    if (time) return `평일 ${time}`;
  }
  if (dom === '*' && mon === '*' && /^\d$/.test(dow)) {
    const time = hm(hour, min);
    if (time) return `${WEEKDAYS[Number(dow)]}요일 ${time}`;
  }
  return cron;
}

export function nextRuns(cron: string, timezone: string, count = 3): string[] {
  try {
    const job = new Cron(cron, { timezone });
    return job.nextRuns(count).map((d) => d.toISOString());
  } catch {
    return [];
  }
}

export function validateCron(cron: string): void {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron은 5개 필드(분 시 일 월 요일)로 입력해 주세요. 예) 매일 08:00 → 0 8 * * *');
  try {
    // eslint-disable-next-line no-new
    new Cron(cron);
  } catch (err) {
    throw new Error(`cron 형식이 올바르지 않습니다: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseList(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const list = parsed.map((v) => String(v)).filter(Boolean);
    return list.length ? list : null;
  } catch {
    return null;
  }
}

export function toRunView(row: JobRunRow): JobRunView {
  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    steps: row.steps,
    result: row.result,
    error: row.error,
  };
}

function latestRun(jobId: string): JobRunRow | null {
  const row = db
    .prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(jobId) as JobRunRow | undefined;
  return row || null;
}

export function toJobView(row: JobRow, withRuns = true): JobView {
  const cronValid = nextRuns(row.cron, row.timezone, 1).length > 0;
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    toolsAllow: parseList(row.tools_allow),
    maxSteps: row.max_steps,
    notify: parseList(row.notify) || ['sse'],
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at,
    nextRuns: cronValid ? nextRuns(row.cron, row.timezone, 3) : [],
    scheduleLabel: scheduleLabel(row.cron),
    lastRunAt: row.last_run_at,
    lastStatus: (row.last_status as JobRunStatus) || null,
    createdAt: row.created_at,
    running: running.has(row.id),
    lastRun: withRuns ? (latestRun(row.id) ? toRunView(latestRun(row.id) as JobRunRow) : null) : null,
  };
}

export function listJobs(): JobView[] {
  const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all() as JobRow[];
  return rows.map((r) => toJobView(r));
}

export function getJob(id: string): JobView | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? toJobView(row) : null;
}

export interface JobInput {
  name?: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  toolsAllow?: string[] | null;
  maxSteps?: number;
  notify?: string[] | null;
  enabled?: boolean;
}

export function createJob(input: JobInput): JobView {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;
  if (count >= MAX_JOBS) throw new Error(`예약 작업은 최대 ${MAX_JOBS}개까지 만들 수 있습니다.`);
  const name = String(input.name || '').trim().slice(0, 80);
  const prompt = String(input.prompt || '').trim().slice(0, 4000);
  if (!name) throw new Error('작업 이름을 입력해 주세요.');
  if (!prompt) throw new Error('무엇을 할지(지시문)를 입력해 주세요.');
  const cron = String(input.cron || '').trim();
  validateCron(cron);
  const timezone = String(input.timezone || 'Asia/Seoul');
  const enabled = input.enabled !== false;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const next = enabled ? (nextRuns(cron, timezone, 1)[0] || null) : null;
  db.prepare(
    `INSERT INTO jobs(id, name, cron, timezone, prompt, tools_allow, max_steps, notify, enabled, next_run_at, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    cron,
    timezone,
    prompt,
    input.toolsAllow && input.toolsAllow.length ? JSON.stringify(input.toolsAllow) : null,
    Math.max(1, Math.min(20, Number(input.maxSteps) || 6)),
    JSON.stringify(input.notify && input.notify.length ? input.notify : ['sse']),
    enabled ? 1 : 0,
    next,
    now,
    now
  );
  addLog('info', `예약 작업 추가 · ${name} (${scheduleLabel(cron)})`);
  return getJob(id) as JobView;
}

export function updateJob(id: string, input: JobInput): JobView {
  const current = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!current) throw new Error('예약 작업을 찾을 수 없습니다.');
  const name = input.name === undefined ? current.name : String(input.name).trim().slice(0, 80);
  const prompt = input.prompt === undefined ? current.prompt : String(input.prompt).trim().slice(0, 4000);
  const cron = input.cron === undefined ? current.cron : String(input.cron).trim();
  const timezone = input.timezone === undefined ? current.timezone : String(input.timezone || 'Asia/Seoul');
  const enabled = input.enabled === undefined ? Boolean(current.enabled) : Boolean(input.enabled);
  if (!name) throw new Error('작업 이름을 입력해 주세요.');
  if (!prompt) throw new Error('무엇을 할지(지시문)를 입력해 주세요.');
  validateCron(cron);
  const toolsAllow =
    input.toolsAllow === undefined
      ? current.tools_allow
      : input.toolsAllow && input.toolsAllow.length
        ? JSON.stringify(input.toolsAllow)
        : null;
  const notify =
    input.notify === undefined
      ? current.notify
      : JSON.stringify(input.notify && input.notify.length ? input.notify : ['sse']);
  const maxSteps = input.maxSteps === undefined ? current.max_steps : Math.max(1, Math.min(20, Number(input.maxSteps) || 6));
  const next = enabled ? (nextRuns(cron, timezone, 1)[0] || null) : null;
  db.prepare(
    `UPDATE jobs SET name=?, cron=?, timezone=?, prompt=?, tools_allow=?, max_steps=?, notify=?, enabled=?, next_run_at=?, updated_at=? WHERE id=?`
  ).run(name, cron, timezone, prompt, toolsAllow, maxSteps, notify, enabled ? 1 : 0, next, new Date().toISOString(), id);
  return getJob(id) as JobView;
}

export function deleteJob(id: string): void {
  db.prepare('DELETE FROM job_runs WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

export function listRuns(jobId?: string, limit = 50): JobRunView[] {
  const rows = jobId
    ? (db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?').all(jobId, limit) as JobRunRow[])
    : (db.prepare('SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?').all(limit) as JobRunRow[]);
  return rows.map(toRunView);
}

/* ------------------------------------------------------------------ */
/* 실행                                                                */
/* ------------------------------------------------------------------ */

export interface JobRunOutcome {
  text: string;
  steps: number;
  status?: 'ok' | 'approval_needed';
}

export type JobRunner = (job: JobView, options: { deadline: number }) => Promise<JobRunOutcome>;
export type JobNotifier = (job: JobView, run: JobRunView) => void;

let runner: JobRunner | null = null;
let notifier: JobNotifier | null = null;
let timer: NodeJS.Timeout | null = null;
let ticking = false;
const running = new Set<string>();

export function isJobRunning(id: string): boolean {
  return running.has(id);
}

export function startScheduler(nextRunner: JobRunner, nextNotifier?: JobNotifier): void {
  runner = nextRunner;
  notifier = nextNotifier || null;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void tick();
  }, 20_000);
  timer.unref?.();
  // 부팅 직후 한 번 돌려서 놓친 실행을 따라잡는다.
  setTimeout(() => void tick(), 5_000).unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function recordRun(job: JobRow, status: JobRunStatus, trigger: string, extra?: Partial<JobRunRow>): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO job_runs(id, job_id, status, trigger, started_at, ended_at, steps, result, error) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(
    id,
    job.id,
    status,
    trigger,
    extra?.started_at || now,
    extra?.ended_at === undefined ? (status === 'running' ? null : now) : extra.ended_at,
    extra?.steps || 0,
    extra?.result || null,
    extra?.error || null
  );
  if (status !== 'running') {
    db.prepare('UPDATE jobs SET last_run_at=?, last_status=?, updated_at=? WHERE id=?').run(
      extra?.started_at || now,
      status,
      now,
      job.id
    );
  }
  return id;
}

/** 지금 1회 실행 (수동). 이미 실행 중이면 skipped_overlap 기록 후 반환 */
export async function runJobNow(id: string, trigger = 'manual'): Promise<{ run: JobRunView; outcome: JobRunOutcome | null }> {
  const job = getJob(id);
  if (!job) throw new Error('예약 작업을 찾을 수 없습니다.');
  if (!runner) throw new Error('스케줄러가 아직 준비되지 않았습니다.');
  if (running.has(id)) {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
    const runId = recordRun(row, 'skipped_overlap', trigger, { error: '이미 실행 중입니다.' });
    const run = db.prepare('SELECT * FROM job_runs WHERE id = ?').get(runId) as JobRunRow;
    return { run: toRunView(run), outcome: null };
  }
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
  const runId = recordRun(row, 'running', trigger);
  running.add(id);
  const startedAt = Date.now();
  try {
    const outcome = await runner(job, { deadline: startedAt + HARD_TIMEOUT_MS });
    const status: JobRunStatus = outcome.status === 'approval_needed' ? 'approval_needed' : 'ok';
    db.prepare('UPDATE job_runs SET status=?, ended_at=?, steps=?, result=? WHERE id=?').run(
      status,
      new Date().toISOString(),
      outcome.steps,
      outcome.text.slice(0, 4000),
      runId
    );
    db.prepare('UPDATE jobs SET last_run_at=?, last_status=?, updated_at=? WHERE id=?').run(
      new Date().toISOString(),
      status,
      new Date().toISOString(),
      id
    );
    const run = db.prepare('SELECT * FROM job_runs WHERE id = ?').get(runId) as JobRunRow;
    const view = toRunView(run);
    if (status === 'approval_needed') {
      addLog('warn', `예약 작업 승인 대기 · ${job.name}`);
    } else {
      addLog('success', `예약 작업 완료 · ${job.name} (${outcome.steps}단계)`);
    }
    notifier?.(job, view);
    return { run: view, outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE job_runs SET status=?, ended_at=?, error=? WHERE id=?').run('failed', new Date().toISOString(), message.slice(0, 600), runId);
    db.prepare('UPDATE jobs SET last_run_at=?, last_status=?, updated_at=? WHERE id=?').run(new Date().toISOString(), 'failed', new Date().toISOString(), id);
    addLog('error', `예약 작업 실패 · ${job.name}: ${message.slice(0, 160)}`);
    const run = db.prepare('SELECT * FROM job_runs WHERE id = ?').get(runId) as JobRunRow;
    const view = toRunView(run);
    notifier?.(job, view);
    return { run: view, outcome: null };
  } finally {
    running.delete(id);
  }
}

async function tick(): Promise<void> {
  if (ticking || !runner) return;
  ticking = true;
  try {
    const rows = db.prepare('SELECT * FROM jobs WHERE enabled = 1').all() as JobRow[];
    const now = Date.now();
    for (const row of rows) {
      const next = row.next_run_at ? new Date(row.next_run_at).getTime() : null;
      if (next === null) {
        const computed = nextRuns(row.cron, row.timezone, 1)[0] || null;
        db.prepare('UPDATE jobs SET next_run_at=? WHERE id=?').run(computed, row.id);
        continue;
      }
      if (next > now) continue;

      const late = now - next;
      const upcoming = nextRuns(row.cron, row.timezone, 1)[0] || null;
      if (late > CATCHUP_WINDOW_MS) {
        recordRun(row, 'missed', 'schedule', { started_at: new Date(next).toISOString(), error: '서버가 꺼져 있어 실행하지 못했습니다.' });
        db.prepare('UPDATE jobs SET next_run_at=? WHERE id=?').run(upcoming, row.id);
        continue;
      }
      if (running.size >= 1 || running.has(row.id)) {
        recordRun(row, 'skipped_overlap', 'schedule', { started_at: new Date(next).toISOString(), error: '다른 작업이 실행 중입니다.' });
        db.prepare('UPDATE jobs SET next_run_at=? WHERE id=?').run(upcoming, row.id);
        continue;
      }

      db.prepare('UPDATE jobs SET next_run_at=? WHERE id=?').run(upcoming, row.id);
      const job = toJobView(row);
      void runJobNow(row.id, 'schedule').catch(() => undefined);
      addLog('info', `예약 실행 시작 · ${job.name}`);
    }
  } catch (err) {
    addLog('error', `스케줄러 오류: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ticking = false;
  }
}

/** 서버가 다시 켜졌을 때 다음 실행 시각을 다시 계산한다. */
export function resyncJobs(): void {
  const rows = db.prepare('SELECT * FROM jobs').all() as JobRow[];
  for (const row of rows) {
    if (!row.enabled) {
      db.prepare('UPDATE jobs SET next_run_at=NULL WHERE id=?').run(row.id);
      continue;
    }
    const next = nextRuns(row.cron, row.timezone, 1)[0] || null;
    // 이미 지난 시각이면(놓친 실행) 그대로 두어 tick에서 따라잡기 판단을 하게 한다.
    if (!row.next_run_at) db.prepare('UPDATE jobs SET next_run_at=? WHERE id=?').run(next, row.id);
  }
}
