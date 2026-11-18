import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlarmClock,
  Bell,
  Check,
  Clock3,
  Eye,
  History,
  Pencil,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import MascotFace from '../components/MascotFace';
import {
  api,
  type AutomationJob,
  type JobRun,
  type JobRunStatus,
  type WatchEvent,
  type Watcher,
  type WatchMode,
} from '../lib/api';
import { clockLabel, relativeTime, useAppEvents } from '../lib/events';
import { useAppStore } from '../lib/store';

const RUN_STATUS: Record<JobRunStatus, { label: string; color: string; bg: string }> = {
  running: { label: '실행 중', color: '#7C63F6', bg: '#F1ECFF' },
  ok: { label: '성공', color: '#0F9668', bg: '#EAFBF1' },
  failed: { label: '실패', color: '#E5484D', bg: '#FFF1F1' },
  skipped_overlap: { label: '겹침 건너뜀', color: '#C08A16', bg: '#FFF8E7' },
  missed: { label: '놓침', color: '#8A8A9A', bg: '#F4F3F9' },
  approval_needed: { label: '승인 대기', color: '#C08A16', bg: '#FFF8E7' },
};


/* ------------------------------------------------------------------ */
/* 쉬운 주기 설정 — 크론 문법을 몰라도 고를 수 있게                    */
/* ------------------------------------------------------------------ */

type RepeatMode = 'daily' | 'weekdays' | 'weekly' | 'minutes' | 'hours';

const WEEKDAYS = [
  { value: 0, label: '일' },
  { value: 1, label: '월' },
  { value: 2, label: '화' },
  { value: 3, label: '수' },
  { value: 4, label: '목' },
  { value: 5, label: '금' },
  { value: 6, label: '토' },
];

interface EasySchedule {
  mode: RepeatMode;
  hour: number;
  minute: number;
  weekday: number;
  every: number;
}

function parseCron(cron: string): EasySchedule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  const num = (v: string, fallback = 0) => (/^\d+$/.test(v) ? Number(v) : fallback);
  if (/^\*\/(\d+)$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { mode: 'minutes', hour: 8, minute: 0, weekday: 1, every: num(RegExp.$1, 30) };
  }
  if (min === '0' && /^\*\/(\d+)$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return { mode: 'hours', hour: 8, minute: 0, weekday: 1, every: num(RegExp.$1, 6) };
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    if (dow === '*') return { mode: 'daily', hour: num(hour), minute: num(min), weekday: 1, every: 30 };
    if (dow === '1-5') return { mode: 'weekdays', hour: num(hour), minute: num(min), weekday: 1, every: 30 };
    if (/^[0-6]$/.test(dow)) return { mode: 'weekly', hour: num(hour), minute: num(min), weekday: num(dow), every: 30 };
  }
  return null;
}

function buildCron(easy: EasySchedule): string {
  const time = `${easy.minute} ${easy.hour}`;
  if (easy.mode === 'daily') return `${time} * * *`;
  if (easy.mode === 'weekdays') return `${time} * * 1-5`;
  if (easy.mode === 'weekly') return `${time} * * ${easy.weekday}`;
  const every = Math.max(1, Math.min(59, easy.every));
  if (easy.mode === 'minutes') return `*/${every} * * * *`;
  return `0 */${Math.max(1, Math.min(23, easy.every))} * * *`;
}

function scheduleSummary(easy: EasySchedule): string {
  const time = `${String(easy.hour).padStart(2, '0')}:${String(easy.minute).padStart(2, '0')}`;
  if (easy.mode === 'daily') return `매일 ${time}`;
  if (easy.mode === 'weekdays') return `평일 ${time}`;
  if (easy.mode === 'weekly') return `매주 ${WEEKDAYS.find((d) => d.value === easy.weekday)?.label || '월'}요일 ${time}`;
  if (easy.mode === 'minutes') return `${easy.every}분마다`;
  return `${easy.every}시간마다`;
}

const MODE_LABELS: Record<WatchMode, string> = {
  text: '전체 텍스트',
  selector: 'CSS 선택자',
  price: '가격·재고',
  json: 'JSON 경로',
  regex: '정규식',
  rss: 'RSS',
  github: 'GitHub 릴리스',
  ping: '서버 응답',
};

