import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  RotateCw as RotateCwIcon,
  Download,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import BackButton from '../components/BackButton';
import Mascot from '../components/Mascot';
import { api, type FileItem } from '../lib/api';
import { formatRelative } from '../lib/format';

/**
 * 받은 파일 · 결과물 보관함 (v0.5.5)
 *
 * 채팅에 올린 첨부(사진·PDF·문서), AI가 연 브라우저가 저장한 화면, AI가 만들어 준
 * 결과물을 한곳에 모아 본다. 사진은 바로 미리 보기, 파일은 내려받기, 더 필요 없는
 * 파일은 지우기. 목록·삭제는 서버 API(`/api/files`)가 경로 탈출을 막고 처리한다.
 */

const SOURCE_META: Record<FileItem['source'], { label: string; tint: string; color: string; icon: typeof MessageSquare }> = {
  chat: { label: '채팅', tint: '#F1ECFF', color: '#7C63F6', icon: MessageSquare },
  browser: { label: '브라우저', tint: '#EAF6FF', color: '#2F86D8', icon: Globe },
  agent: { label: 'AI 결과물', tint: '#FFEFF3', color: '#E2568B', icon: Bot },
};

const KIND_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'image', label: '사진' },
  { id: 'pdf', label: 'PDF' },
  { id: 'text', label: '문서' },
  { id: 'other', label: '기타' },
];

const SOURCE_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: '출처 전체' },
  { id: 'chat', label: '채팅' },
  { id: 'browser', label: '브라우저' },
  { id: 'agent', label: 'AI 결과물' },
];

