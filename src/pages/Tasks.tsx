import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import Mascot from '../components/Mascot';
import { api, type Task } from '../lib/api';

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<{ tasks: Task[] }>('/api/tasks')
      .then((r) => setTasks(r.tasks))
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/tasks', { title, due: due || null });
      setTitle('');
      setDue('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (task: Task) => {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t)));
    await api.patch(`/api/tasks/${task.id}`, { done: !task.done }).catch(() => load());
  };

  const remove = async (task: Task) => {
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    await api.del(`/api/tasks/${task.id}`).catch(() => load());
  };

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-8 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[720px]">
        <header className="flex items-center gap-3">
          <div>
            <h1 className="text-[26px] font-bold tracking-[-0.02em] lg:text-[34px]">할 일</h1>
            <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">포몽이와 함께 오늘 할 일을 정리해요</p>
          </div>
          <Mascot name="lamong" hero={false} size={54} className="ml-auto lg:hidden" />
        </header>

        <div className="mt-5 flex flex-col gap-2 rounded-[24px] bg-white p-3 shadow-card ring-1 ring-[#F6F4FB] sm:flex-row sm:items-center">
          <input
            className="flex-1 bg-transparent px-2 py-2 text-[15px] placeholder:text-[#B7B4C6] focus:outline-none"
            placeholder="할 일을 입력하세요"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <input
            type="time"
            className="rounded-xl bg-[#FAF9FD] px-3 py-2 text-[14px] text-[#5B5866] focus:outline-none"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <button className="pa-btn-primary px-4 py-2.5" onClick={add} disabled={busy || !title.trim()}>
            <Plus size={16} /> 추가
          </button>
        </div>

        <section className="mt-6">
          <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[#5B5866]">
            진행 중 <span className="rounded-lg bg-[#F3EEFF] px-2 py-0.5 text-[12px] text-[#8B72F6]">{open.length}</span>
          </h2>
          <ul className="space-y-2">
            {open.map((task) => (
              <li key={task.id} className="flex items-center gap-3 rounded-[20px] bg-white px-4 py-3.5 shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#F6F4FB]">
                <button
                  onClick={() => toggle(task)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.8px] border-[#D9D2F5] transition hover:border-[#A88BFF]"
                  aria-label="완료"
                />
                <span className="flex-1 text-[15px] text-[#2A2A35]">{task.title}</span>
                {task.due ? <span className="text-[13px] text-[#9B98AB]">{task.due}</span> : null}
                <button className="text-[#DDD9E8] hover:text-[#E5484D]" onClick={() => remove(task)} aria-label="삭제">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
            {open.length === 0 ? (
              <li className="rounded-[20px] border border-dashed border-[#E7E3F3] px-4 py-8 text-center text-[13.5px] text-[#A8A5B8]">
                오늘 할 일이 없어요. 위에서 추가해 보세요!
              </li>
            ) : null}
          </ul>
        </section>

        {done.length > 0 ? (
          <section className="mt-6">
            <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[#5B5866]">
              완료 <span className="rounded-lg bg-[#EBFBF3] px-2 py-0.5 text-[12px] text-[#12B886]">{done.length}</span>
            </h2>
            <ul className="space-y-2">
              {done.map((task) => (
                <li key={task.id} className="flex items-center gap-3 rounded-[20px] bg-[#FBFBFD] px-4 py-3.5 ring-1 ring-[#F2F0F8]">
                  <button
                    onClick={() => toggle(task)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#BCF4DE] text-[11px] font-bold text-[#0F9668]"
                    aria-label="되돌리기"
                  >
                    ✓
                  </button>
                  <span className="flex-1 text-[15px] text-[#B4B1C2] line-through">{task.title}</span>
                  <button className="text-[#DDD9E8] hover:text-[#E5484D]" onClick={() => remove(task)} aria-label="삭제">
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
