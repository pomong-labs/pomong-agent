import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Check,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Globe,
  KeyRound,
  Lock,
  MoreVertical,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import Mascot from '../components/Mascot';
import { api, ApiError, type VaultItem, type VaultStatus } from '../lib/api';
import { formatDate, formatRelative } from '../lib/format';

const TYPE_META = {
  apikey: { label: 'API 키', bg: '#F3EEFF', fg: '#8B72F6', icon: KeyRound },
  login: { label: '로그인', bg: '#EBFBF3', fg: '#12B886', icon: Globe },
  memo: { label: '메모', bg: '#FFF6E7', fg: '#E49B18', icon: FileText },
} as const;

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export default function Vault() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'apikey' | 'login' | 'memo'>('all');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 1800);
  };

  const loadStatus = useCallback(async () => {
    const s = await api.get<VaultStatus & { ok: true }>('/api/vault/status');
    setStatus(s);
    return s;
  }, []);

  const loadItems = useCallback(async () => {
    try {
      const r = await api.get<{ items: VaultItem[] }>('/api/vault/items');
      setItems(r.items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        setItems([]);
        await loadStatus();
      }
    }
  }, [loadStatus]);

  useEffect(() => {
    loadStatus().catch(() => undefined);
  }, [loadStatus]);

  useEffect(() => {
    if (status?.unlocked) loadItems();
  }, [status?.unlocked, loadItems]);

  const unlock = async () => {
    setBusy(true);
    setError('');
    try {
      if (!status?.configured) {
        if (pin.length < 4) throw new Error('PIN은 4자리 이상 숫자로 정해 주세요.');
        if (pin !== pin2) throw new Error('PIN이 서로 다릅니다.');
        await api.post('/api/vault/init', { pin });
      } else {
        await api.post('/api/vault/unlock', { pin });
      }
      setPin('');
      setPin2('');
      const s = await loadStatus();
      if (s.unlocked) await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : '금고를 열지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    await api.post('/api/vault/lock').catch(() => undefined);
    setItems([]);
    setRevealed({});
    await loadStatus();
    flash('금고를 잠갔습니다');
  };

  const reveal = async (item: VaultItem) => {
    if (revealed[item.id]) {
      const next = { ...revealed };
      delete next[item.id];
      setRevealed(next);
      return;
    }
    try {
      const r = await api.get<{ secret: string; username: string }>(`/api/vault/items/${item.id}/reveal`);
      setRevealed((prev) => ({ ...prev, [item.id]: r.username ? `${r.username}\n${r.secret}` : r.secret }));
    } catch (err) {
      flash(err instanceof Error ? err.message : '표시할 수 없습니다.');
    }
  };

  const copy = async (item: VaultItem) => {
    try {
      const r = await api.get<{ secret: string; username: string }>(`/api/vault/items/${item.id}/reveal`);
      const ok = await copyText(item.type === 'login' && r.username ? `${r.username}` : r.secret);
      flash(ok ? '복사했습니다' : '복사 권한이 없습니다');
      loadItems();
    } catch (err) {
      flash(err instanceof Error ? err.message : '복사할 수 없습니다.');
    }
  };

  const remove = async (item: VaultItem) => {
    if (!window.confirm(`'${item.title}' 항목을 삭제할까요?`)) return;
    await api.del(`/api/vault/items/${item.id}`).catch(() => undefined);
    loadItems();
    loadStatus();
    flash('삭제했습니다');
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => (filter === 'all' ? true : i.type === filter) && (!q || i.title.toLowerCase().includes(q) || i.masked.toLowerCase().includes(q)));
  }, [items, filter, query]);

  /* ---------------- locked / setup ---------------- */
  if (!status || !status.unlocked) {
    const configuring = status && !status.configured;
    return (
      <div className="flex h-full flex-col items-center justify-center px-5">
        <div className="w-full max-w-[400px] text-center">
          <div className="relative mx-auto w-fit">
            <div className="absolute inset-0 -z-10 rounded-full bg-[#FFF6E0] blur-2xl" />
            <Mascot name={configuring ? 'poding' : 'poding'} hero size={132} className="mx-auto animate-float" />
          </div>
          <h1 className="mt-3 text-[26px] font-bold tracking-[-0.02em]">
            {configuring ? '금고를 만들어요' : '금고가 잠겨 있어요'}
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-pomong-sub">
            {configuring
              ? 'PIN을 정하면 API 키와 로그인 정보를 AES-256으로 암호화해 보관합니다.'
              : 'PIN을 입력하면 다시 열 수 있어요.'}
          </p>

          <div className="mt-6 rounded-[26px] bg-white p-5 text-left shadow-card ring-1 ring-[#F6F4FB]">
            <label className="mb-2 block text-[13px] font-semibold text-[#3B3947]">{configuring ? '새 PIN (4~12자리)' : 'PIN'}</label>
            <input
              className="pa-input text-center text-[20px] tracking-[0.4em]"
              type="password"
              inputMode="numeric"
              placeholder="••••"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
              onKeyDown={(e) => e.key === 'Enter' && unlock()}
            />
            {configuring ? (
              <>
                <label className="mb-2 mt-3 block text-[13px] font-semibold text-[#3B3947]">PIN 확인</label>
                <input
                  className="pa-input text-center text-[20px] tracking-[0.4em]"
                  type="password"
                  inputMode="numeric"
                  placeholder="••••"
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, '').slice(0, 12))}
                  onKeyDown={(e) => e.key === 'Enter' && unlock()}
                />
              </>
            ) : null}
            {error ? <p className="mt-3 text-[13px] font-medium text-[#E5484D]">{error}</p> : null}
            <button className="pa-btn-primary mt-4 w-full" onClick={unlock} disabled={busy || !pin}>
              <Lock size={16} /> {configuring ? '금고 만들기' : '잠금 해제'}
            </button>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-[#A8A5B8]">
              <ShieldCheck size={13} /> PIN은 서버에 저장되지 않고, 암호화 키 유도에만 쓰입니다
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- unlocked ---------------- */
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="pa-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5 lg:px-10 lg:pt-9">
        <div className="mx-auto w-full max-w-[1060px]">
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <h1 className="text-[30px] font-bold tracking-[-0.03em] lg:text-[40px]">금고</h1>
                <span className="rounded-xl bg-[#F3EEFF] px-2.5 py-1 text-[13px] font-semibold text-[#8B72F6]">
                  {status.count}개 항목
                </span>
              </div>
              <p className="mt-1 text-[13.5px] text-pomong-sub lg:text-[16px]">API 키 · 로그인 · 메모를 한 곳에</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button className="hidden rounded-2xl border border-[#EFEDF6] p-3 text-[#6B677A] lg:block" aria-label="알림">
                <Bell size={19} />
              </button>
              <button
                className="rounded-2xl border border-[#EFEDF6] p-3 text-[#6B677A]"
                onClick={lock}
                aria-label="잠금"
                title="금고 잠그기"
              >
                <Lock size={18} />
              </button>
              <button className="rounded-2xl border border-[#EFEDF6] p-3 text-[#6B677A] lg:hidden" aria-label="더보기">
                <MoreVertical size={18} />
              </button>
            </div>
          </header>

          <div className="mt-5 flex items-center gap-2.5">
            <div className="relative flex-1">
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#B7B4C6]" />
              <input
                className="pa-input pl-11"
                placeholder="항목 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button
              className="hidden items-center gap-1.5 rounded-2xl bg-[#FFF0F4] px-5 py-3 text-[15px] font-semibold text-[#F2568B] transition hover:bg-[#FFE6EE] sm:flex"
              onClick={() => setShowAdd(true)}
            >
              <Plus size={18} /> 새 항목 추가
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
            {(
              [
                ['all', '전체'],
                ['apikey', 'API 키'],
                ['login', '로그인'],
                ['memo', '메모'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`pa-chip shrink-0 ${filter === value ? 'pa-chip-active' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-[#EBFBF3] px-4 py-3 text-[13px] font-medium text-[#12B886] lg:hidden">
            <ShieldCheck size={16} /> AES-256 암호화 · 자동 잠금 {status.autoLockMinutes}분
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 lg:mt-5 lg:grid-cols-2 lg:gap-4">
            {visible.map((item) => {
              const meta = TYPE_META[item.type];
              const shown = revealed[item.id];
              const shownLines = shown ? shown.split('\n') : null;
              const topLine = item.usernameMasked
                ? shownLines && shownLines.length > 1
                  ? shownLines[0]
                  : item.usernameMasked
                : null;
              const secretLine = shownLines ? (shownLines.length > 1 ? shownLines[1] : shownLines[0]) : item.masked;
              return (
                <div key={item.id} className="relative rounded-[24px] bg-white p-4 shadow-card ring-1 ring-[#F6F4FB] lg:p-5">
                  <div className="flex items-start gap-3">
                    <span
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
                      style={{ background: meta.bg, color: meta.fg }}
                    >
                      <meta.icon size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-[16px] font-bold text-[#1F1D2B]">{item.title}</h3>
                        <span className="shrink-0 rounded-lg px-2 py-0.5 text-[11.5px] font-semibold" style={{ background: meta.bg, color: meta.fg }}>
                          {meta.label}
                        </span>
                      </div>

                      {item.type === 'memo' ? (
                        <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-[#5B5866]">
                          {shown ?? item.masked}
                        </p>
                      ) : (
                        <div className="mt-2 flex items-center gap-1.5">
                          <div className="min-w-0 flex-1 space-y-1">
                            {topLine ? (
                              <div className="truncate rounded-xl bg-[#F7F6FB] px-3 py-1.5 font-mono text-[12.5px] text-[#6B677A] ring-1 ring-[#F2F0F8]">
                                {topLine}
                              </div>
                            ) : null}
                            <div className="min-w-0 truncate rounded-xl bg-[#FAF9FD] px-3 py-2 font-mono text-[13px] text-[#3B3947] ring-1 ring-[#F2F0F8]">
                              {secretLine}
                            </div>
                          </div>
                          <button
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#8A8A9A] ring-1 ring-[#F0EEF6] transition hover:bg-[#FAF9FF]"
                            onClick={() => copy(item)}
                            aria-label="복사"
                          >
                            <Copy size={15} />
                          </button>
                          <button
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#8A8A9A] ring-1 ring-[#F0EEF6] transition hover:bg-[#FAF9FF]"
                            onClick={() => reveal(item)}
                            aria-label="보기"
                          >
                            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                      )}

                      <div className="mt-2 flex items-center justify-between">
                        <p className="text-[12px] text-[#A8A5B8]">
                          {item.type === 'memo'
                            ? `수정 ${formatDate(item.updatedAt)}`
                            : item.hint
                              ? item.hint
                              : `등록 ${formatDate(item.updatedAt)}${item.lastUsedAt ? ` · 마지막 사용 ${formatRelative(item.lastUsedAt)}` : ''}`}
                        </p>
                        <button className="text-[#D9D5E4] transition hover:text-[#E5484D]" onClick={() => remove(item)} aria-label="삭제">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {visible.length === 0 ? (
              <div className="col-span-full rounded-[24px] border border-dashed border-[#E7E3F3] bg-white/60 px-6 py-12 text-center">
                <Mascot name="poding" hero size={72} className="mx-auto opacity-90" />
                <p className="mt-3 text-[14px] text-pomong-sub">
                  {items.length === 0 ? '아직 저장된 항목이 없어요. 첫 항목을 추가해 보세요.' : '검색 결과가 없습니다.'}
                </p>
                <button className="pa-btn-ghost mt-4" onClick={() => setShowAdd(true)}>
                  <Plus size={16} /> 항목 추가
                </button>
              </div>
            ) : null}
          </div>

          {/* security panel */}
          <div className="mt-4 overflow-hidden rounded-[24px] bg-white shadow-card ring-1 ring-[#F6F4FB]">
            <div className="border-b border-[#F6F4FB] px-5 py-3.5">
              <h2 className="text-[15px] font-bold text-[#7C63F6]">보안 상태</h2>
            </div>
            <div className="grid grid-cols-2 divide-[#F6F4FB] sm:grid-cols-4 sm:divide-x">
              {[
                ['AES-256 암호화', ShieldCheck],
                ['마스터 키 로컬 보관', KeyRound],
                [`자동 잠금 ${status.autoLockMinutes}분`, Lock],
                ['PIN 미저장', Check],
              ].map(([label, Icon]) => {
                const I = Icon as typeof ShieldCheck;
                return (
                  <div key={label as string} className="flex items-center gap-2 px-5 py-4 text-[13px] text-[#5B5866]">
                    <I size={16} className="text-[#B9A8FF]" />
                    {label as string}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* floating add (mobile) */}
      <button
        className="absolute bottom-4 right-5 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-float sm:hidden"
        style={{ background: 'linear-gradient(135deg,#FFA6C1,#F2568B)' }}
        onClick={() => setShowAdd(true)}
        aria-label="새 항목 추가"
      >
        <Plus size={26} />
      </button>

      {toast ? (
        <div className="pointer-events-none fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#2A2A35] px-5 py-2.5 text-[13px] font-medium text-white shadow-lg">
          {toast}
        </div>
      ) : null}

      {showAdd ? (
        <AddItemModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            loadItems();
            loadStatus();
            flash('항목을 저장했습니다');
          }}
        />
      ) : null}
    </div>
  );
}

function AddItemModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'apikey' | 'login' | 'memo'>('apikey');
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/api/vault/items', { title, type, secret, notes, username: type === 'login' ? username : undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[#1F1D2B]/30 p-0 backdrop-blur-sm sm:items-center sm:p-6">
      <div className="w-full max-w-[480px] animate-pop rounded-t-[28px] bg-white p-5 shadow-2xl sm:rounded-[28px] sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-[19px] font-bold">새 항목 추가</h2>
          <button className="rounded-xl p-2 text-[#A8A5B8] hover:bg-[#FAF9FF]" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3.5">
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(TYPE_META) as (keyof typeof TYPE_META)[]).map((key) => {
              const meta = TYPE_META[key];
              const active = type === key;
              return (
                <button
                  key={key}
                  onClick={() => setType(key)}
                  className="flex flex-col items-center gap-1.5 rounded-2xl border-[1.5px] py-3 text-[13px] font-semibold transition"
                  style={{
                    borderColor: active ? meta.fg : '#EFEDF6',
                    background: active ? meta.bg : '#fff',
                    color: active ? meta.fg : '#8A8A9A',
                  }}
                >
                  <meta.icon size={17} />
                  {meta.label}
                </button>
              );
            })}
          </div>

          <input className="pa-input" placeholder="제목 (예: OpenAI API 키)" value={title} onChange={(e) => setTitle(e.target.value)} />
          {type === 'login' ? (
            <input className="pa-input" placeholder="아이디 / 이메일" value={username} onChange={(e) => setUsername(e.target.value)} />
          ) : null}
          <textarea
            className="pa-input min-h-[90px] resize-y font-mono text-[13px]"
            placeholder={type === 'memo' ? '메모 내용' : type === 'login' ? '비밀번호' : 'API 키 값'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <input className="pa-input" placeholder="메모 (선택)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {error ? <p className="text-[13px] font-medium text-[#E5484D]">{error}</p> : null}
        </div>

        <div className="mt-5 flex gap-2">
          <button className="pa-btn-ghost flex-1" onClick={onClose}>
            취소
          </button>
          <button className="pa-btn-primary flex-1" onClick={save} disabled={busy || !title.trim() || !secret.trim()}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
