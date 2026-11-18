import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, Check, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import BackButton from '../components/BackButton';
import Mascot from '../components/Mascot';
import { api, type MemoryCategory, type MemoryItem } from '../lib/api';
import { formatRelative } from '../lib/format';

const CATEGORY_TINT: Record<string, { bg: string; color: string }> = {
  profile: { bg: '#F1ECFF', color: '#7C63F6' },
  taste: { bg: '#FFEFF3', color: '#E2568B' },
  habit: { bg: '#EAF6FF', color: '#2F86D8' },
  person: { bg: '#FFF6E7', color: '#C08A16' },
  promise: { bg: '#EDF8EE', color: '#3FA34D' },
  project: { bg: '#F3EEE7', color: '#8A6D4B' },
  rule: { bg: '#FFECEC', color: '#D9534F' },
  other: { bg: '#F4F3F9', color: '#8A8A9A' },
};

export default function MemoryPage() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [categories, setCategories] = useState<MemoryCategory[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState('');

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2000);
  };

  const load = useCallback(async () => {
    const res = await api
      .get<{ memories: MemoryItem[]; categories: MemoryCategory[] }>('/api/memory')
      .catch(() => ({ memories: [], categories: [] }));
    setItems(res.memories);
    setCategories(res.categories);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => (filter === 'all' || item.category === filter) && (!q || item.content.toLowerCase().includes(q)));
  }, [items, filter, query]);

  const label = (id: string) => categories.find((c) => c.id === id)?.label || '기타';

  const remove = async (item: MemoryItem) => {
    if (!window.confirm(`이 기억을 지울까요?\n\n${item.content}`)) return;
    await api.del(`/api/memory/${item.id}`);
    void load();
    flash('기억을 지웠습니다');
  };

  return (
    <div className="pa-scroll relative h-full min-h-0 overflow-y-auto px-4 pb-10 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[860px]">
        <header className="flex items-center gap-2">
          <BackButton />
          <div className="min-w-0 flex-1">
            <h1 className="text-[26px] font-bold tracking-[-0.02em] lg:text-[34px]">기억함</h1>
            <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">
              AI가 스스로 기억한 취향·습관·약속 <b className="text-[#7C63F6]">{items.length}</b>개 · 대화마다 다시 참고해요
            </p>
          </div>
          <Mascot name="minti" size={56} />
        </header>

        <div className="mt-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#B7B4C6]" />
            <input className="pa-input pl-10" placeholder="기억 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button className="pa-btn-primary shrink-0 px-4 py-3 text-[13px]" onClick={() => setShowAdd(true)}>
            <Plus size={16} /> 기억 추가
          </button>
        </div>

        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {[{ id: 'all', label: '전체' }, ...categories].map((category) => (
            <button
              key={category.id}
              onClick={() => setFilter(category.id)}
              className={`pa-chip shrink-0 ${filter === category.id ? 'pa-chip-active' : ''}`}
            >
              {category.label}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          {visible.map((item) => {
            const tint = CATEGORY_TINT[item.category] || CATEGORY_TINT.other;
            return (
              <article key={item.id} className="rounded-[18px] bg-white p-4 shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#F6F4FB]">
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" style={{ background: tint.bg, color: tint.color }}>
                    <Brain size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: tint.bg, color: tint.color }}>
                        {label(item.category)}
                      </span>
                      <span className="text-[10.5px] text-[#C0BCCD]">{'●'.repeat(item.importance)}{'○'.repeat(5 - item.importance)}</span>
                      {item.source === 'chat' ? (
                        <span className="flex items-center gap-0.5 text-[10.5px] text-[#B9A8FF]">
                          <Sparkles size={10} /> 자동 저장
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-[1.6] text-[#2A2A35]">{item.content}</p>
                    <p className="mt-1 text-[11px] text-[#B4B1C2]">{formatRelative(item.updatedAt)} 갱신</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button className="rounded-lg p-1.5 text-[#C9C5D6] hover:text-[#7C63F6]" onClick={() => setEditing(item)} aria-label="수정">
                      <Pencil size={14} />
                    </button>
                    <button className="rounded-lg p-1.5 text-[#D9D5E4] hover:text-[#E5484D]" onClick={() => remove(item)} aria-label="삭제">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {!visible.length ? (
            <div className="rounded-[20px] border border-dashed border-[#E7E3F3] bg-white/60 px-4 py-12 text-center">
              <p className="text-[13.5px] text-pomong-sub">
                {items.length ? '검색 결과가 없습니다.' : '아직 기억이 없어요. 대화를 나누면 AI가 스스로 기억하기 시작해요.'}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {toast ? (
        <div className="pointer-events-none fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#2A2A35] px-5 py-2.5 text-[13px] font-medium text-white shadow-lg">
          {toast}
        </div>
      ) : null}

      {(showAdd || editing) && (
        <MemoryModal
          categories={categories}
          initial={editing}
          onClose={() => {
            setShowAdd(false);
            setEditing(null);
          }}
          onSaved={(message) => {
            setShowAdd(false);
            setEditing(null);
            void load();
            flash(message);
          }}
        />
      )}
    </div>
  );
}

function MemoryModal({
  initial,
  categories,
  onClose,
  onSaved,
}: {
  initial: MemoryItem | null;
  categories: MemoryCategory[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [content, setContent] = useState(initial?.content || '');
  const [category, setCategory] = useState(initial?.category || 'other');
  const [importance, setImportance] = useState(initial?.importance || 3);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (initial) {
        await api.patch(`/api/memory/${initial.id}`, { content, category, importance });
      } else {
        await api.post('/api/memory', { content, category, importance });
      }
      onSaved(initial ? '기억을 고쳤습니다' : '기억을 추가했습니다');
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[#1F1D2B]/30 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div className="w-full max-w-[480px] rounded-t-[26px] bg-white p-5 shadow-2xl sm:rounded-[26px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[18px] font-bold">{initial ? '기억 수정' : '기억 추가'}</h2>
          <button className="rounded-xl p-1.5 text-[#A8A5B8]" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <textarea
            className="pa-input min-h-[96px] resize-none"
            placeholder="예) 아침 브리핑은 강원도 인제 날씨로 받고 싶어 한다"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div>
            <span className="text-[12.5px] font-semibold text-[#6B677A]">분류</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {categories.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setCategory(item.id)}
                  className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold transition ${
                    category === item.id ? 'border-[#D6C9FF] bg-[#F5F0FF] text-[#7C63F6]' : 'border-[#EFEDF6] bg-white text-[#8A8A9A]'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 text-[12.5px] text-[#6B677A]">
            중요도
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setImportance(n)}
                className={`h-7 w-7 rounded-full text-[12px] font-bold ${importance === n ? 'bg-[#7C63F6] text-white' : 'bg-[#FAF9FD] text-[#8A8A9A]'}`}
              >
                {n}
              </button>
            ))}
            <span className="text-[11.5px] text-[#B4B1C2]">높을수록 매 대화에 항상 넣어요</span>
          </div>
          {error ? <p className="text-[12.5px] text-[#E5484D]">{error}</p> : null}
        </div>
        <div className="mt-4 flex gap-2">
          <button className="pa-btn-ghost flex-1" onClick={onClose}>
            취소
          </button>
          <button className="pa-btn-primary flex-1" onClick={save} disabled={busy || !content.trim()}>
            <Check size={16} /> 저장
          </button>
        </div>
      </div>
    </div>
  );
}
