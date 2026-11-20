import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import Mascot from '../components/Mascot';
import {
  api,
  type CustomSkill,
  type SkillTemplate,
  type ToolGroupEntry,
  type ToolGroupId,
  type ToolPrefs,
} from '../lib/api';

/**
 * v0.6.6 — 도구(스킬) 관리자
 *
 * ① 기본 도구 ON/OFF : 내장 도구를 그룹·개별 스위치로 끈다. 끈 도구는 AI에게 전달되지 않는다.
 * ② 나만의 지침 도구 : 이름 · 발동 키워드 · 지침 내용을 만들어 저장한다(DB).
 * ③ 예시 템플릿     : 개인정보 없는 범용 템플릿을 한 번에 추가한다.
 *
 * 색은 --pa-* 변수만 써서 라이트/다크 모두에서 읽힌다.
 */

const EMPTY_PREFS: ToolPrefs = { disabledGroups: [], disabledTools: [] };

/** 스위치 — iOS 스타일 토글 */
function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40"
      style={{ background: checked ? 'var(--accent)' : 'var(--pa-line)' }}
    >
      <span
        className="absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.22)] transition-all duration-200"
        style={{ left: checked ? 23 : 3 }}
      />
    </button>
  );
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-[22px] border p-4 lg:p-5 ${className}`}
      style={{ background: 'var(--pa-surface)', borderColor: 'var(--pa-line)', boxShadow: '0 4px 16px rgba(90,80,160,0.05)' }}
    >
      {children}
    </section>
  );
}

function SectionTitle({ step, title, desc }: { step: string; title: string; desc: string }) {
  return (
    <div className="mt-7 mb-2.5 flex items-start gap-2.5 px-1">
      <span
        className="mt-0.5 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[11px] font-bold"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
      >
        {step}
      </span>
      <div>
        <h2 className="text-[16px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
          {title}
        </h2>
        <p className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
          {desc}
        </p>
      </div>
    </div>
  );
}

export default function Tools() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<ToolGroupEntry[]>([]);
  const [prefs, setPrefs] = useState<ToolPrefs>(EMPTY_PREFS);
  const [skills, setSkills] = useState<CustomSkill[]>([]);
  const [templates, setTemplates] = useState<SkillTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openGroups, setOpenGroups] = useState<ToolGroupId[]>([]);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [form, setForm] = useState<null | {
    id?: string;
    name: string;
    keywords: string;
    instructions: string;
    alwaysApply: boolean;
  }>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [toolRes, skillRes] = await Promise.all([
        api.get<{ groups: ToolGroupEntry[]; prefs: ToolPrefs }>('/api/tools'),
        api.get<{ skills: CustomSkill[]; templates: SkillTemplate[] }>('/api/skills'),
      ]);
      setGroups(toolRes.groups || []);
      setPrefs({
        disabledGroups: toolRes.prefs?.disabledGroups || [],
        disabledTools: toolRes.prefs?.disabledTools || [],
      });
      setSkills(skillRes.skills || []);
      setTemplates(skillRes.templates || []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '도구 설정을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(''), 2200);
  };

  /** 도구 ON/OFF — 화면은 먼저 바꾸고 서버에 저장, 실패하면 되돌린다. */
  const savePrefs = async (next: ToolPrefs) => {
    const before = prefs;
    setPrefs(next);
    setSavingPrefs(true);
    try {
      const res = await api.post<{ prefs: ToolPrefs }>('/api/tools/prefs', next);
      setPrefs(res.prefs || next);
    } catch (err) {
      setPrefs(before);
      setError(err instanceof Error ? err.message : '도구 설정을 저장하지 못했습니다.');
    } finally {
      setSavingPrefs(false);
    }
  };

  const toggleGroup = (id: ToolGroupId, on: boolean) => {
    const disabledGroups = on
      ? prefs.disabledGroups.filter((g) => g !== id)
      : [...new Set([...prefs.disabledGroups, id])];
    void savePrefs({ ...prefs, disabledGroups });
  };

  const toggleTool = (name: string, on: boolean) => {
    const disabledTools = on
      ? prefs.disabledTools.filter((t) => t !== name)
      : [...new Set([...prefs.disabledTools, name])];
    void savePrefs({ ...prefs, disabledTools });
  };

  const groupOff = (id: ToolGroupId) => prefs.disabledGroups.includes(id);
  const enabledToolCount = useMemo(() => {
    let total = 0;
    for (const group of groups) {
      if (groupOff(group.id)) continue;
      total += group.tools.filter((t) => !prefs.disabledTools.includes(t.name)).length;
    }
    return total;
  }, [groups, prefs]);
  const allToolCount = useMemo(() => groups.reduce((sum, g) => sum + g.tools.length, 0), [groups]);

  const patchSkill = async (id: string, patch: Partial<CustomSkill>) => {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    try {
      await api.put(`/api/skills/${id}`, patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : '지침 도구를 저장하지 못했습니다.');
      await load();
    }
  };

  const submitForm = async () => {
    if (!form || busy) return;
    if (!form.name.trim() || !form.instructions.trim()) {
      setError('이름과 지침 내용을 모두 적어 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        name: form.name.trim(),
        keywords: form.keywords.trim(),
        instructions: form.instructions.trim(),
        alwaysApply: form.alwaysApply,
      };
      if (form.id) await api.put(`/api/skills/${form.id}`, body);
      else await api.post('/api/skills', body);
      setForm(null);
      await load();
      flash(form.id ? '지침 도구를 고쳤어요.' : '새 지침 도구를 만들었어요.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '지침 도구를 저장하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const removeSkill = async (skill: CustomSkill) => {
    if (!window.confirm(`'${skill.name}' 지침 도구를 지울까요?`)) return;
    try {
      await api.del(`/api/skills/${skill.id}`);
      setSkills((prev) => prev.filter((s) => s.id !== skill.id));
      flash('지침 도구를 지웠어요.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '지침 도구를 지우지 못했습니다.');
    }
  };

  const addTemplate = async (template: SkillTemplate) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ existing: boolean }>(`/api/skills/templates/${template.id}`);
      await load();
      flash(res.existing ? `'${template.name}'은(는) 이미 있어요.` : `'${template.name}'을(를) 추가했어요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '템플릿을 추가하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    background: 'var(--pa-surface-3)',
    color: 'var(--pa-ink)',
    borderColor: 'var(--pa-line)',
  } as const;

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-10 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[720px]">
        <header className="flex items-center gap-2">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-2xl transition hover:bg-[#F7F5FF] dark:hover:bg-[#232030]"
            style={{ color: 'var(--pa-mute)' }}
            onClick={() => navigate('/more')}
            aria-label="뒤로"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0">
            <h1 className="text-[24px] font-bold tracking-[-0.02em] lg:text-[30px]">도구(스킬) 관리</h1>
            <p className="text-[13px] lg:text-[15px]" style={{ color: 'var(--pa-mute)' }}>
              AI가 쓸 기능을 켜고 끄고, 나만의 지침을 만들어요
            </p>
          </div>
          <Mascot name="minti" size={46} className="ml-auto shrink-0" />
        </header>

        <div
          className="mt-4 flex items-start gap-2.5 rounded-2xl px-4 py-3 text-[12.5px] leading-relaxed"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
        >
          <Sparkles size={16} className="mt-0.5 shrink-0" />
          <span>
            끈 도구는 AI에게 아예 전달되지 않아요. 지침 도구는 이번 요청의 키워드와 맞을 때만 내용이 실려 토큰을 아껴요.
          </span>
        </div>

        {error ? (
          <p className="mt-4 rounded-2xl bg-[#FFF1F1] px-4 py-3 text-[13px] font-medium text-[#E5484D]">{error}</p>
        ) : null}
        {notice ? (
          <p
            className="mt-4 flex items-center gap-2 rounded-2xl px-4 py-2.5 text-[13px] font-semibold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
          >
            <Check size={15} /> {notice}
          </p>
        ) : null}

        {loading ? (
          <p className="mt-6 text-center text-[13px]" style={{ color: 'var(--pa-mute)' }}>
            불러오는 중…
          </p>
        ) : null}

        {/* ① 기본 도구 ON/OFF */}
        <SectionTitle
          step="1"
          title="기본 도구"
          desc={`지금 ${enabledToolCount}/${allToolCount}개를 쓸 수 있어요. 그룹을 누르면 도구별로 하나씩 끌 수 있어요.`}
        />
        <div className="space-y-2.5">
          {groups.map((group) => {
            const off = groupOff(group.id);
            const open = openGroups.includes(group.id);
            const onCount = off ? 0 : group.tools.filter((t) => !prefs.disabledTools.includes(t.name)).length;
            return (
              <Card key={group.id} className="!p-0 overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() =>
                      setOpenGroups((prev) => (prev.includes(group.id) ? prev.filter((g) => g !== group.id) : [...prev, group.id]))
                    }
                    aria-expanded={open}
                  >
                    <span className="text-[20px]" aria-hidden>
                      {group.emoji}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[15px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                          {group.label}
                        </span>
                        <span className="text-[11px] font-semibold" style={{ color: 'var(--pa-mute-2)' }}>
                          {onCount}/{group.tools.length}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[12px]" style={{ color: 'var(--pa-mute)' }}>
                        {group.desc}
                      </span>
                    </span>
                    <ChevronDown
                      size={17}
                      className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                      style={{ color: 'var(--pa-mute-2)' }}
                    />
                  </button>
                  <Switch
                    checked={!off}
                    onChange={(next) => toggleGroup(group.id, next)}
                    disabled={savingPrefs}
                    label={`${group.label} 그룹 ${off ? '켜기' : '끄기'}`}
                  />
                </div>
                {open ? (
                  <ul className="px-4 pb-3" style={{ borderTop: '1px solid var(--pa-line-soft)' }}>
                    {group.tools.map((tool) => {
                      const toolOff = off || prefs.disabledTools.includes(tool.name);
                      return (
                        <li key={tool.name} className="flex items-center gap-3 py-2.5" style={{ borderTop: '1px solid var(--pa-line-soft)' }}>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                              {tool.label}
                            </span>
                            <span className="mt-0.5 block font-mono text-[10.5px]" style={{ color: 'var(--pa-mute-2)' }}>
                              {tool.name}
                            </span>
                          </span>
                          <Switch
                            checked={!toolOff}
                            onChange={(next) => toggleTool(tool.name, next)}
                            disabled={off || savingPrefs}
                            label={`${tool.label} ${toolOff ? '켜기' : '끄기'}`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </Card>
            );
          })}
        </div>

        {/* ② 나만의 지침 도구 */}
        <SectionTitle step="2" title="나만의 지침 도구" desc="키워드가 맞거나 '항상 적용'일 때만 AI가 이 지침을 따라요." />

        <button
          type="button"
          onClick={() => setForm({ name: '', keywords: '', instructions: '', alwaysApply: false })}
          className="flex w-full items-center justify-center gap-2 rounded-[20px] px-4 py-3.5 text-[14.5px] font-bold text-white shadow-[0_8px_20px_rgba(120,100,220,0.25)]"
          style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
        >
          <Plus size={18} /> 새 도구 만들기
        </button>

        {form ? (
          <Card className="mt-2.5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                {form.id ? '지침 도구 수정' : '새 지침 도구'}
              </h3>
              <button
                type="button"
                onClick={() => setForm(null)}
                className="flex h-7 w-7 items-center justify-center rounded-full"
                style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }}
                aria-label="닫기"
              >
                <X size={15} />
              </button>
            </div>

            <label className="block">
              <span className="mb-1 block text-[12px] font-bold" style={{ color: 'var(--pa-mute)' }}>
                이름
              </span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={40}
                placeholder="예: 3줄 핵심 보고"
                className="w-full rounded-xl border px-3 py-2.5 text-[14px] outline-none focus:ring-2"
                style={inputStyle}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] font-bold" style={{ color: 'var(--pa-mute)' }}>
                발동 조건 (키워드 · 쉼표로 구분)
              </span>
              <input
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                maxLength={200}
                placeholder="예: 요약, 정리, 보고"
                disabled={form.alwaysApply}
                className="w-full rounded-xl border px-3 py-2.5 text-[14px] outline-none focus:ring-2 disabled:opacity-50"
                style={inputStyle}
              />
            </label>

            <div className="flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: 'var(--pa-surface-3)' }}>
              <div>
                <span className="block text-[13.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                  항상 적용
                </span>
                <span className="block text-[11.5px]" style={{ color: 'var(--pa-mute)' }}>
                  키워드와 상관없이 모든 대화에 넣어요
                </span>
              </div>
              <Switch
                checked={form.alwaysApply}
                onChange={(next) => setForm({ ...form, alwaysApply: next })}
                label="항상 적용"
              />
            </div>

            <label className="block">
              <span className="mb-1 block text-[12px] font-bold" style={{ color: 'var(--pa-mute)' }}>
                지침 내용
              </span>
              <textarea
                value={form.instructions}
                onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                maxLength={4000}
                rows={6}
                placeholder={'- 결론 한 줄 → 근거 → 다음 할 일 순서로 정리합니다.'}
                className="w-full resize-y rounded-xl border px-3 py-2.5 text-[14px] leading-relaxed outline-none focus:ring-2"
                style={inputStyle}
              />
            </label>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={submitForm}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-[14px] font-bold disabled:opacity-50"
                style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
              >
                <Check size={16} /> 저장
              </button>
              <button
                type="button"
                onClick={() => setForm(null)}
                className="rounded-xl px-4 py-2.5 text-[14px] font-semibold"
                style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }}
              >
                취소
              </button>
            </div>
          </Card>
        ) : null}

        <div className="mt-2.5 space-y-2.5">
          {skills.length === 0 && !form ? (
            <p className="rounded-[20px] px-4 py-5 text-center text-[13px]" style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }}>
              아직 만든 지침 도구가 없어요. 아래 예시에서 골라 시작해도 좋아요.
            </p>
          ) : null}
          {skills.map((skill) => (
            <Card key={skill.id} className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                    {skill.name}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {skill.alwaysApply ? (
                      <span
                        className="rounded-md px-1.5 py-0.5 text-[10.5px] font-bold"
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
                      >
                        항상 적용
                      </span>
                    ) : null}
                    {skill.keywords.map((keyword) => (
                      <span
                        key={keyword}
                        className="rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold"
                        style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }}
                      >
                        #{keyword}
                      </span>
                    ))}
                    {!skill.alwaysApply && skill.keywords.length === 0 ? (
                      <span className="text-[10.5px] font-semibold" style={{ color: 'var(--pa-mute-2)' }}>
                        키워드 없음 · 발동하지 않아요
                      </span>
                    ) : null}
                  </span>
                </span>
                <Switch
                  checked={skill.enabled}
                  onChange={(next) => void patchSkill(skill.id, { enabled: next })}
                  label={`${skill.name} ${skill.enabled ? '끄기' : '켜기'}`}
                />
              </div>
              <p className="line-clamp-3 whitespace-pre-line text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                {skill.instructions}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setForm({
                      id: skill.id,
                      name: skill.name,
                      keywords: skill.keywords.join(', '),
                      instructions: skill.instructions,
                      alwaysApply: skill.alwaysApply,
                    })
                  }
                  className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12.5px] font-semibold"
                  style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-ink)' }}
                >
                  <Pencil size={13} /> 수정
                </button>
                <button
                  type="button"
                  onClick={() => void removeSkill(skill)}
                  className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12.5px] font-semibold text-[#E5484D]"
                  style={{ background: 'var(--pa-surface-3)' }}
                >
                  <Trash2 size={13} /> 삭제
                </button>
              </div>
            </Card>
          ))}
        </div>

        {/* ③ 예시 템플릿 */}
        <SectionTitle step="3" title="예시 템플릿" desc="그대로 써도 되고, 추가한 뒤 내 방식대로 고쳐도 돼요." />
        <div className="space-y-2.5">
          {templates.map((template) => {
            const added = skills.some((s) => s.name === template.name);
            return (
              <Card key={template.id} className="flex items-center gap-3">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
                >
                  <Wand2 size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                    {template.name}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                    {template.summary}
                  </span>
                  <span className="mt-1 block text-[10.5px] font-semibold" style={{ color: 'var(--pa-mute-2)' }}>
                    키워드 {template.keywords.join(' · ')}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void addTemplate(template)}
                  disabled={added || busy}
                  className="shrink-0 rounded-xl px-3 py-2 text-[12.5px] font-bold disabled:opacity-50"
                  style={
                    added
                      ? { background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }
                      : { background: 'var(--accent-soft)', color: 'var(--accent-deep)' }
                  }
                >
                  {added ? '추가됨' : '+ 추가'}
                </button>
              </Card>
            );
          })}
        </div>

        <p className="mt-7 text-center text-[11.5px]" style={{ color: 'var(--pa-mute-2)' }}>
          도구 목록은 서버의 실제 도구 정의에서 그대로 가져옵니다
        </p>
      </div>
    </div>
  );
}
