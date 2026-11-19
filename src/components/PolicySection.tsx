import { useEffect, useState } from 'react';
import { Globe, Plus, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2 } from 'lucide-react';
import { api, type PolicyEntry } from '../lib/api';

const LEVEL_META: Record<PolicyEntry['level'], { label: string; desc: string; color: string; bg: string; icon: typeof ShieldCheck }> = {
  allow: { label: '허용', desc: '자유롭게 조작', color: '#0F9668', bg: '#EAFBF1', icon: ShieldCheck },
  confirm: { label: '확인 필요', desc: '쇼핑·예약·커뮤니티', color: '#C08A16', bg: '#FFF8E7', icon: ShieldQuestion },
  handover: { label: '사람이 로그인', desc: '금융·정부·본인인증', color: '#2F86D8', bg: '#EAF6FF', icon: ShieldAlert },
  block: { label: '차단', desc: '접근 자체를 거부', color: '#E5484D', bg: '#FFF1F1', icon: ShieldAlert },
};

export default function PolicySection() {
  const [policies, setPolicies] = useState<PolicyEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState('');
  const [level, setLevel] = useState<PolicyEntry['level']>('confirm');
  const [error, setError] = useState('');

  const load = () =>
    api
      .get<{ policies: PolicyEntry[] }>('/api/policies')
      .then((r) => setPolicies(r.policies))
      .catch(() => undefined);

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    setError('');
    try {
      const res = await api.post<{ policies: PolicyEntry[] }>('/api/policies', { pattern, level });
      setPolicies(res.policies);
      setPattern('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '추가하지 못했어요.');
    }
  };

  const changeLevel = async (entry: PolicyEntry, next: PolicyEntry['level']) => {
    const res = await api.post<{ policies: PolicyEntry[] }>('/api/policies', { pattern: entry.pattern, level: next, note: entry.note }).catch(() => null);
    if (res) setPolicies(res.policies);
  };

  const remove = async (entry: PolicyEntry) => {
    const res = await api.del<{ policies: PolicyEntry[] }>(`/api/policies/${encodeURIComponent(entry.pattern)}`).catch(() => null);
    if (res) setPolicies(res.policies);
  };

  const counts = (['allow', 'confirm', 'handover', 'block'] as const).map((value) => ({
    value,
    count: policies.filter((p) => p.level === value).length,
  }));

  return (
    <section className="mt-4 rounded-[24px] bg-white p-5 shadow-card ring-1 ring-[#F6F4FB] lg:p-6">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-xl bg-[#F1ECFF] text-[#7C63F6]">
          <Globe size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold text-[#1F1D2B]">브라우저 안전 정책</h2>
          <p className="mt-0.5 text-[12px] text-pomong-sub">
            AI가 어느 사이트를 어떻게 만질지 정해요. 결제·비밀번호 입력은 정책과 상관없이 항상 막혀요.
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {counts.map(({ value, count }) => {
          const meta = LEVEL_META[value];
          // 다크 테마에서도 어울리게, 파스텔 대신 같은 색의 옅은 알파 틴트를 쓴다
          return (
            <div key={value} className="rounded-[14px] px-3 py-2" style={{ background: `${meta.color}1F` }}>
              <p className="text-[11px] font-bold" style={{ color: meta.color }}>
                {meta.label} {count}
              </p>
              <p className="text-[10.5px] text-[#8A8A9A]">{meta.desc}</p>
            </div>
          );
        })}
      </div>

      <button className="mt-3 flex items-center gap-1.5 text-[12.5px] font-semibold text-[#7C63F6]" onClick={() => setOpen((v) => !v)}>
        <Plus size={13} /> 도메인 정책 {open ? '접기' : '관리'}
      </button>

      {open ? (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              className="min-w-0 flex-1 rounded-xl bg-[#FAF9FD] px-3 py-2 text-[12.5px] focus:outline-none"
              placeholder="도메인 (예: coupang.com)"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
            <select
              className="rounded-xl border border-[#E9E7F2] bg-white px-2 py-2 text-[12px]"
              value={level}
              onChange={(e) => setLevel(e.target.value as PolicyEntry['level'])}
            >
              {(Object.keys(LEVEL_META) as PolicyEntry['level'][]).map((value) => (
                <option key={value} value={value}>
                  {LEVEL_META[value].label}
                </option>
              ))}
            </select>
            <button className="rounded-xl bg-[#F1ECFF] px-3 py-2 text-[12px] font-bold text-[#7C63F6] disabled:opacity-50" onClick={add} disabled={!pattern.trim()}>
              추가
            </button>
          </div>
          {error ? <p className="mt-1 text-[11.5px] text-[#E5484D]">{error}</p> : null}

          <ul className="mt-2 max-h-[260px] space-y-1 overflow-y-auto pa-scroll">
            {policies.map((entry) => {
              const meta = LEVEL_META[entry.level];
              return (
                <li key={entry.pattern} className="flex items-center gap-2 rounded-[12px] bg-[#FAF9FD] px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#3B3947]">{entry.pattern}</span>
                  <select
                    className="rounded-lg bg-white px-1.5 py-1 text-[11px] font-semibold"
                    style={{ color: meta.color }}
                    value={entry.level}
                    onChange={(e) => changeLevel(entry, e.target.value as PolicyEntry['level'])}
                  >
                    {(Object.keys(LEVEL_META) as PolicyEntry['level'][]).map((value) => (
                      <option key={value} value={value}>
                        {LEVEL_META[value].label}
                      </option>
                    ))}
                  </select>
                  <button className="rounded-lg p-1 text-[#DDD9E8] hover:text-[#E5484D]" onClick={() => remove(entry)} aria-label="삭제">
                    <Trash2 size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
