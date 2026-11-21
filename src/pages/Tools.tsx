import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
  Wrench,
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
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowTemplate,
  type WorkflowTool,
} from '../lib/api';

/**
 * v0.6.6 — 도구(스킬) 관리자
 *
 * ① 기본 도구 ON/OFF : 내장 도구를 그룹·개별 스위치로 끈다. 끈 도구는 AI에게 전달되지 않는다.
 * ② 나만의 지침 도구 : 이름 · 발동 키워드 · 지침 내용을 만들어 저장한다(DB).
 *                     v0.7.1 — [글로 쓰기] / [단계별 조립] 두 가지 모드
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

/* ------------------------------------------------------------------ */
/* 단계 편집 도우미                                                     */
/* ------------------------------------------------------------------ */

type EditorForm = {
  id?: string;
  name: string;
  keywords: string;
  instructions: string;
  alwaysApply: boolean;
  mode: 'prompt' | 'workflow';
  steps: WorkflowStep[];
};

const KIND_META: Record<WorkflowStepKind, { label: string; emoji: string; hint: string }> = {
  tool: { label: '도구', emoji: '🧩', hint: '내장 도구를 서버가 바로 실행해요 (토큰 소모 없음)' },
  ai: { label: 'AI', emoji: '🤖', hint: '이전 단계 결과를 현재 AI 모델이 요약·가공해요' },
  action: { label: '알림 · 할 일', emoji: '🔔', hint: '웹 푸시 알림을 보내거나 할 일로 등록해요' },
};

let stepSeq = 0;
function newStep(kind: WorkflowStepKind, label?: string): WorkflowStep {
  stepSeq += 1;
  const id = `step-${Date.now().toString(36)}-${stepSeq}`;
  if (kind === 'tool') return { id, kind, label: label || '도구 실행', tool: '', args: {} };
  if (kind === 'ai') return { id, kind, label: label || 'AI 가공', prompt: '' };
  return { id, kind, label: label || '알림 보내기', action: 'notify', text: '' };
}

function stepsBadge(steps: WorkflowStep[]): string {
  return `워크플로우 · ${steps.length}단계`;
}