function fileSize(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function kindLabel(item: FileItem): string {
  if (item.kind === 'image') return '사진';
  if (item.kind === 'pdf') return 'PDF';
  if (item.kind === 'text') return '문서';
  const ext = item.name.includes('.') ? item.name.split('.').pop()?.toUpperCase() : '';
  return ext ? `${ext} 파일` : '파일';
}

export default function FilesPage() {
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState('all');
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2200);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ files: FileItem[]; totals: { count: number; bytes: number; images: number; missing: number } }>(
        '/api/files'
      );
      setItems(res.files);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (item) =>
        (kind === 'all' || item.kind === kind) &&
        (source === 'all' || item.source === source) &&
        (!q || item.name.toLowerCase().includes(q))
    );
  }, [items, kind, source, query]);

  const totalBytes = useMemo(() => items.reduce((sum, item) => sum + (Number(item.size) || 0), 0), [items]);
  const imageCount = useMemo(() => items.filter((item) => item.kind === 'image').length, [items]);

  const remove = async (item: FileItem) => {
    if (!window.confirm(`파일함에서 이 파일을 지울까요?\n\n${item.name}`)) return;
    setBusy(item.id);
    try {
      await api.del(`/api/files/${encodeURIComponent(item.id)}`);
      setItems((prev) => prev.filter((f) => f.id !== item.id));
      flash('파일을 지웠습니다');
      if (preview?.id === item.id) setPreview(null);
    } catch {
      flash('파일을 지우지 못했어요');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pa-scroll relative h-full min-h-0 overflow-y-auto px-4 pb-10 pt-4 lg:px-10 lg:pt-8">
      <header className="flex items-center gap-2">
        <BackButton />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-[-0.02em] lg:text-[24px]">
            <FolderOpen size={21} className="text-[#7C63F6]" /> 파일함
          </h1>
          <p className="mt-0.5 hidden text-[12.5px] text-pomong-sub sm:block">
            채팅 첨부 · 브라우저 저장 · AI 결과물을 한곳에서
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex h-10 w-10 shrink-0 items-center justify-center gap-1.5 rounded-2xl bg-white text-[12.5px] font-semibold text-[#6B677A] ring-1 ring-[#EFEDF6] sm:w-auto sm:px-3"
          aria-label="새로고침"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RotateCwIcon />} <span className="hidden sm:inline">새로고침</span>
        </button>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[#8A8A9A]">
        <span>
          파일 <b className="text-[#3B3947]">{items.length}</b>개
        </span>
        <span>
          사진 <b className="text-[#3B3947]">{imageCount}</b>장
        </span>
        <span>
          합계 <b className="text-[#3B3947]">{fileSize(totalBytes)}</b>
        </span>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-[16px] bg-white px-3 py-2.5 shadow-[0_2px_10px_rgba(90,80,160,0.05)] ring-1 ring-[#F1EFF8]">
        <Search size={16} className="shrink-0 text-[#B7B4C6]" />
        <input
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[#B7B4C6]"
          placeholder="파일 이름으로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button className="rounded-lg p-1 text-[#A8A5B8]" onClick={() => setQuery('')} aria-label="검색 지우기">
            <X size={15} />
          </button>
        ) : null}
      </div>

      <div className="pa-scroll mt-3 flex gap-1.5 overflow-x-auto pb-1">
        {KIND_FILTERS.map((filter) => (
          <button
            key={filter.id}
            onClick={() => setKind(filter.id)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
              kind === filter.id ? 'bg-[#F1ECFF] text-[#7C63F6]' : 'bg-white text-[#8A8A9A] ring-1 ring-[#F1EFF8]'
            }`}
          >
            {filter.label}
          </button>
        ))}
        <span className="mx-1 w-px shrink-0 bg-[#EFEDF6]" />
        {SOURCE_FILTERS.map((filter) => (
          <button
            key={filter.id}
            onClick={() => setSource(filter.id)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
              source === filter.id ? 'bg-[#EAF6FF] text-[#2F86D8]' : 'bg-white text-[#8A8A9A] ring-1 ring-[#F1EFF8]'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {loading && !items.length ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-[13px] text-[#A8A5B8]">
          <Mascot name="pimong-think" size={84} className="animate-float" />
          파일을 모으는 중…
        </div>
      ) : null}

      {!loading && !items.length ? (
        <div className="mt-14 flex flex-col items-center gap-3 text-center">
          <Mascot name="pimong" hero size={104} className="animate-float" />
          <p className="text-[15px] font-semibold text-[#3B3947]">아직 모인 파일이 없어요</p>
          <p className="max-w-[320px] text-[13px] leading-relaxed text-pomong-sub">
            채팅에 사진·파일을 붙이거나, AI에게 “이 내용을 파일로 저장해줘”라고 하면 여기에 차곡차곡 쌓여요.
          </p>
        </div>
      ) : null}

      {items.length && !visible.length ? (
        <p className="mt-12 text-center text-[13px] text-[#A8A5B8]">조건에 맞는 파일이 없어요.</p>
      ) : null}

      <ul className="mt-3 space-y-2">
        {visible.map((item) => {
          const meta = SOURCE_META[item.source];
          return (
            <li
              key={item.id}
              className="flex items-center gap-3 rounded-[18px] bg-white px-3 py-2.5 shadow-[0_2px_12px_rgba(90,80,160,0.05)] ring-1 ring-[#F4F2FA]"
            >
              {item.kind === 'image' && item.exists ? (
                <button
                  className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[14px] bg-[#F6F4FB]"
                  onClick={() => setPreview(item)}
                  aria-label={`${item.name} 크게 보기`}
                >
                  <img src={item.previewUrl} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                </button>
              ) : (
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[14px] bg-[#F7F5FF] text-[#7C63F6]">
                  {item.kind === 'image' ? <ImageIcon size={22} /> : <FileText size={22} />}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-[#2A2A35]">{item.name}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-[#A8A5B8]">
                  <span>{kindLabel(item)}</span>
                  <span>·</span>
                  <span>{fileSize(item.size)}</span>
                  <span>·</span>
                  <span>{formatRelative(item.createdAt)}</span>
                  {!item.exists ? <span className="text-[#E5484D]">· 서버에 없음</span> : null}
                </p>
                <span
                  className="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[10.5px] font-bold"
                  style={{ background: meta.tint, color: meta.color }}
                >
                  <meta.icon size={10} /> {meta.label}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <a
                  href={item.downloadUrl}
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-[#6B677A] transition hover:bg-[#F7F5FF] active:scale-95"
                  aria-label={`${item.name} 내려받기`}
                  title="내려받기"
                >
                  <Download size={17} />
                </a>
                <button
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-[#C9C5D6] transition hover:bg-[#FFF1F1] hover:text-[#E5484D] active:scale-95 disabled:opacity-40"
                  onClick={() => void remove(item)}
                  disabled={busy === item.id}
                  aria-label={`${item.name} 지우기`}
                  title="지우기"
                >
                  {busy === item.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-6 text-center text-[11.5px] leading-relaxed text-[#C0BCCD]">
        파일은 이 서버의 data 폴더 안에만 저장돼요. 채팅에 올린 사진·파일은 지우면 대화에서도 사라져요.
      </p>

      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 lg:bottom-10">
          <span className="rounded-full bg-[#2A2A35] px-4 py-2 text-[12.5px] font-medium text-white shadow-lg">{toast}</span>
        </div>
      ) : null}

      {preview ? (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-4"
          onClick={() => setPreview(null)}
          role="button"
          aria-label="사진 닫기"
        >
          <img
            src={preview.previewUrl}
            alt={preview.name}
            className="max-h-[78vh] max-w-full rounded-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[12px] text-white" onClick={(e) => e.stopPropagation()}>
            <span className="max-w-[46vw] truncate">{preview.name}</span>
            <span className="text-white/50">·</span>
            <a href={preview.downloadUrl} className="flex items-center gap-1 font-semibold text-[#C9B8FF]">
              <Download size={13} /> 내려받기
            </a>
          </div>
          <button
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white"
            onClick={() => setPreview(null)}
            aria-label="닫기"
          >
            <X size={20} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