const MODE_HINT: Record<WatchMode, string> = {
  text: '페이지 글자가 바뀌면 알려드려요.',
  selector: '특정 부분만 감시해요. 예) .price, #stock',
  price: '페이지의 숫자+원(₩) 표시를 자동으로 감시해요.',
  json: 'JSON API 응답을 감시해요. 예) $.items[0].price',
  regex: '정규식 첫 번째 캡처를 감시해요.',
  rss: '새 글이 올라오면 알려드려요.',
  github: '새 릴리스가 나오면 알려드려요. 예) owner/repo',
  ping: '서버가 응답하는지, 느려졌는지 감시해요.',
};

type Tab = 'jobs' | 'watchers' | 'runs';

export default function Automation() {
  const { profile } = useAppStore();
  const [tab, setTab] = useState<Tab>('jobs');
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; job?: AutomationJob } | null>(null);
  const [watchEditor, setWatchEditor] = useState<{ mode: 'create' | 'edit'; watcher?: Watcher } | null>(null);
  const [openEvents, setOpenEvents] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, WatchEvent[]>>({});
  const [toast, setToast] = useState<string>('');

  const load = useCallback(async () => {
    const [jobRes, watchRes, runRes] = await Promise.all([
      api.get<{ jobs: AutomationJob[] }>('/api/jobs').catch(() => ({ jobs: [] })),
      api.get<{ watchers: Watcher[] }>('/api/watchers').catch(() => ({ watchers: [] })),
      api.get<{ runs: JobRun[] }>('/api/runs').catch(() => ({ runs: [] })),
    ]);
    setJobs(jobRes.jobs);
    setWatchers(watchRes.watchers);
    setRuns(runRes.runs);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useAppEvents((event) => {
    if (event.type === 'job' || event.type === 'watch' || event.type === 'handover') {
      setToast(`${event.title}${event.body ? ` · ${event.body.slice(0, 60)}` : ''}`);
      void load();
      window.setTimeout(() => setToast(''), 5000);
    }
  });

  const runningJobs = jobs.filter((j) => j.running);
  const waitingJobs = jobs.filter((j) => !j.running && j.enabled);
  const pausedJobs = jobs.filter((j) => !j.enabled);

  const runNow = async (job: AutomationJob) => {
    setBusyId(job.id);
    try {
      await api.post(`/api/jobs/${job.id}/run`);
      setToast(`'${job.name}' 실행을 시작했어요.`);
      window.setTimeout(() => void load(), 1200);
    } catch (err) {
      setToast(err instanceof Error ? err.message : '실행하지 못했어요.');
    } finally {
      setBusyId(null);
    }
  };

  const toggleJob = async (job: AutomationJob) => {
    await api.patch(`/api/jobs/${job.id}`, { enabled: !job.enabled }).catch(() => undefined);
    void load();
  };

  const removeJob = async (job: AutomationJob) => {
    if (!window.confirm(`'${job.name}' 예약을 삭제할까요?`)) return;
    await api.del(`/api/jobs/${job.id}`).catch(() => undefined);
    void load();
  };

  const checkWatch = async (watcher: Watcher) => {
    setBusyId(watcher.id);
    try {
      const res = await api.post<{ event: WatchEvent | null }>(`/api/watchers/${watcher.id}/check`);
      setToast(res.event ? `${watcher.name} · ${res.event.diffSummary || '확인했어요'}` : `${watcher.name} · 변경 없음`);
      void load();
      setEvents((prev) => ({ ...prev, [watcher.id]: [] }));
    } catch (err) {
      setToast(err instanceof Error ? err.message.slice(0, 90) : '확인하지 못했어요.');
    } finally {
      setBusyId(null);
    }
  };

  const toggleWatch = async (watcher: Watcher) => {
    await api.patch(`/api/watchers/${watcher.id}`, { enabled: !watcher.enabled }).catch(() => undefined);
    void load();
  };

  const removeWatch = async (watcher: Watcher) => {
    if (!window.confirm(`'${watcher.name}' 감시를 삭제할까요?`)) return;
    await api.del(`/api/watchers/${watcher.id}`).catch(() => undefined);
    void load();
  };

  const loadEvents = async (watcher: Watcher) => {
    if (openEvents === watcher.id) {
      setOpenEvents(null);
      return;
    }
    setOpenEvents(watcher.id);
    if (!events[watcher.id]) {
      const res = await api.get<{ events: WatchEvent[] }>(`/api/watchers/${watcher.id}/events`).catch(() => ({ events: [] }));
      setEvents((prev) => ({ ...prev, [watcher.id]: res.events }));
    }
  };

  const nextSummary = useMemo(() => {
    const soon = jobs
      .filter((j) => j.enabled && j.nextRunAt)
      .sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime())[0];
    return soon ? `${soon.name} · ${clockLabel(soon.nextRunAt)}` : '예약된 작업 없음';
  }, [jobs]);

  return (
    <div className="pa-scroll relative h-full min-h-0 overflow-y-auto px-4 pb-10 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[860px]">
        <header className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[26px] font-bold tracking-[-0.02em] lg:text-[34px]">자동화</h1>
            <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">
              예약 <b className="text-[#7C63F6]">{jobs.filter((j) => j.enabled).length}</b>개 · 워치{' '}
              <b className="text-[#7C63F6]">{watchers.filter((w) => w.enabled).length}</b>개 · 다음은 {nextSummary}
            </p>
          </div>
          <MascotFace character={profile.character} state={runningJobs.length ? 'working' : 'idle'} size={56} className="lg:hidden" />
        </header>

        {/* 상단 탭 3개 */}
        <div className="mt-4 flex rounded-full bg-[#F4F3F9] p-1">
          {(
            [
              ['jobs', '예약 실행', AlarmClock],
              ['watchers', '웹 감시 워치', Radar],
              ['runs', '실행 기록', History],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-[13px] font-semibold transition ${
                tab === value ? 'bg-white text-[#7C63F6] shadow-sm' : 'text-[#8A8A9A]'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {toast ? (
          <div className="mt-3 flex items-start gap-2 rounded-[16px] bg-[#F1ECFF] px-3.5 py-2.5 text-[12.5px] text-[#5B4BC4]">
            <Bell size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{toast}</span>
          </div>
        ) : null}

        {!loaded ? (
          <p className="mt-8 text-center text-[13.5px] text-[#A8A5B8]">불러오는 중…</p>
        ) : null}

        {tab === 'jobs' ? (
          <div className="mt-5 space-y-5">
            <button className="pa-btn-primary w-full py-3" onClick={() => setEditor({ mode: 'create' })}>
              <Plus size={17} /> 예약 만들기
            </button>

            <JobSection
              title="진행 중"
              tint="#F1ECFF"
              color="#7C63F6"
              jobs={runningJobs}
              empty="지금 실행 중인 작업이 없어요."
              busyId={busyId}
              onRun={runNow}
              onToggle={toggleJob}
              onEdit={(job) => setEditor({ mode: 'edit', job })}
              onRemove={removeJob}
            />
            <JobSection
              title="실행 대기"
              tint="#EDF6FF"
              color="#2F86D8"
              jobs={waitingJobs}
              empty="예약된 작업이 없어요. 위에서 하나 만들어 볼까요?"
              busyId={busyId}
              onRun={runNow}
              onToggle={toggleJob}
              onEdit={(job) => setEditor({ mode: 'edit', job })}
              onRemove={removeJob}
            />
            <JobSection
              title="멈춤"
              tint="#F4F3F9"
              color="#8A8A9A"
              jobs={pausedJobs}
              empty=""
              busyId={busyId}
              onRun={runNow}
              onToggle={toggleJob}
              onEdit={(job) => setEditor({ mode: 'edit', job })}
              onRemove={removeJob}
            />
          </div>
        ) : null}

        {tab === 'watchers' ? (
          <div className="mt-5 space-y-3">
            <button className="pa-btn-primary w-full py-3" onClick={() => setWatchEditor({ mode: 'create' })}>
              <Plus size={17} /> 워치 만들기
            </button>
            {watchers.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-[#E7E3F3] bg-white/60 px-4 py-10 text-center text-[13.5px] text-[#A8A5B8]">
                감시 중인 페이지가 없어요. 주소를 넣으면 바뀔 때 알려드려요.
              </div>
            ) : null}
            {watchers.map((watcher) => {
              const last = watcher.lastEvent;
              const changed = last?.kind === 'changed';
              return (
                <article key={watcher.id} className="rounded-[16px] bg-white p-4 shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#F6F4FB]">
                  <div className="flex items-start gap-2">
                    <span
                      className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: changed ? '#FFF1F1' : '#EAFBF1', color: changed ? '#E5484D' : '#0F9668' }}
                    >
                      <Eye size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="truncate text-[15px] font-semibold text-[#1F1D2B]">{watcher.name}</h3>
                        <span className="rounded-full bg-[#F3EEFF] px-2 py-0.5 text-[10.5px] font-bold text-[#7C63F6]">
                          {watcher.intervalMin}분마다
                        </span>
                        {!watcher.enabled ? (
                          <span className="rounded-full bg-[#F4F3F9] px-2 py-0.5 text-[10.5px] font-bold text-[#8A8A9A]">멈춤</span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[11.5px] text-[#A8A5B8]">{watcher.url}</p>
                      <p className="mt-1 text-[12px] text-[#6B677A]">
                        {watcher.lastChecked ? (
                          <>
                            {relativeTime(watcher.lastChecked)} ·{' '}
                            <span className={watcher.lastStatus === 'failed' ? 'text-[#E5484D]' : 'text-[#8A8A9A]'}>
                              {watcher.lastStatus === 'failed'
                                ? `확인 실패 ${watcher.failCount}회`
                                : watcher.lastStatus === 'changed'
                                  ? '변경 감지'
                                  : '변경 없음'}
                            </span>
                          </>
                        ) : (
                          '아직 확인 전'
                        )}
                        <span className="ml-1 text-[#B4B1C2]">· {MODE_LABELS[watcher.mode]}</span>
                      </p>
                      {last?.diffSummary ? (
                        <p
                          className="mt-1.5 rounded-[10px] px-2 py-1.5 text-[11.5px] leading-[1.5]"
                          style={{ background: changed ? '#FFF6F6' : '#FAF9FD', color: changed ? '#B2373B' : '#8A8A9A' }}
                        >
                          {last.diffSummary}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <button
                      className="flex items-center gap-1 rounded-xl bg-[#F3EEFF] px-2.5 py-1.5 text-[12px] font-semibold text-[#7C63F6] disabled:opacity-50"
                      onClick={() => checkWatch(watcher)}
                      disabled={busyId === watcher.id}
                    >
                      <RefreshCw size={12} className={busyId === watcher.id ? 'animate-spin' : ''} /> 지금 확인
                    </button>
                    <button className="rounded-xl bg-[#FAF9FD] px-2.5 py-1.5 text-[12px] font-semibold text-[#6B677A]" onClick={() => loadEvents(watcher)}>
                      이력 {openEvents === watcher.id ? '접기' : '보기'}
                    </button>
                    <button className="rounded-xl bg-[#FAF9FD] px-2.5 py-1.5 text-[12px] font-semibold text-[#6B677A]" onClick={() => toggleWatch(watcher)}>
                      {watcher.enabled ? '멈추기' : '다시 켜기'}
                    </button>
                    <button className="rounded-xl bg-[#FAF9FD] px-2.5 py-1.5 text-[12px] text-[#8A8A9A]" onClick={() => setWatchEditor({ mode: 'edit', watcher })}>
                      <Pencil size={12} />
                    </button>
                    <button className="rounded-xl bg-[#FFF6F6] px-2.5 py-1.5 text-[12px] text-[#E5484D]" onClick={() => removeWatch(watcher)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {openEvents === watcher.id ? (
                    <div className="mt-2 space-y-1.5 border-t border-[#F4F2FA] pt-2">
                      {(events[watcher.id] || []).length === 0 ? (
                        <p className="text-[12px] text-[#A8A5B8]">기록이 없어요.</p>
                      ) : (
                        (events[watcher.id] || []).map((event) => (
                          <div key={event.id} className="rounded-[10px] bg-[#FAF9FD] px-2.5 py-2">
                            <p className="text-[11px] font-semibold text-[#8A8A9A]">
                              {clockLabel(event.createdAt)} · {event.kind}
                            </p>
                            <p className="mt-0.5 text-[11.5px] leading-[1.5] text-[#5B5866]">{event.diffSummary}</p>
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}

        {tab === 'runs' ? (
          <div className="mt-5 space-y-2">
            {runs.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-[#E7E3F3] bg-white/60 px-4 py-10 text-center text-[13.5px] text-[#A8A5B8]">
                아직 실행 기록이 없어요.
              </div>
            ) : null}
            {runs.map((run) => {
              const job = jobs.find((j) => j.id === run.jobId);
              const meta = RUN_STATUS[run.status];
              return (
                <div key={run.id} className="rounded-[16px] bg-white px-4 py-3 shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#F6F4FB]">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[#1F1D2B]">{job?.name || '삭제된 작업'}</span>
                    <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: meta.bg, color: meta.color }}>
                      {meta.label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-[#A8A5B8]">
                    {clockLabel(run.startedAt)} · {run.trigger === 'manual' ? '직접 실행' : '예약'} · {run.steps}단계
                    {run.endedAt ? ` · ${Math.max(1, Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))}초` : ''}
                  </p>
                  {run.result || run.error ? (
                    <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-[12px] leading-[1.55] text-[#5B5866]">{run.result || run.error}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {editor ? (
        <JobEditor
          job={editor.job}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      ) : null}
      {watchEditor ? (
        <WatchEditor
          watcher={watchEditor.watcher}
          onClose={() => setWatchEditor(null)}
          onSaved={() => {
            setWatchEditor(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function JobSection({
  title,
  tint,
  color,
  jobs,
  empty,
  busyId,
  onRun,
  onToggle,
  onEdit,
  onRemove,
}: {
  title: string;
  tint: string;
  color: string;
  jobs: AutomationJob[];
  empty: string;
  busyId: string | null;
  onRun: (job: AutomationJob) => void;
  onToggle: (job: AutomationJob) => void;
  onEdit: (job: AutomationJob) => void;
  onRemove: (job: AutomationJob) => void;
}) {
  if (!jobs.length && !empty) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[#5B5866]">
        {title}
        <span className="rounded-lg px-2 py-0.5 text-[12px] font-bold" style={{ background: tint, color }}>
          {jobs.length}
        </span>
      </h2>
      <div className="space-y-2">
        {jobs.length === 0 ? <p className="rounded-[16px] bg-white/60 px-4 py-4 text-[12.5px] text-[#A8A5B8]">{empty}</p> : null}
        {jobs.map((job) => {
          const status = job.lastStatus ? RUN_STATUS[job.lastStatus] : null;
          return (
            <article key={job.id} className="rounded-[16px] bg-white p-4 shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#F6F4FB]">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="truncate text-[15px] font-semibold text-[#1F1D2B]">{job.name}</h3>
                    <span className="rounded-full bg-[#F3EEFF] px-2 py-0.5 text-[10.5px] font-bold text-[#7C63F6]">{job.scheduleLabel}</span>
                    {status ? (
                      <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: status.bg, color: status.color }}>
                        {status.label}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.5] text-[#6B677A]">{job.prompt}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[#A8A5B8]">
                    <span className="flex items-center gap-1">
                      <Clock3 size={11} /> {job.enabled && job.nextRunAt ? `다음 ${clockLabel(job.nextRunAt)} (${relativeTime(job.nextRunAt)})` : '예약 꺼짐'}
                    </span>
                    {job.lastRunAt ? <span>마지막 {relativeTime(job.lastRunAt)}</span> : null}
                    {job.lastRun?.steps ? <span>{job.lastRun.steps}단계</span> : null}
                  </p>
                </div>
                <button
                  onClick={() => onToggle(job)}
                  className={`mt-0.5 flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition ${job.enabled ? 'bg-[#C9B8FF]' : 'bg-[#E4E1EF]'}`}
                  aria-label={job.enabled ? '멈추기' : '다시 켜기'}
                >
                  <span className={`h-5 w-5 rounded-full bg-white shadow transition ${job.enabled ? 'translate-x-[20px]' : 'translate-x-0'}`} />
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <button
                  className="flex items-center gap-1 rounded-xl bg-[#F1ECFF] px-2.5 py-1.5 text-[12px] font-semibold text-[#7C63F6] disabled:opacity-50"
                  onClick={() => onRun(job)}
                  disabled={busyId === job.id || job.running}
                >
                  {job.running ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />} 지금 실행
                </button>
                <button className="rounded-xl bg-[#FAF9FD] px-2.5 py-1.5 text-[12px] font-semibold text-[#6B677A]" onClick={() => onEdit(job)}>
                  편집
                </button>
                <button className="ml-auto rounded-xl bg-[#FFF6F6] px-2.5 py-1.5 text-[12px] text-[#E5484D]" onClick={() => onRemove(job)}>
                  <Trash2 size={12} />
                </button>
              </div>
              {job.lastRun?.result || job.lastRun?.error ? (
                <p className="mt-2 whitespace-pre-wrap rounded-[10px] bg-[#FAF9FD] px-2.5 py-2 text-[11.5px] leading-[1.5] text-[#6B677A]">
                  {(job.lastRun.result || job.lastRun.error || '').slice(0, 220)}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[#1F1D2B]/30 p-0 backdrop-blur-sm lg:items-center lg:p-6" onClick={onClose}>
      <div
        className="pa-scroll max-h-[88vh] w-full max-w-[520px] overflow-y-auto rounded-t-[26px] bg-white p-5 shadow-soft lg:rounded-[26px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[18px] font-bold text-[#1F1D2B]">{title}</h2>
          <button className="rounded-xl p-1.5 text-[#A8A5B8] hover:bg-[#FAF9FD]" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function JobEditor({ job, onClose, onSaved }: { job?: AutomationJob; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(job?.name || '');
  const [prompt, setPrompt] = useState(job?.prompt || '');
  const [cron, setCron] = useState(job?.cron || '0 8 * * *');
  const [maxSteps, setMaxSteps] = useState(job?.maxSteps || 6);
  const [preview, setPreview] = useState<{ runs: string[]; label: string; error?: string }>({ runs: [], label: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .get<{ nextRuns: string[]; label: string }>(`/api/jobs/preview?cron=${encodeURIComponent(cron)}`)
      .then((res) => {
        if (alive) setPreview({ runs: res.nextRuns, label: res.label });
      })
      .catch((err: unknown) => {
        if (alive) setPreview({ runs: [], label: '', error: err instanceof Error ? err.message : 'cron 오류' });
      });
    return () => {
      alive = false;
    };
  }, [cron]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = { name, prompt, cron, maxSteps };
      if (job) await api.patch(`/api/jobs/${job.id}`, body);
      else await api.post('/api/jobs', body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장하지 못했어요.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={job ? '예약 편집' : '예약 만들기'} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-[12.5px] font-semibold text-[#6B677A]">이름</span>
          <input className="pa-input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="예) 아침 브리핑" />
        </label>
        <label className="block">
          <span className="text-[12.5px] font-semibold text-[#6B677A]">깨어나면 할 일</span>
          <textarea
            className="pa-input mt-1 min-h-[96px] resize-none"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="예) 오늘 일정과 새 메일, 서버 상태를 요약해줘. 새 소식이 없으면 '조용함' 한 줄만."
          />
        </label>
        <div>
          <span className="text-[12.5px] font-semibold text-[#6B677A]">주기</span>
          <ScheduleField value={cron} onChange={setCron} />
          <p className="mt-1 text-[11.5px] text-[#A8A5B8]">
            {preview.error ? (
              <span className="text-[#E5484D]">{preview.error}</span>
            ) : (
              <>
                {preview.label} · 다음 {preview.runs.slice(0, 3).map((r) => clockLabel(r)).join(', ') || '계산 중…'}
              </>
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-[#6B677A]">
          최대 단계
          <select className="rounded-xl border border-[#E9E7F2] bg-white px-2 py-1.5 text-[13px]" value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))}>
            {[3, 4, 6, 8, 10, 12].map((n) => (
              <option key={n} value={n}>
                {n}단계
              </option>
            ))}
          </select>
          <span className="text-[11.5px] text-[#B4B1C2]">한 번 실행 시 AI가 도구를 연속 호출할 수 있는 최대 횟수</span>
        </label>
        <p className="rounded-[12px] bg-[#FFF8E7] px-3 py-2 text-[11.5px] leading-[1.5] text-[#9A7412]">
          예약 실행은 사람이 필요한 단계(결제·로그인·게시)를 스스로 하지 않고, 그 지점에서 멈춰 알려드려요.
        </p>
        {error ? <p className="text-[12.5px] text-[#E5484D]">{error}</p> : null}
        <div className="flex gap-2 pt-1">
          <button className="pa-btn-ghost flex-1" onClick={onClose}>
            취소
          </button>
          <button className="pa-btn-primary flex-1" onClick={save} disabled={saving || !name.trim() || !prompt.trim()}>
            <Check size={16} /> {job ? '저장' : '만들기'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function ScheduleField({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const parsed = parseCron(value);
  const [easy, setEasy] = useState<EasySchedule>(parsed || { mode: 'daily', hour: 8, minute: 0, weekday: 1, every: 30 });
  const [advanced, setAdvanced] = useState(!parsed);
  const lastSent = useRef('');

  useEffect(() => {
    if (value === lastSent.current) return;
    const next = parseCron(value);
    if (next) {
      setEasy(next);
      setAdvanced(false);
    } else {
      setAdvanced(true);
    }
  }, [value]);

  const apply = (next: EasySchedule) => {
    setEasy(next);
    const cron = buildCron(next);
    lastSent.current = cron;
    onChange(cron);
  };

  const modes: { id: RepeatMode; label: string }[] = [
    { id: 'daily', label: '매일' },
    { id: 'weekdays', label: '평일' },
    { id: 'weekly', label: '매주' },
    { id: 'minutes', label: 'N분마다' },
    { id: 'hours', label: 'N시간마다' },
  ];

  return (
    <div className="mt-1 rounded-2xl bg-[#FAF9FD] p-3">
      <div className="flex flex-wrap gap-1.5">
        {modes.map((mode) => (
          <button
            key={mode.id}
            onClick={() => apply({ ...easy, mode: mode.id })}
            className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${
              easy.mode === mode.id ? 'border-[#D6C9FF] bg-white text-[#7C63F6]' : 'border-transparent bg-white/60 text-[#8A8A9A]'
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {easy.mode === 'weekly' ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {WEEKDAYS.map((day) => (
            <button
              key={day.value}
              onClick={() => apply({ ...easy, weekday: day.value })}
              className={`h-8 w-8 rounded-full text-[12px] font-bold transition ${
                easy.weekday === day.value ? 'bg-[#7C63F6] text-white' : 'bg-white text-[#8A8A9A]'
              }`}
            >
              {day.label}
            </button>
          ))}
        </div>
      ) : null}

      {easy.mode === 'minutes' || easy.mode === 'hours' ? (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-[#5B5866]">
          <select
            className="rounded-xl border border-[#E9E7F2] bg-white px-2 py-1.5 text-[13px]"
            value={easy.every}
            onChange={(e) => apply({ ...easy, every: Number(e.target.value) })}
          >
            {(easy.mode === 'minutes' ? [5, 10, 15, 20, 30, 45] : [1, 2, 3, 4, 6, 8, 12]).map((n) => (
              <option key={n} value={n}>
                {n}
                {easy.mode === 'minutes' ? '분' : '시간'}
              </option>
            ))}
          </select>
          <span>마다 실행</span>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5 text-[13px] text-[#5B5866]">
          <select
            className="rounded-xl border border-[#E9E7F2] bg-white px-2 py-1.5 text-[13px]"
            value={easy.hour}
            onChange={(e) => apply({ ...easy, hour: Number(e.target.value) })}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}시
              </option>
            ))}
          </select>
          <select
            className="rounded-xl border border-[#E9E7F2] bg-white px-2 py-1.5 text-[13px]"
            value={easy.minute}
            onChange={(e) => apply({ ...easy, minute: Number(e.target.value) })}
          >
            {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
              <option key={m} value={m}>
                {String(m).padStart(2, '0')}분
              </option>
            ))}
          </select>
          <span className="ml-1 rounded-full bg-[#F1ECFF] px-2 py-0.5 text-[11.5px] font-bold text-[#7C63F6]">{scheduleSummary(easy)}</span>
        </div>
      )}

      <button
        className="mt-2 text-[11.5px] font-semibold text-[#A8A5B8] underline-offset-2 hover:underline"
        onClick={() => setAdvanced((v) => !v)}
      >
        고급(크론 직접 입력) {advanced ? '접기' : '열기'}
      </button>
      {advanced ? (
        <input
          className="pa-input mt-1.5 font-mono text-[13px]"
          value={value}
          onChange={(e) => {
            lastSent.current = e.target.value;
            onChange(e.target.value);
            const next = parseCron(e.target.value);
            if (next) setEasy(next);
          }}
          placeholder="0 8 * * *"
        />
      ) : null}
    </div>
  );
}

function WatchEditor({ watcher, onClose, onSaved }: { watcher?: Watcher; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(watcher?.name || '');
  const [url, setUrl] = useState(watcher?.url || '');
  const [mode, setMode] = useState<WatchMode>(watcher?.mode || 'price');
  const [target, setTarget] = useState(watcher?.target || '');
  const [interval, setInterval] = useState(watcher?.intervalMin || 30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = { name, url, mode, target: target || null, intervalMin: interval };
      if (watcher) await api.patch(`/api/watchers/${watcher.id}`, body);
      else await api.post('/api/watchers', body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장하지 못했어요.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={watcher ? '워치 편집' : '워치 만들기'} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-[12.5px] font-semibold text-[#6B677A]">이름</span>
          <input className="pa-input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="예) 이 상품 재입고" />
        </label>
        <label className="block">
          <span className="text-[12.5px] font-semibold text-[#6B677A]">주소</span>
          <input className="pa-input mt-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" />
        </label>
        <label className="block">
          <span className="text-[12.5px] font-semibold text-[#6B677A]">감시 방식</span>
          <select className="pa-input mt-1" value={mode} onChange={(e) => setMode(e.target.value as WatchMode)}>
            {(Object.keys(MODE_LABELS) as WatchMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11.5px] text-[#A8A5B8]">{MODE_HINT[mode]}</span>
        </label>
        {mode === 'selector' || mode === 'json' || mode === 'regex' || mode === 'github' ? (
          <label className="block">
            <span className="text-[12.5px] font-semibold text-[#6B677A]">
              {mode === 'selector' ? 'CSS 선택자' : mode === 'json' ? 'JSON 경로' : mode === 'regex' ? '정규식' : 'owner/repo'}
            </span>
            <input
              className="pa-input mt-1 font-mono text-[13px]"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={mode === 'selector' ? '.price' : mode === 'json' ? '$.items[0].price' : mode === 'regex' ? '(재고\\s*\\d+)' : 'owner/repo'}
            />
          </label>
        ) : null}
        <label className="block">
          <span className="text-[12.5px] font-semibold text-[#6B677A]">확인 주기</span>
          <div className="mt-1 flex gap-1.5">
            {[5, 15, 30, 60, 180].map((min) => (
              <button
                key={min}
                onClick={() => setInterval(min)}
                className={`flex-1 rounded-xl border px-2 py-1.5 text-[12px] font-semibold transition ${
                  interval === min ? 'border-[#D6C9FF] bg-[#F5F0FF] text-[#7C63F6]' : 'border-[#EFEDF6] bg-white text-[#8A8A9A]'
                }`}
              >
                {min < 60 ? `${min}분` : `${min / 60}시간`}
              </button>
            ))}
          </div>
        </label>
        <p className="rounded-[12px] bg-[#F7F5FF] px-3 py-2 text-[11.5px] leading-[1.5] text-[#6B4FD8]">
          감시는 페이지만 읽어요. 구매·예약은 하지 않아요(결제는 사람만).
        </p>
        {error ? <p className="text-[12.5px] text-[#E5484D]">{error}</p> : null}
        <div className="flex gap-2 pt-1">
          <button className="pa-btn-ghost flex-1" onClick={onClose}>
            취소
          </button>
          <button className="pa-btn-primary flex-1" onClick={save} disabled={saving || !name.trim() || !url.trim()}>
            <Check size={16} /> {watcher ? '저장' : '만들기'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