export default function Tools() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<ToolGroupEntry[]>([]);
  const [prefs, setPrefs] = useState<ToolPrefs>(EMPTY_PREFS);
  const [skills, setSkills] = useState<CustomSkill[]>([]);
  const [templates, setTemplates] = useState<SkillTemplate[]>([]);
  const [workflowTemplates, setWorkflowTemplates] = useState<WorkflowTemplate[]>([]);
  const [workflowTools, setWorkflowTools] = useState<WorkflowTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openGroups, setOpenGroups] = useState<ToolGroupId[]>([]);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [form, setForm] = useState<EditorForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [sampleInput, setSampleInput] = useState('');
  const [testRun, setTestRun] = useState<WorkflowRun | null>(null);
  const [testing, setTesting] = useState(false);
  /** 목록 카드의 즉시 실행 입력창 */
  const [runPanel, setRunPanel] = useState<{ id: string; input: string; run: WorkflowRun | null; busy: boolean } | null>(null);
  /** 변수 칩을 넣을 마지막 입력칸 */
  const insertTarget = useRef<{ insert: (chip: string) => void } | null>(null);

  const load = async () => {
    try {
      const [toolRes, skillRes] = await Promise.all([
        api.get<{ groups: ToolGroupEntry[]; prefs: ToolPrefs; workflowTools?: WorkflowTool[] }>('/api/tools'),
        api.get<{ skills: CustomSkill[]; templates: SkillTemplate[]; workflowTemplates?: WorkflowTemplate[] }>('/api/skills'),
      ]);
      setGroups(toolRes.groups || []);
      setPrefs({
        disabledGroups: toolRes.prefs?.disabledGroups || [],
        disabledTools: toolRes.prefs?.disabledTools || [],
      });
      setWorkflowTools(toolRes.workflowTools || []);
      setSkills(skillRes.skills || []);
      setTemplates(skillRes.templates || []);
      setWorkflowTemplates(skillRes.workflowTemplates || []);
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
      // v0.6.19: 서버가 돌려준 실제 저장값으로 목록을 맞춘다(다음 대화 턴에 바로 반영).
      const res = await api.put<{ skill?: CustomSkill }>(`/api/skills/${id}`, patch);
      if (res.skill) setSkills((prev) => prev.map((s) => (s.id === id ? (res.skill as CustomSkill) : s)));
      if (typeof patch.enabled === 'boolean') flash(patch.enabled ? '도구를 켰어요. 다음 대화부터 바로 따라요.' : '도구를 껐어요.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '도구를 저장하지 못했습니다.');
      await load();
    }
  };

  const openNew = (mode: 'prompt' | 'workflow') => {
    setTestRun(null);
    setSampleInput('');
    setForm({
      name: '',
      keywords: '',
      instructions: '',
      alwaysApply: false,
      mode,
      steps: mode === 'workflow' ? [newStep('tool', '도구 실행')] : [],
    });
  };

  const submitForm = async () => {
    if (!form || busy) return;
    if (!form.name.trim()) {
      setError('이름을 적어 주세요.');
      return;
    }
    if (form.mode === 'prompt' && !form.instructions.trim()) {
      setError('지침 내용을 적어 주세요.');
      return;
    }
    if (form.mode === 'workflow' && !form.steps.length) {
      setError('단계를 하나 이상 추가해 주세요.');
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
        mode: form.mode,
        steps: form.mode === 'workflow' ? form.steps : [],
      };
      if (form.id) await api.put(`/api/skills/${form.id}`, body);
      else await api.post('/api/skills', body);
      setForm(null);
      setTestRun(null);
      await load();
      flash(
        form.mode === 'workflow'
          ? form.id
            ? '워크플로우를 저장했어요. 이제 대화에서 이름으로 실행할 수 있어요.'
            : '새 워크플로우를 만들었어요. 대화에서 이름을 부르면 실행돼요.'
          : form.id
            ? '도구를 고쳤어요. 다음 대화부터 바로 반영돼요.'
            : '새 도구를 만들었어요. 다음 대화부터 바로 반영돼요.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '도구를 저장하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const removeSkill = async (skill: CustomSkill) => {
    if (!window.confirm(`'${skill.name}' 도구를 지울까요?`)) return;
    try {
      await api.del(`/api/skills/${skill.id}`);
      setSkills((prev) => prev.filter((s) => s.id !== skill.id));
      flash('도구를 지웠어요.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '도구를 지우지 못했습니다.');
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

  const addWorkflowTemplate = async (template: WorkflowTemplate) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ existing: boolean }>(`/api/skills/workflow-templates/${template.id}`);
      await load();
      flash(res.existing ? `'${template.name}'은(는) 이미 있어요.` : `'${template.name}' 워크플로우를 추가했어요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '워크플로우 템플릿을 추가하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  /** 저장 전 테스트 실행 — 단계별 출력·소요시간을 그대로 보여 준다. */
  const runTest = async () => {
    if (!form || testing) return;
    setTesting(true);
    setError('');
    setTestRun(null);
    try {
      const res = await api.post<{ run: WorkflowRun }>('/api/skills/workflow/test', {
        steps: form.steps,
        input: sampleInput,
        name: form.name || '테스트 실행',
      });
      setTestRun(res.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : '테스트 실행에 실패했습니다.');
    } finally {
      setTesting(false);
    }
  };

  /** 목록 카드에서 저장된 워크플로우 즉시 실행 */
  const runSaved = async (skill: CustomSkill) => {
    if (!runPanel || runPanel.id !== skill.id) {
      setRunPanel({ id: skill.id, input: '', run: null, busy: false });
      return;
    }
    setRunPanel({ ...runPanel, busy: true });
    try {
      const res = await api.post<{ run: WorkflowRun }>(`/api/skills/${skill.id}/run`, { input: runPanel.input, session: 'default' });
      setRunPanel({ ...runPanel, run: res.run, busy: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : '워크플로우를 실행하지 못했습니다.');
      setRunPanel({ ...runPanel, busy: false });
    }
  };

  /* ---------------------------- 단계 편집 ---------------------------- */

  const updateStep = (index: number, patch: Partial<WorkflowStep>) => {
    setForm((prev) =>
      prev ? { ...prev, steps: prev.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)) } : prev
    );
  };

  const changeStepKind = (index: number, kind: WorkflowStepKind) => {
    if (!form) return;
    const current = form.steps[index];
    const next = newStep(kind);
    updateStep(index, {
      ...next,
      id: current.id,
      label: KIND_META[kind].label === '알림 · 할 일' ? '알림 보내기' : KIND_META[kind].label + ' 단계',
    });
  };

  const moveStep = (index: number, delta: number) => {
    setForm((prev) => {
      if (!prev) return prev;
      const target = index + delta;
      if (target < 0 || target >= prev.steps.length) return prev;
      const steps = [...prev.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...prev, steps };
    });
  };

  const addStep = () => {
    setForm((prev) => (prev ? { ...prev, steps: [...prev.steps, newStep('tool')] } : prev));
  };

  const removeStep = (index: number) => {
    setForm((prev) => (prev ? { ...prev, steps: prev.steps.filter((_, i) => i !== index) } : prev));
  };

  const selectWorkflowTool = (index: number, toolName: string) => {
    const tool = workflowTools.find((item) => item.name === toolName);
    const args: Record<string, string> = {};
    for (const param of tool?.params || []) {
      if (param.required) args[param.name] = args[param.name] || '{{input}}';
    }
    updateStep(index, { tool: toolName, label: tool?.label || '도구 실행', args });
  };

  const chipsFor = (index: number): string[] => {
    const chips = ['{{input}}'];
    for (let i = 1; i <= index; i += 1) chips.push(`{{step${i}}}`);
    return chips;
  };

  const insertChip = (chip: string) => {
    if (insertTarget.current) insertTarget.current.insert(chip);
  };

  const inputStyle = {
    background: 'var(--pa-surface-3)',
    color: 'var(--pa-ink)',
    borderColor: 'var(--pa-line)',
  } as const;

  const workflowSkills = skills.filter((skill) => skill.mode === 'workflow');
  const promptSkills = skills.filter((skill) => skill.mode !== 'workflow');
  const currentTool = (name?: string) => workflowTools.find((tool) => tool.name === name) || null;

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
              AI가 쓸 기능을 켜고 끄고, 나만의 지침·워크플로우를 만들어요
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
            끈 도구는 AI에게 아예 전달되지 않아요. 지침 도구는 이번 요청과 맞을 때 내용이 실려 토큰을 아끼고, 단계별 워크플로우는
            도구·AI·알림을 서버가 순서대로 실행해요.
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

        {/* ② 나만의 도구 */}
        <SectionTitle
          step="2"
          title="나만의 도구"
          desc="[글로 쓰기]는 지침 문장을, [단계별 조립]은 도구 실행·AI 가공·알림을 순서대로 조립해요."
        />

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => openNew('prompt')}
            className="flex items-center justify-center gap-2 rounded-[20px] px-4 py-3.5 text-[14px] font-bold text-white shadow-[0_8px_20px_rgba(120,100,220,0.25)]"
            style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
          >
            <Plus size={18} /> 글로 쓰기
          </button>
          <button
            type="button"
            onClick={() => openNew('workflow')}
            className="flex items-center justify-center gap-2 rounded-[20px] px-4 py-3.5 text-[14px] font-bold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
          >
            <Wrench size={17} /> 단계별 조립
          </button>
        </div>

        {form ? (
          <Card className="mt-2.5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                {form.id ? '도구 수정' : form.mode === 'workflow' ? '새 워크플로우' : '새 지침 도구'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setForm(null);
                  setTestRun(null);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full"
                style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }}
                aria-label="닫기"
              >
                <X size={15} />
              </button>
            </div>

            {/* 모드 전환 탭 */}
            <div className="flex gap-1 rounded-2xl p-1" style={{ background: 'var(--pa-surface-3)' }}>
              {(['prompt', 'workflow'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      mode,
                      steps:
                        mode === 'workflow' && !form.steps.length
                          ? [newStep('tool', '도구 실행')]
                          : form.steps,
                    })
                  }
                  className="flex-1 rounded-xl py-2 text-[12.5px] font-bold transition"
                  style={
                    form.mode === mode
                      ? { background: 'var(--pa-surface)', color: 'var(--accent-deep)', boxShadow: '0 2px 8px rgba(90,80,160,0.08)' }
                      : { color: 'var(--pa-mute)' }
                  }
                >
                  {mode === 'prompt' ? '글로 쓰기' : '단계별 조립'}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="mb-1 block text-[12px] font-bold" style={{ color: 'var(--pa-mute)' }}>
                이름
              </span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={40}
                placeholder={form.mode === 'workflow' ? '예: 아침 요약 → 알림' : '예: 3줄 핵심 보고'}
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
                placeholder="예: 요약, 정리, 보고 (비우면 항상 적용)"
                disabled={form.alwaysApply}
                className="w-full rounded-xl border px-3 py-2.5 text-[14px] outline-none focus:ring-2 disabled:opacity-50"
                style={inputStyle}
              />
              <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--pa-mute)' }}>
                {form.mode === 'workflow'
                  ? '키워드가 맞으면 대화 중에 AI가 run_workflow로 실행해요. 이름을 불러도 실행돼요.'
                  : "비워 두면 '기본 안내'로 매 요청에 적용돼요."}
              </span>
            </label>

            <div className="flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: 'var(--pa-surface-3)' }}>
              <div>
                <span className="block text-[13.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                  항상 적용
                </span>
                <span className="block text-[11.5px]" style={{ color: 'var(--pa-mute)' }}>
                  {form.mode === 'workflow' ? '키워드와 상관없이 목록에 늘 보이게 해요' : '키워드와 상관없이 모든 대화에 넣어요'}
                </span>
              </div>
              <Switch checked={form.alwaysApply} onChange={(next) => setForm({ ...form, alwaysApply: next })} label="항상 적용" />
            </div>

            {form.mode === 'prompt' ? (
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
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-bold" style={{ color: 'var(--pa-mute)' }}>
                    단계 ({form.steps.length})
                  </span>
                  <button
                    type="button"
                    onClick={runTest}
                    disabled={testing || !form.steps.length}
                    className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12.5px] font-bold disabled:opacity-50"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
                  >
                    {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    {testing ? '실행 중…' : '테스트 실행'}
                  </button>
                </div>

                <div className="flex gap-2">
                  <input
                    value={sampleInput}
                    onChange={(e) => setSampleInput(e.target.value)}
                    placeholder="테스트 입력 ({{input}}에 들어갈 내용)"
                    className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-[13px] outline-none focus:ring-2"
                    style={inputStyle}
                  />
                </div>

                <div className="space-y-0">
                  {form.steps.map((step, index) => {
                    const result = testRun?.steps.find((item) => item.index === index + 1);
                    const tool = currentTool(step.tool);
                    return (
                      <div key={step.id}>
                        {index > 0 ? (
                          <div className="flex justify-center py-1" aria-hidden>
                            <span className="h-4 w-[2px] rounded-full" style={{ background: 'var(--pa-line)' }} />
                          </div>
                        ) : null}
                        <div
                          className="rounded-[18px] border p-3"
                          style={{ background: 'var(--pa-surface-2)', borderColor: 'var(--pa-line)' }}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[10.5px] font-bold"
                              style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
                            >
                              STEP {index + 1}
                            </span>
                            <input
                              value={step.label}
                              onChange={(e) => updateStep(index, { label: e.target.value })}
                              maxLength={60}
                              className="min-w-0 flex-1 rounded-lg border-none bg-transparent px-1 py-1 text-[13.5px] font-semibold outline-none"
                              style={{ color: 'var(--pa-ink-strong)' }}
                              placeholder="단계 이름"
                            />
                            <button
                              type="button"
                              onClick={() => moveStep(index, -1)}
                              disabled={index === 0}
                              className="rounded-lg p-1 disabled:opacity-30"
                              style={{ color: 'var(--pa-mute-2)' }}
                              aria-label="위로"
                            >
                              <ArrowUp size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveStep(index, 1)}
                              disabled={index === form.steps.length - 1}
                              className="rounded-lg p-1 disabled:opacity-30"
                              style={{ color: 'var(--pa-mute-2)' }}
                              aria-label="아래로"
                            >
                              <ArrowDown size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeStep(index)}
                              className="rounded-lg p-1 text-[#E5484D]"
                              aria-label="단계 삭제"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>

                          <div className="mt-2 flex gap-1">
                            {(['tool', 'ai', 'action'] as WorkflowStepKind[]).map((kind) => (
                              <button
                                key={kind}
                                type="button"
                                onClick={() => changeStepKind(index, kind)}
                                className="flex flex-1 items-center justify-center gap-1 rounded-xl py-1.5 text-[11.5px] font-bold transition"
                                style={
                                  step.kind === kind
                                    ? { background: 'var(--accent-soft)', color: 'var(--accent-deep)' }
                                    : { background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }
                                }
                              >
                                <span aria-hidden>{KIND_META[kind].emoji}</span>
                                {KIND_META[kind].label}
                              </button>
                            ))}
                          </div>

                          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--pa-mute-2)' }}>
                            {KIND_META[step.kind].hint}
                          </p>

                          {step.kind === 'tool' ? (
                            <div className="mt-2 space-y-2">
                              <select
                                value={step.tool || ''}
                                onChange={(e) => selectWorkflowTool(index, e.target.value)}
                                className="w-full rounded-xl border px-2.5 py-2 text-[13px] outline-none"
                                style={inputStyle}
                              >
                                <option value="">도구 선택…</option>
                                {workflowTools.map((item) => (
                                  <option key={item.name} value={item.name}>
                                    {item.label} · {item.name}
                                  </option>
                                ))}
                              </select>
                              {(tool?.params || []).map((param) => {
                                const value = step.args?.[param.name] || '';
                                return (
                                  <label key={param.name} className="block">
                                    <span className="mb-0.5 block text-[11px] font-semibold" style={{ color: 'var(--pa-mute)' }}>
                                      {param.name}
                                      {param.required ? ' *' : ''}
                                      {param.description ? ` — ${param.description.slice(0, 40)}` : ''}
                                    </span>
                                    {param.options?.length ? (
                                      <select
                                        value={value}
                                        onChange={(e) =>
                                          updateStep(index, { args: { ...(step.args || {}), [param.name]: e.target.value } })
                                        }
                                        className="w-full rounded-xl border px-2.5 py-2 text-[13px] outline-none"
                                        style={inputStyle}
                                      >
                                        <option value="">(기본)</option>
                                        {param.options.map((option) => (
                                          <option key={option} value={option}>
                                            {option}
                                          </option>
                                        ))}
                                      </select>
                                    ) : (
                                      <input
                                        value={value}
                                        onChange={(e) =>
                                          updateStep(index, { args: { ...(step.args || {}), [param.name]: e.target.value } })
                                        }
                                        onFocus={() =>
                                          (insertTarget.current = {
                                            insert: (chip) =>
                                              updateStep(index, {
                                                args: { ...(step.args || {}), [param.name]: `${value}${chip}` },
                                              }),
                                          })
                                        }
                                        placeholder="값 또는 {{input}}"
                                        className="w-full rounded-xl border px-2.5 py-2 text-[13px] outline-none focus:ring-2"
                                        style={inputStyle}
                                      />
                                    )}
                                  </label>
                                );
                              })}
                              {tool && !tool.params.length ? (
                                <p className="text-[11px]" style={{ color: 'var(--pa-mute-2)' }}>
                                  인자가 없는 도구예요. 그대로 실행합니다.
                                </p>
                              ) : null}
                            </div>
                          ) : null}

                          {step.kind === 'ai' ? (
                            <label className="mt-2 block">
                              <span className="mb-0.5 block text-[11px] font-semibold" style={{ color: 'var(--pa-mute)' }}>
                                AI에게 시킬 일 (이전 단계는 {'{{step1}}'} 처럼 넣어요)
                              </span>
                              <textarea
                                value={step.prompt || ''}
                                onChange={(e) => updateStep(index, { prompt: e.target.value })}
                                onFocus={() =>
                                  (insertTarget.current = {
                                    insert: (chip) => updateStep(index, { prompt: `${step.prompt || ''}${chip}` }),
                                  })
                                }
                                rows={3}
                                placeholder={'예: 아래 검색 결과를 3줄로 요약해 줘.\n\n{{step1}}'}
                                className="w-full resize-y rounded-xl border px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:ring-2"
                                style={inputStyle}
                              />
                            </label>
                          ) : null}

                          {step.kind === 'action' ? (
                            <div className="mt-2 space-y-2">
                              <div className="flex gap-1">
                                {(['notify', 'todo'] as const).map((action) => (
                                  <button
                                    key={action}
                                    type="button"
                                    onClick={() => updateStep(index, { action })}
                                    className="flex flex-1 items-center justify-center gap-1 rounded-xl py-1.5 text-[11.5px] font-bold"
                                    style={
                                      step.action === action
                                        ? { background: 'var(--accent-soft)', color: 'var(--accent-deep)' }
                                        : { background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }
                                    }
                                  >
                                    {action === 'notify' ? <Bell size={12} /> : <ListChecks size={12} />}
                                    {action === 'notify' ? '알림 보내기' : '할 일 등록'}
                                  </button>
                                ))}
                              </div>
                              <textarea
                                value={step.text || ''}
                                onChange={(e) => updateStep(index, { text: e.target.value })}
                                onFocus={() =>
                                  (insertTarget.current = {
                                    insert: (chip) => updateStep(index, { text: `${step.text || ''}${chip}` }),
                                  })
                                }
                                rows={2}
                                placeholder={step.action === 'todo' ? '할 일 제목 (예: {{step2}})' : '알림 내용 (예: {{step2}})'}
                                className="w-full resize-y rounded-xl border px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:ring-2"
                                style={inputStyle}
                              />
                            </div>
                          ) : null}

                          <div className="mt-2 flex flex-wrap gap-1">
                            {chipsFor(index).map((chip) => (
                              <button
                                key={chip}
                                type="button"
                                onClick={() => insertChip(chip)}
                                className="rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold"
                                style={{ background: 'var(--pa-surface-3)', color: 'var(--accent-deep)' }}
                              >
                                {chip}
                              </button>
                            ))}
                          </div>

                          {result ? (
                            <div
                              className="mt-2 rounded-xl px-2.5 py-2 text-[11.5px] leading-relaxed"
                              style={{
                                background: result.status === 'failed' ? '#FFF1F1' : 'var(--accent-soft-weak)',
                                color: result.status === 'failed' ? '#C0363B' : 'var(--pa-ink)',
                              }}
                            >
                              <span className="font-bold">
                                {result.status === 'ok' ? '✅' : result.status === 'failed' ? '❌' : '⏭️'} 결과 ·{' '}
                                {(result.durationMs / 1000).toFixed(1)}초
                              </span>
                              <p className="mt-1 whitespace-pre-wrap break-words">
                                {(result.error || result.output || '(출력 없음)').slice(0, 900)}
                              </p>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={addStep}
                  disabled={form.steps.length >= 10}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-[12.5px] font-bold disabled:opacity-40"
                  style={{ background: 'var(--pa-surface-3)', color: 'var(--accent-deep)' }}
                >
                  <Plus size={14} /> 단계 추가 (최대 10)
                </button>

                {testRun ? (
                  <p className="text-[11.5px]" style={{ color: testRun.ok ? 'var(--pa-mute)' : '#C0363B' }}>
                    테스트 {testRun.ok ? '성공' : '실패'} · 전체 {(testRun.totalMs / 1000).toFixed(1)}초
                    {testRun.error ? ` · ${testRun.error.slice(0, 120)}` : ''}
                  </p>
                ) : null}
              </div>
            )}

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
                onClick={() => {
                  setForm(null);
                  setTestRun(null);
                }}
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
              아직 만든 도구가 없어요. 아래 예시에서 골라 시작해도 좋아요.
            </p>
          ) : null}
          {[...workflowSkills, ...promptSkills].map((skill) => (
            <Card key={skill.id} className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="block text-[15px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                      {skill.name}
                    </span>
                    {skill.mode === 'workflow' ? (
                      <span
                        className="rounded-md px-1.5 py-0.5 text-[10px] font-bold"
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
                      >
                        {stepsBadge(skill.steps)}
                      </span>
                    ) : null}
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
                        {skill.mode === 'workflow' ? '키워드 없음 · 이름으로 실행' : '키워드 없음 · 기본 적용'}
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

              {skill.mode === 'workflow' ? (
                <ol className="space-y-1 rounded-xl px-2.5 py-2" style={{ background: 'var(--pa-surface-3)' }}>
                  {skill.steps.slice(0, 4).map((step, index) => (
                    <li key={step.id} className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--pa-mute)' }}>
                      <span className="font-bold" style={{ color: 'var(--accent-deep)' }}>
                        {index + 1}
                      </span>
                      <span aria-hidden>{KIND_META[step.kind].emoji}</span>
                      <span className="truncate">
                        {step.kind === 'tool'
                          ? `${step.label} · ${step.tool}`
                          : step.kind === 'ai'
                            ? step.label
                            : `${step.action === 'todo' ? '할 일' : '알림'} · ${step.label}`}
                      </span>
                    </li>
                  ))}
                  {skill.steps.length > 4 ? (
                    <li className="text-[11px]" style={{ color: 'var(--pa-mute-2)' }}>
                      … {skill.steps.length - 4}단계 더
                    </li>
                  ) : null}
                </ol>
              ) : (
                <p className="line-clamp-3 whitespace-pre-line text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                  {skill.instructions}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {skill.mode === 'workflow' ? (
                  <button
                    type="button"
                    onClick={() => void runSaved(skill)}
                    className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12.5px] font-bold"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
                  >
                    <Play size={13} /> 실행
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setTestRun(null);
                    setSampleInput('');
                    setForm({
                      id: skill.id,
                      name: skill.name,
                      keywords: skill.keywords.join(', '),
                      instructions: skill.instructions,
                      alwaysApply: skill.alwaysApply,
                      mode: skill.mode,
                      steps: skill.steps.length ? skill.steps : [newStep('tool', '도구 실행')],
                    });
                  }}
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

              {runPanel?.id === skill.id ? (
                <div className="space-y-2 rounded-xl p-2.5" style={{ background: 'var(--pa-surface-3)' }}>
                  <div className="flex gap-2">
                    <input
                      value={runPanel.input}
                      onChange={(e) => setRunPanel({ ...runPanel, input: e.target.value })}
                      placeholder="실행할 내용 ({{input}})"
                      className="min-w-0 flex-1 rounded-xl border px-2.5 py-1.5 text-[12.5px] outline-none"
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => void runSaved(skill)}
                      disabled={runPanel.busy}
                      className="flex items-center gap-1 rounded-xl px-3 py-1.5 text-[12px] font-bold disabled:opacity-50"
                      style={{ background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }}
                    >
                      {runPanel.busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      {runPanel.busy ? '실행 중' : '실행'}
                    </button>
                  </div>
                  {runPanel.run ? (
                    <div className="space-y-1">
                      {runPanel.run.steps.map((step) => (
                        <p key={step.id} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                          {step.status === 'ok' ? '✅' : step.status === 'failed' ? '❌' : '⏭️'} {step.label} ·{' '}
                          {(step.durationMs / 1000).toFixed(1)}초
                          {step.error ? ` — ${step.error.slice(0, 100)}` : ''}
                        </p>
                      ))}
                      {runPanel.run.output ? (
                        <p
                          className="whitespace-pre-wrap break-words rounded-lg px-2 py-1.5 text-[11.5px] leading-relaxed"
                          style={{ background: 'var(--pa-surface)', color: 'var(--pa-ink)' }}
                        >
                          {runPanel.run.output.slice(0, 700)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
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

          {workflowTemplates.map((template) => {
            const added = skills.some((s) => s.name === template.name);
            return (
              <Card key={template.id} className="flex items-center gap-3">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
                  style={{ background: 'var(--pa-surface-3)', color: 'var(--accent-deep)' }}
                >
                  <Bot size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[14px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                      {template.name}
                    </span>
                    <span
                      className="rounded-md px-1.5 py-0.5 text-[10px] font-bold"
                      style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
                    >
                      {stepsBadge(template.steps)}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                    {template.summary}
                  </span>
                  <span className="mt-1 block text-[10.5px] font-semibold" style={{ color: 'var(--pa-mute-2)' }}>
                    단계 {template.steps.map((step) => KIND_META[step.kind].label).join(' → ')}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void addWorkflowTemplate(template)}
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
