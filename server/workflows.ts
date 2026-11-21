import crypto from 'node:crypto';
import { addLog, getJson } from './db';
import { decrypt, serverKey } from './crypto';
import { PROVIDERS, normalizeModel, runAgentStep, type ProviderId } from './providers';
import * as push from './push';

/**
 * v0.7.1 — 단계별 워크플로우 엔진
 *
 * '도구(스킬) 관리'에서 만든 커스텀 도구는 두 가지 모드를 가진다.
 *   · prompt   : 지침 문장을 시스템 프롬프트에 넣는다(기존 v0.6.6 방식, 그대로 호환)
 *   · workflow : 아래 세 종류의 단계를 서버가 순서대로 실행한다
 *
 *   1) tool   — 내장 도구를 LLM 토큰 없이 서버에서 직접 실행한다({{input}}·{{step1}} 치환)
 *   2) ai     — 현재 연결된 프로바이더의 모델로 이전 단계 결과를 요약·가공한다
 *   3) action — notify(웹 푸시/알림) 또는 todo(할 일 등록)
 *
 * 실행 결과는 단계별 출력·소요시간을 그대로 돌려주므로, 화면에서 '테스트 실행'으로
 * 저장 전에 미리 확인할 수 있다.
 */

export type WorkflowStepKind = 'tool' | 'ai' | 'action';

export type WorkflowAction = 'notify' | 'todo';

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  /** 화면에 보이는 단계 이름 (예: "뉴스 검색") */
  label: string;
  /** kind='tool' — 실행할 내장 도구 이름 */
  tool?: string;
  /** kind='tool' — 도구 인자(값에 {{input}}·{{step1}} 사용 가능) */
  args?: Record<string, string>;
  /** kind='ai' — 모델에게 보낼 지시문 */
  prompt?: string;
  /** kind='action' — 알림 보내기 / 할 일 등록 */
  action?: WorkflowAction;
  /** kind='action' — 알림 본문 또는 할 일 제목 */
  text?: string;
  /** 실패해도 다음 단계를 계속할지 (기본 false = 멈춤) */
  continueOnError?: boolean;
}

export const WORKFLOW_LIMITS = {
  /** 단계 수 상한 */
  steps: 10,
  /** 한 단계가 돌려주는 출력 길이 상한 */
  output: 6000,
  /** 실행 입력({{input}}) 길이 상한 */
  input: 4000,
  label: 60,
  prompt: 2000,
  text: 800,
  args: 20,
} as const;

/**
 * 워크플로우에서 실행을 막는 도구.
 * 비밀값을 꺼내거나(금고) 계정을 바꾸거나, 사용자 이름으로 메일을 보내는 일은
 * 단계 조립만으로 자동 실행되지 않게 한다(대화에서 승인·확인을 거쳐야 한다).
 */
export const BLOCKED_TOOLS = new Set<string>([
  'mail_send',
  'manage_docker',
  'browser_fill_vault',
  'browser_login_with_vault',
  'vault_request_login',
]);

function clean(value: unknown, max: number): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

/** 넘어온 단계 배열을 안전한 형태로 다듬는다(모르는 종류는 버린다). */
export function normalizeWorkflowSteps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value)) return [];
  const out: WorkflowStep[] = [];
  for (const raw of value.slice(0, WORKFLOW_LIMITS.steps)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const kind = String(row.kind || '') as WorkflowStepKind;
    if (kind !== 'tool' && kind !== 'ai' && kind !== 'action') continue;
    const step: WorkflowStep = {
      id: clean(row.id, 60) || crypto.randomUUID(),
      kind,
      label: clean(row.label, WORKFLOW_LIMITS.label),
    };
    if (kind === 'tool') {
      step.tool = clean(row.tool, 48);
      if (!step.tool) continue;
      const args: Record<string, string> = {};
      const rawArgs = (row.args ?? {}) as Record<string, unknown>;
      for (const [key, val] of Object.entries(rawArgs).slice(0, WORKFLOW_LIMITS.args)) {
        const name = clean(key, 40);
        if (!name) continue;
        args[name] = clean(val, WORKFLOW_LIMITS.output);
     }
      step.args = args;
    } else if (kind === 'ai') {
      step.prompt = clean(row.prompt, WORKFLOW_LIMITS.prompt);
      if (!step.prompt) continue;
    } else {
      const action = String(row.action || 'notify');
      step.action = action === 'todo' ? 'todo' : 'notify';
      step.text = clean(row.text, WORKFLOW_LIMITS.text);
      if (!step.text) continue;
    }
    if (!step.label) {
      step.label =
        kind === 'tool' ? step.tool || '도구' : kind === 'ai' ? 'AI 가공' : step.action === 'todo' ? '할 일 등록' : '알림';
    }
    if (row.continueOnError === true) step.continueOnError = true;
    out.push(step);
  }
  return out;
}

