import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, Flag, Pencil, Plus, Trash2, X } from 'lucide-react';
import MascotFace from '../components/MascotFace';
import { api, type Task, type TaskCounts, type TaskPriority } from '../lib/api';
import { useAppStore } from '../lib/store';

const PRIORITY_META: Record<TaskPriority, { label: string; color: string; bg: string; border: string }> = {
  high: { label: '높음', color: '#E5484D', bg: '#FFF1F1', border: '#FBD5D6' },
  normal: { label: '보통', color: '#7C63F6', bg: '#F3EEFF', border: '#E3D9FF' },
  low: { label: '낮음', color: '#6B677A', bg: '#F4F3F9', border: '#E7E4F1' },
};

function dueParts(due: string | null): { date: string; time: string } | null {
  if (!due) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(due);
  if (!m) return due.includes(':') ? { date: '', time: due } : { date: due, time: '' };
  return { date: `${Number(m[2])}월 ${Number(m[3])}일`, time: m[4] || '' };
}

function isOverdue(task: Task): boolean {
  if (!task.due || task.done) return false;
  const stamp = task.due.includes('T') ? new Date(task.due) : new Date(`${task.due}T23:59`);
  return !Number.isNaN(stamp.getTime()) && stamp.getTime() < Date.now();
}

function toLocalInput(due: string | null): string {
  if (!due) return '';
  if (due.includes('T')) return due.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return `${due}T09:00`;
  return '';
}