/** 저장 전 검증 — 단계가 하나도 없으면 저장할 이유가 없다. */
export function validateWorkflowSteps(value: unknown): { steps: WorkflowStep[] } | { error: string } {
  const steps = normalizeWorkflowSteps(value);
  if (!steps.length) return { error: '단계를 하나 이상 추가해 주세요.' };
  const blocked = steps.find((step) => step.kind === 'tool' && step.tool && BLOCKED_TOOLS.has(step.tool));
  if (blocked) {
    return { error: `'${blocked.tool}' 도구는 워크플로우에서 자동 실행할 수 없어요. 대화에서 직접 부탁해 주세요.` };
  }
  return { steps };
}

/* ------------------------------------------------------------------ */
/* 변수 치환                                                            */
/* ------------------------------------------------------------------ */

/**
 * {{input}} · {{step1}} · {{step2}} · {{prev}} · {{steps}} 를 값으로 바꾼다.
 * 모르는 자리표시자는 그대로 둔다(사용자가 쓴 중괄호를 망가뜨리지 않게).
 */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, key: string) => {
    const value = vars[key.toLowerCase()];
    return typeof value === 'string' ? value : whole;
  });
}

/** 단계 출력에서 변수 지도({{stepN}})를 만든다. */
function buildVars(input: string, outputs: string[]): Record<string, string> {
  const vars: Record<string, string> = { input };
  outputs.forEach((text, index) => {
    vars[`step${index + 1}`] = text;
  });
  vars.prev = outputs.length ? outputs[outputs.length - 1] : input;
  vars.steps = outputs.map((text, index) => `[${index + 1}] ${text}`).join('\n\n');
  return vars;
}

/* ------------------------------------------------------------------ */
/* AI 단계                                                              */
/* ------------------------------------------------------------------ */

interface ActiveLlm {
  provider: ProviderId;
  model: string;
  apiKey: string;
}

/** 설정에 저장된 현재 프로바이더·모델·키(없으면 null). 값은 어디에도 기록하지 않는다. */
export function activeLlm(): ActiveLlm | null {
  const state = getJson<{
    active?: { provider?: ProviderId; model?: string };
    accounts?: Record<string, { apiKeyEnc?: string }>;
  }>('llm.state', {});
  const provider = state.active?.provider;
  if (!provider || !(provider in PROVIDERS)) return null;
  const enc = state.accounts?.[provider]?.apiKeyEnc;
  if (!enc) return null;
  try {
    return { provider, model: normalizeModel(provider, state.active?.model), apiKey: decrypt(enc, serverKey()) };
  } catch {
    return null;
  }
}

const AI_STEP_SYSTEM_PROMPT = [
  '너는 사용자가 만든 단계별 워크플로우의 한 단계를 수행하는 실행기다.',
  '앞 단계의 출력만 근거로 삼아 지시된 일을 하고, 결과만 쓴다.',
  '없는 사실을 지어내지 말고, 근거가 부족하면 무엇이 부족한지 한 줄로 밝힌다.',
  '인사말·설명·머리말 없이 결과 본문만 6줄 이내로 답한다.',
].join('\n');