export default function Tasks() {
  const { profile } = useAppStore();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [counts, setCounts] = useState<TaskCounts>({ all: 0, open: 0, done: 0, high: 0 });
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'open' | 'done' | 'all'>('open');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDue, setEditDue] = useState('');
  const [editPriority, setEditPriority] = useState<TaskPriority>('normal');

  const load = () =>
    api
      .get<{ tasks: Task[]; counts: TaskCounts }>('/api/tasks')
      .then((r) => {
        setTasks(r.tasks);
        setCounts(r.counts);
      })
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/tasks', { title, due: due || null, priority });
      setTitle('');
      setDue('');
      setPriority('normal');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const patch = async (task: Task, body: Record<string, unknown>) => {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, ...body } : t)));
    try {
      const r = await api.patch<{ task: Task }>(`/api/tasks/${task.id}`, body);
      setTasks((prev) => prev.map((t) => (t.id === task.id ? r.task : t)));
      load();
    } catch {
      load();
    }
  };

  const remove = async (task: Task) => {
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    await api.del(`/api/tasks/${task.id}`).catch(() => load());
    load();
  };

  const startEdit = (task: Task) => {
    setEditing(task.id);
    setEditTitle(task.title);
    setEditDue(toLocalInput(task.due));
    setEditPriority(task.priority);
  };

  const saveEdit = async (task: Task) => {
    if (!editTitle.trim()) return;
    await patch(task, { title: editTitle.trim(), due: editDue || null, priority: editPriority });
    setEditing(null);
  };

  const visible = useMemo(
    () =>
      tasks.filter(
        (t) =>
          (statusFilter === 'all' ? true : statusFilter === 'done' ? t.done : !t.done) &&
          (priorityFilter === 'all' ? true : t.priority === priorityFilter)
      ),
    [tasks, statusFilter, priorityFilter]
  );

  const openList = visible.filter((t) => !t.done);
  const doneList = visible.filter((t) => t.done);

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-8 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[760px]">
        <header className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[26px] font-bold tracking-[-0.02em] lg:text-[34px]">할 일</h1>
            <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">
              진행 중 <b className="text-[#7C63F6]">{counts.open}</b>개 · 오늘 우선순위 높은 일 <b className="text-[#E5484D]">{counts.high}</b>개
            </p>
          </div>
          <MascotFace character={profile.character} state={counts.open > 0 ? 'working' : 'idle'} size={56} className="lg:hidden" />
        </header>

        {/* quick add */}
        <div className="mt-5 rounded-[24px] bg-white p-3 shadow-card ring-1 ring-[#F6F4FB]">
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-[15px] placeholder:text-[#B7B4C6] focus:outline-none"
              placeholder="할 일을 입력하고 Enter"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button className="pa-btn-primary shrink-0 px-4 py-2.5" onClick={add} disabled={busy || !title.trim()}>
              <Plus size={16} /> 추가
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[#F6F4FB] pt-2">
            <label className="flex items-center gap-1.5 rounded-xl bg-[#FAF9FD] px-2.5 py-1.5 text-[12.5px] text-[#6B677A]">
              <CalendarDays size={13} className="text-[#B9A8FF]" />
              <input
                type="datetime-local"
                className="bg-transparent text-[12.5px] text-[#5B5866] focus:outline-none"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
            <div className="flex items-center gap-1 rounded-xl bg-[#FAF9FD] p-1">
              <Flag size={12} className="ml-1 text-[#B9A8FF]" />
              {(Object.keys(PRIORITY_META) as TaskPriority[]).map((p) => {
                const meta = PRIORITY_META[p];
                const active = priority === p;
                return (
                  <button
                    key={p}
                    onClick={() => setPriority(p)}
                    className="rounded-lg px-2 py-1 text-[12px] font-semibold transition"
                    style={active ? { background: meta.bg, color: meta.color } : { color: '#9B98AB' }}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* filters */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex rounded-full bg-[#F4F3F9] p-1">
            {(
              [
                ['open', '진행 중'],
                ['done', '완료'],
                ['all', '전체'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition ${
                  statusFilter === value ? 'bg-white text-[#7C63F6] shadow-sm' : 'text-[#8A8A9A]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {(['all', 'high', 'normal', 'low'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPriorityFilter(p)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${
                  priorityFilter === p
                    ? 'border-[#D6C9FF] bg-[#F5F0FF] text-[#7C63F6]'
                    : 'border-[#EFEDF6] bg-white text-[#8A8A9A]'
                }`}
              >
                {p === 'all' ? '모든 우선순위' : PRIORITY_META[p].label}
              </button>
            ))}
          </div>
        </div>

        <section className="mt-4 space-y-2">
          {openList.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              editing={editing === task.id}
              editTitle={editTitle}
              editDue={editDue}
              editPriority={editPriority}
              onEditTitle={setEditTitle}
              onEditDue={setEditDue}
              onEditPriority={setEditPriority}
              onStartEdit={() => startEdit(task)}
              onCancelEdit={() => setEditing(null)}
              onSaveEdit={() => saveEdit(task)}
              onToggle={() => patch(task, { done: !task.done })}
              onRemove={() => remove(task)}
            />
          ))}
          {openList.length === 0 ? (
            <div className="rounded-[20px] border border-dashed border-[#E7E3F3] bg-white/60 px-4 py-10 text-center text-[13.5px] text-[#A8A5B8]">
              {statusFilter === 'done' ? '완료한 일이 아직 없어요.' : '할 일이 비어 있어요. 위에서 하나 추가해 볼까요?'}
            </div>
          ) : null}
        </section>

        {doneList.length > 0 ? (
          <section className="mt-6">
            <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[#5B5866]">
              완료 <span className="rounded-lg bg-[#EBFBF3] px-2 py-0.5 text-[12px] text-[#12B886]">{doneList.length}</span>
            </h2>
            <div className="space-y-2">
              {doneList.map((task) => (
                <div key={task.id} className="flex items-center gap-3 rounded-[20px] bg-[#FBFBFD] px-4 py-3 ring-1 ring-[#F2F0F8]">
                  <button
                    onClick={() => patch(task, { done: false })}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#BCF4DE] text-[11px] font-bold text-[#0F9668]"
                    aria-label="되돌리기"
                  >
                    ✓
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[15px] text-[#B4B1C2] line-through">{task.title}</span>
                  <button className="text-[#DDD9E8] hover:text-[#E5484D]" onClick={() => remove(task)} aria-label="삭제">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  editing,
  editTitle,
  editDue,
  editPriority,
  onEditTitle,
  onEditDue,
  onEditPriority,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggle,
  onRemove,
}: {
  task: Task;
  editing: boolean;
  editTitle: string;
  editDue: string;
  editPriority: TaskPriority;
  onEditTitle: (v: string) => void;
  onEditDue: (v: string) => void;
  onEditPriority: (v: TaskPriority) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const meta = PRIORITY_META[task.priority] || PRIORITY_META.normal;
  const due = dueParts(task.due);
  const overdue = isOverdue(task);

  if (editing) {
    return (
      <div className="rounded-[20px] bg-white p-3.5 shadow-card ring-1 ring-[#E3D9FF]">
        <input
          className="w-full rounded-xl bg-[#FAF9FD] px-3 py-2 text-[15px] focus:outline-none"
          value={editTitle}
          onChange={(e) => onEditTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSaveEdit()}
          autoFocus
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            className="rounded-xl bg-[#FAF9FD] px-2.5 py-1.5 text-[12.5px] text-[#5B5866] focus:outline-none"
            value={editDue}
            onChange={(e) => onEditDue(e.target.value)}
          />
          <div className="flex items-center gap-1 rounded-xl bg-[#FAF9FD] p-1">
            {(Object.keys(PRIORITY_META) as TaskPriority[]).map((p) => (
              <button
                key={p}
                onClick={() => onEditPriority(p)}
                className="rounded-lg px-2 py-1 text-[12px] font-semibold"
                style={editPriority === p ? { background: PRIORITY_META[p].bg, color: PRIORITY_META[p].color } : { color: '#9B98AB' }}
              >
                {PRIORITY_META[p].label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button className="rounded-xl p-2 text-[#A8A5B8] hover:bg-[#FAF9FF]" onClick={onCancelEdit} aria-label="취소">
              <X size={16} />
            </button>
            <button className="rounded-xl bg-[#F3EEFF] p-2 text-[#7C63F6]" onClick={onSaveEdit} aria-label="저장">
              <Check size={16} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-[20px] bg-white px-4 py-3.5 shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#F6F4FB]">
      <button
        onClick={onToggle}
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.8px] transition hover:border-[#A88BFF]"
        style={{ borderColor: meta.border, background: task.priority === 'high' ? '#FFF7F7' : undefined }}
        aria-label="완료"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="rounded-md px-1.5 py-0.5 text-[10.5px] font-bold"
            style={{ background: meta.bg, color: meta.color }}
          >
            {meta.label}
          </span>
          <span className="break-words text-[15px] text-[#2A2A35]">{task.title}</span>
        </div>
        {due || task.notes ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
            {due ? (
              <span className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium ${overdue ? 'bg-[#FFF1F1] text-[#E5484D]' : 'bg-[#FAF9FD] text-[#8A8A9A]'}`}>
                <CalendarDays size={11} />
                {[due.date, due.time].filter(Boolean).join(' ')}
                {overdue ? ' · 기한 지남' : ''}
              </span>
            ) : null}
            {task.notes ? <span className="truncate text-[#A8A5B8]">{task.notes}</span> : null}
          </div>
        ) : null}
      </div>
      <button className="mt-0.5 text-[#D9D5E4] transition hover:text-[#7C63F6]" onClick={onStartEdit} aria-label="수정">
        <Pencil size={15} />
      </button>
      <button className="mt-0.5 text-[#DDD9E8] transition hover:text-[#E5484D]" onClick={onRemove} aria-label="삭제">
        <Trash2 size={15} />
      </button>
    </div>
  );
}