async function defaultGenerate(prompt: string): Promise<string> {
  const llm = activeLlm();
  if (!llm) throw new Error('연결된 AI 키가 없어 AI 단계를 실행할 수 없습니다. 설정에서 키를 연결해 주세요.');
  const result = await runAgentStep(
    llm.provider,
    llm.apiKey,
    llm.model,
    [
      { role: 'system', content: AI_STEP_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    undefined,
    true
  );
  return String(result.text || '').trim();
}

/* ------------------------------------------------------------------ */
/* 실행                                                                */
/* ------------------------------------------------------------------ */

export interface WorkflowStepResult {
  index: number;
  id: string;
  kind: WorkflowStepKind;
  label: string;
  status: 'ok' | 'failed' | 'skipped';
  output: string;
  durationMs: number;
  error?: string;
}

export interface WorkflowRunResult {
  ok: boolean;
  steps: WorkflowStepResult[];
  /** 마지막 단계의 출력(전체 요약으로 쓴다) */
  output: string;
  totalMs: number;
  error?: string;
}

export interface WorkflowRunOptions {
  input?: string;
  /** 채팅 세션 id — 알림·딥링크가 이 방으로 돌아온다 */
  session?: string | null;
  /** 워크플로우 이름(알림 제목) */
  name?: string;
  /** AI 단계 실행기(테스트에서 갈아 끼울 수 있다) */
  generate?: (prompt: string) => Promise<string>;
  /** action=notify 를 실제로 보낼지 (테스트 실행은 true) */
  notify?: boolean;
}

function oneLine(text: string, limit = 200): string {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * 단계 배열을 순서대로 실행한다.
 * 도구 단계는 토큰을 쓰지 않고 runTool 로 바로 돌리고, AI 단계만 모델을 부른다.
 */
export async function runWorkflowSteps(steps: WorkflowStep[], options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
  const input = clean(options.input, WORKFLOW_LIMITS.input);
  const outputs: string[] = [];
  const results: WorkflowStepResult[] = [];
  const startedAll = Date.now();
  let stopped = false;
  let firstError: string | undefined;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepStarted = Date.now();
    const vars = buildVars(input, outputs);
    if (stopped) {
      results.push({
        index: index + 1,
        id: step.id,
        kind: step.kind,
        label: step.label,
        status: 'skipped',
        output: '',
        durationMs: 0,
      });
      outputs.push('');
      continue;
    }
    try {
      let output = '';
      if (step.kind === 'tool') {
        if (!step.tool) throw new Error('도구가 지정되지 않았습니다.');
        if (BLOCKED_TOOLS.has(step.tool)) throw new Error(`'${step.tool}' 도구는 워크플로우에서 실행할 수 없습니다.`);
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(step.args || {})) args[key] = substituteVars(value, vars);
        const { runTool } = await import('./tools');
        const result = await runTool(step.tool, args, { session: options.session || undefined, userRequest: options.input || '' });
        output = String(result.content || '').trim();
        if (/^알 수 없는 도구입니다/.test(output)) throw new Error(output);
      } else if (step.kind === 'ai') {
        const prompt = substituteVars(step.prompt || '', vars);
        const generate = options.generate ?? defaultGenerate;
        output = String(await generate(prompt)).trim();
        if (!output) throw new Error('AI가 빈 결과를 돌려줬습니다.');
      } else {
        const text = substituteVars(step.text || '', vars);
        if (!text) throw new Error('알림·할 일 내용이 비어 있습니다.');
        if (step.action === 'todo') {
          const { createTask } = await import('./tools');
          createTask({ title: text.slice(0, 200), priority: 'normal', notes: '워크플로우에서 등록' });
          output = `할 일로 등록했습니다: ${oneLine(text, 120)}`;
        } else {
          if (options.notify !== false) {
            const sent = await push.notify({
              title: oneLine(options.name || '워크플로우 알림', 80),
              body: text.slice(0, 180),
              url: push.chatDeepLink({ session: options.session || undefined }),
              tag: 'workflow',
            });
            output = sent.sent
              ? `알림을 보냈습니다: ${oneLine(text, 120)}`
              : `알림은 보내지 않았습니다(${sent.reason || '앱을 보고 있는 중'}). 내용: ${oneLine(text, 120)}`;
          } else {
            output = `(알림 생략) ${oneLine(text, 120)}`;
          }
        }
      }
      const trimmed = output.slice(0, WORKFLOW_LIMITS.output);
      outputs.push(trimmed);
      results.push({
        index: index + 1,
        id: step.id,
        kind: step.kind,
        label: step.label,
        status: 'ok',
        output: trimmed,
        durationMs: Date.now() - stepStarted,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      firstError = firstError || message;
      outputs.push('');
      results.push({
        index: index + 1,
        id: step.id,
        kind: step.kind,
        label: step.label,
        status: 'failed',
        output: '',
        durationMs: Date.now() - stepStarted,
        error: message.slice(0, 400),
      });
      if (!step.continueOnError) stopped = true;
    }
  }

  const last = [...outputs].reverse().find((text) => text.trim()) || '';
  const failed = results.some((step) => step.status === 'failed');
  return {
    ok: !failed,
    steps: results,
    output: last.slice(0, WORKFLOW_LIMITS.output),
    totalMs: Date.now() - startedAll,
    ...(firstError ? { error: firstError } : {}),
  };
}

/** 실행 결과를 채팅·화면에 그대로 보여 줄 텍스트로 만든다. */
export function formatWorkflowRun(name: string, run: WorkflowRunResult): string {
  const lines = [
    `▶ 워크플로우 '${name}' 실행 결과 (${run.steps.length}단계 · ${(run.totalMs / 1000).toFixed(1)}초)`,
    ...run.steps.map((step) => {
      const mark = step.status === 'ok' ? '✅' : step.status === 'failed' ? '❌' : '⏭️';
      const head = `${mark} ${step.index}. ${step.label} (${((step.durationMs || 0) / 1000).toFixed(1)}초)`;
      if (step.status === 'failed') return `${head}\n   실패: ${step.error || '알 수 없는 오류'}`;
      if (!step.output) return head;
      return `${head}\n${step.output
        .split('\n')
        .slice(0, 8)
        .map((line) => `   ${line}`)
        .join('\n')}`;
    }),
  ];
  if (run.error) lines.push('', `⚠️ ${run.error}`);
  return lines.join('\n').slice(0, 6000);
}

/* ------------------------------------------------------------------ */
/* 예시 템플릿 (개인정보 없는 범용 예시만)                              */
/* ------------------------------------------------------------------ */

export interface WorkflowTemplate {
  id: string;
  name: string;
  summary: string;
  keywords: string[];
  steps: WorkflowStep[];
  /** 테스트 실행에 넣어 볼 예시 입력 */
  sampleInput: string;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'brief-then-notify',
    name: '검색 → 요약 → 알림',
    summary: '한 주제를 검색해 3줄로 요약한 뒤 알림으로 보냅니다.',
    keywords: ['요약', '검색', '브리핑'],
    sampleInput: '이번 주 인공지능 관련 주요 뉴스',
    steps: [
      {
        id: 'search',
        kind: 'tool',
        label: '웹 검색',
        tool: 'web_search',
        args: { query: '{{input}}' },
      },
      {
        id: 'summarize',
        kind: 'ai',
        label: '3줄 요약',
        prompt: [
          '아래 검색 결과를 근거로 핵심만 3줄로 정리해 주세요.',
          '각 줄은 40자 안쪽, 숫자·날짜·고유명사는 그대로 옮기고 추측은 "(추정)"을 붙입니다.',
          '',
          '[검색 결과]',
          '{{step1}}',
        ].join('\n'),
      },
      {
        id: 'notify',
        kind: 'action',
        label: '알림 보내기',
        action: 'notify',
        text: '{{step2}}',
      },
    ],
  },
  {
    id: 'daily-tidy',
    name: '할 일 점검 → 정리 → 등록',
    summary: '남은 할 일을 모아 우선순위를 정리하고, 오늘 할 일을 하나 등록합니다.',
    keywords: ['할 일', '정리', '점검'],
    sampleInput: '오늘 마무리할 일',
    steps: [
      {
        id: 'list',
        kind: 'tool',
        label: '할 일 조회',
        tool: 'tasks_list',
        args: { status: 'open' },
      },
      {
        id: 'plan',
        kind: 'ai',
        label: '우선순위 정리',
        prompt: [
          '아래 남은 할 일 목록을 보고 오늘 먼저 할 일 3개를 골라 순서대로 정리해 주세요.',
          '마감이 있는 일을 먼저 두고, 각 항목은 "1) 할 일 — 이유 한 줄" 형태로 씁니다.',
          '',
          '[할 일 목록]',
          '{{step1}}',
        ].join('\n'),
      },
      {
        id: 'todo',
        kind: 'action',
        label: '오늘 할 일 등록',
        action: 'todo',
        text: '오늘 우선순위 점검: {{step2}}',
      },
    ],
  },
];

/** 템플릿에서 새 워크플로우용 단계를 만든다(단계 id는 새로 발급). */
export function templateSteps(templateId: string): { name: string; keywords: string[]; steps: WorkflowStep[] } | null {
  const template = WORKFLOW_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return null;
  return {
    name: template.name,
    keywords: template.keywords,
    steps: template.steps.map((step) => ({ ...step, id: crypto.randomUUID(), args: step.args ? { ...step.args } : undefined })),
  };
}

/** 실행 로그 한 줄 */

export function logWorkflowRun(name: string, run: WorkflowRunResult): void {
  const failed = run.steps.filter((step) => step.status === 'failed').length;
  addLog(
    failed ? 'warn' : 'success',
    `워크플로우 실행 · ${name} (${run.steps.length}단계, ${failed ? `실패 ${failed}` : '성공'}, ${(run.totalMs / 1000).toFixed(1)}초)`
  );
}
