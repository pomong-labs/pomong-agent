/**
 * v0.6.6 — 나만의 지침 도구(커스텀 스킬)
 *
 * 사용자가 '더보기 → 도구(스킬) 관리'에서 직접 만든 지침을 DB에 저장한다.
 * 채팅·예약 실행 때 이번 요청에 맞는 지침만 시스템 프롬프트에 넣어
 * (키워드가 맞지 않는 지침은 제목 한 줄만) 토큰을 아낀다.
 *
 * 저장 위치: custom_skills 테이블(server/db.ts)
 */

import crypto from 'node:crypto';
import { db } from './db';
import { normalizeWorkflowSteps, validateWorkflowSteps, WORKFLOW_TEMPLATES, type WorkflowStep } from './workflows';

/**
 * v0.7.1: 커스텀 도구는 두 모드다.
 *  · prompt   — 지침 문장을 시스템 프롬프트에 넣는다(v0.6.6 방식 그대로)
 *  · workflow — 단계(tool·ai·action)를 서버가 순서대로 실행한다(server/workflows.ts)
 */
export type SkillMode = 'prompt' | 'workflow';

export interface CustomSkill {
  id: string;
  name: string;
  /**
   * 발동 키워드.
   * v0.6.19: 비어 있으면 '기본 안내'로 보고 매 요청에 적용한다(예전에는 영영 발동하지 않았다).
   */
  keywords: string[];
  instructions: string;
  /** 키워드와 상관없이 항상 적용 */
  alwaysApply: boolean;
  enabled: boolean;
  /** v0.7.1: 'prompt'(글로 쓰기) | 'workflow'(단계별 조립) */
  mode: SkillMode;
  /** v0.7.1: mode='workflow'일 때의 단계들 */
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillInput {
  name?: unknown;
  keywords?: unknown;
  instructions?: unknown;
  alwaysApply?: unknown;
  enabled?: unknown;
  /** v0.7.1 */
  mode?: unknown;
  steps?: unknown;
}

export interface SkillTemplate {
  id: string;
  name: string;
  summary: string;
  keywords: string[];
  instructions: string;
}

/** 이름·지침 길이 제한 (프롬프트가 너무 커지지 않게) */
export const SKILL_LIMITS = {
  name: 40,
  keywords: 20,
  keywordLength: 24,
  instructions: 4000,
} as const;

/** 예시 템플릿 — 개인정보 없는 범용 예시만 둔다(오픈소스 배포 조건). */
export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    id: 'three-line-report',
    name: '3줄 핵심 보고',
    summary: '결론 → 근거 → 다음 할 일, 세 줄로만 정리합니다.',
    keywords: ['요약', '정리', '보고'],
    instructions: [
      '- 결론 한 줄 → 근거 2~3개 → 다음 할 일 한 줄, 이 순서로만 씁니다.',
      '- 각 줄은 40자 안쪽으로 짧게 씁니다.',
      '- 숫자·날짜·고유명사는 원문 그대로 옮기고, 추측한 내용은 뒤에 "(추정)"을 붙입니다.',
    ].join('\n'),
  },
  {
    id: 'inquiry-reply',
    name: '고객·문의 응대 매뉴얼',
    summary: '문의 답장을 정중하고 짧게, 다음 단계까지 안내합니다.',
    keywords: ['문의', '답장', '응대'],
    instructions: [
      '- 먼저 상대의 요청을 한 문장으로 확인한 뒤 답합니다.',
      '- 사과가 필요한 상황이면 변명 없이 짧게 사과하고 바로 해결 방법을 제시합니다.',
      '- 확정되지 않은 일정·금액·정책은 약속하지 않고 "확인 후 안내드리겠습니다"로 남깁니다.',
      '- 답장은 3~5문장, 마지막 줄에 다음 단계를 한 줄로 안내합니다.',
    ].join('\n'),
  },
  {
    id: 'price-compare',
    name: '쇼핑·가격 비교 기준',
    summary: '배송비까지 포함한 총액으로 비교하고 한 줄 추천을 붙입니다.',
    keywords: ['구매', '가격', '비교', '추천'],
    instructions: [
      '- 후보를 2~4개로 좁혀 가격·배송비·배송 기간·후기 수를 나란히 보여 줍니다.',
      '- 배송비와 추가 비용을 포함한 최종 결제 금액으로 비교합니다.',
      '- 최저가 하나만 고르지 말고 "총비용 대비 만족"을 기준으로 한 줄 추천을 덧붙입니다.',
      '- 결제는 하지 않습니다. 구매 링크와 예상 금액만 알려 줍니다.',
    ].join('\n'),
  },
  {
    id: 'meeting-notes',
    name: '회의록 정리',
    summary: '결정된 것 / 논의 중 / 다음 할 일로 나눠 정리합니다.',
    keywords: ['회의', '회의록', '미팅', '메모'],
    instructions: [
      '- 첫머리에 일시·참석자·목적을 한 줄씩 적습니다.',
      '- 본문은 "결정된 것 / 논의 중인 것 / 다음 할 일(담당·기한)" 세 묶음으로 나눕니다.',
      '- 발언을 그대로 옮기지 말고 요약하고, 불확실한 내용은 "확인 필요"로 표시합니다.',
    ].join('\n'),
  },
];

/* ------------------------------------------------------------------ */
/* 값 정리                                                            */
/* ------------------------------------------------------------------ */

/**
 * "요약, 정리, 보고" · "요약 정리" · "요약;정리" → ['요약','정리','보고']
 * 쉼표가 없이 띄어쓰기만 있으면 낱말마다 키워드로 본다.
 */
export function normalizeKeywords(value: unknown): string[] {
  const source = Array.isArray(value) ? value.map((v) => String(v ?? '')).join(',') : String(value ?? '');
  const hasSeparator = /[,，;；\n|]/.test(source);
  const out: string[] = [];
  for (const raw of source.split(hasSeparator ? /[,，;；\n|]/ : /\s+/)) {
    const word = raw.trim().toLowerCase().slice(0, SKILL_LIMITS.keywordLength);
    if (!word) continue;
    if (!out.includes(word)) out.push(word);
    if (out.length >= SKILL_LIMITS.keywords) return out;
  }
  return out;
}

export function normalizeMode(value: unknown, fallback: SkillMode = 'prompt'): SkillMode {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'workflow' || mode === 'prompt') return mode;
  return fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

interface SkillRow {
  id: string;
  name: string;
  keywords: string;
  instructions: string;
  always_on: number;
  enabled: number;
  mode: string | null;
  steps_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseSteps(raw: string | null): WorkflowStep[] {
  if (!raw) return [];
  try {
    return normalizeWorkflowSteps(JSON.parse(raw));
  } catch {
    return [];
  }
}

function toSkill(row: SkillRow): CustomSkill {
  return {
    id: row.id,
    name: row.name,
    keywords: normalizeKeywords(row.keywords),
    instructions: row.instructions,
    alwaysApply: Boolean(row.always_on),
    enabled: Boolean(row.enabled),
    mode: normalizeMode(row.mode),
    steps: parseSteps(row.steps_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT =
  'SELECT id, name, keywords, instructions, always_on, enabled, mode, steps_json, created_at, updated_at FROM custom_skills';

/* ------------------------------------------------------------------ */
/* CRUD                                                               */
/* ------------------------------------------------------------------ */

export function listSkills(): CustomSkill[] {
  const rows = db.prepare(`${SELECT} ORDER BY created_at ASC`).all() as SkillRow[];
  return rows.map(toSkill);
}

export function getSkill(id: string): CustomSkill | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as SkillRow | undefined;
  return row ? toSkill(row) : null;
}

interface CleanSkill {
  name: string;
  keywords: string[];
  instructions: string;
  alwaysApply: boolean;
  enabled: boolean;
  mode: SkillMode;
  steps: WorkflowStep[];
}

function validInput(input: SkillInput): CleanSkill | { error: string } {
  const name = cleanText(input.name, SKILL_LIMITS.name);
  if (!name) return { error: '도구 이름을 입력해 주세요.' };
  const mode = normalizeMode(input.mode);
  if (mode === 'workflow') {
    const checked = validateWorkflowSteps(input.steps);
    if ('error' in checked) return checked;
    return {
      name,
      keywords: normalizeKeywords(input.keywords),
      // 워크플로우는 지침 문장이 없어도 된다(있으면 실행 후 안내 문구로 쓴다).
      instructions: cleanText(input.instructions, SKILL_LIMITS.instructions),
      alwaysApply: toBool(input.alwaysApply, false),
      enabled: toBool(input.enabled, true),
      mode,
      steps: checked.steps,
    };
  }
  const instructions = cleanText(input.instructions, SKILL_LIMITS.instructions);
  if (!instructions) return { error: '지침 내용을 입력해 주세요.' };
  return {
    name,
    keywords: normalizeKeywords(input.keywords),
    instructions,
    alwaysApply: toBool(input.alwaysApply, false),
    enabled: toBool(input.enabled, true),
    mode,
    // v0.7.1: 글로 쓰기 모드로 돌아가도 조립해 둔 단계를 잃지 않는다(다시 전환하면 그대로 돌아온다).
    steps: normalizeWorkflowSteps((input as { steps?: unknown }).steps),
  };
}

export function createSkill(input: SkillInput): CustomSkill | { error: string } {
  const clean = validInput(input);
  if ('error' in clean) return clean;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO custom_skills(id, name, keywords, instructions, always_on, enabled, mode, steps_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(
    id,
    clean.name,
    clean.keywords.join(', '),
    clean.instructions,
    clean.alwaysApply ? 1 : 0,
    clean.enabled ? 1 : 0,
    clean.mode,
    JSON.stringify(clean.steps),
    now,
    now
  );
  return getSkill(id) as CustomSkill;
}

export function updateSkill(id: string, input: SkillInput): CustomSkill | { error: string } | null {
  const current = getSkill(id);
  if (!current) return null;
  // 넘어온 값만 바꾼다(토글만 보낼 때 지침을 지우지 않게).
  const merged: SkillInput = {
    name: input.name ?? current.name,
    keywords: input.keywords ?? current.keywords,
    instructions: input.instructions ?? current.instructions,
    alwaysApply: input.alwaysApply ?? current.alwaysApply,
    enabled: input.enabled ?? current.enabled,
    mode: input.mode ?? current.mode,
    steps: input.steps ?? current.steps,
  };
  const clean = validInput(merged);
  if ('error' in clean) return clean;
  db.prepare(
    'UPDATE custom_skills SET name = ?, keywords = ?, instructions = ?, always_on = ?, enabled = ?, mode = ?, steps_json = ?, updated_at = ? WHERE id = ?'
  ).run(
    clean.name,
    clean.keywords.join(', '),
    clean.instructions,
    clean.alwaysApply ? 1 : 0,
    clean.enabled ? 1 : 0,
    clean.mode,
    JSON.stringify(clean.steps),
    new Date().toISOString(),
    id
  );
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  const info = db.prepare('DELETE FROM custom_skills WHERE id = ?').run(id);
  return info.changes > 0;
}

/** 예시 템플릿을 원클릭으로 추가. 같은 이름이 이미 있으면 만들지 않고 그대로 알려 준다. */
export function addTemplate(templateId: string): CustomSkill | { error: string } | { existing: CustomSkill } {
  const template = SKILL_TEMPLATES.find((t) => t.id === templateId);
  if (!template) return { error: '예시 템플릿을 찾을 수 없습니다.' };
  const existing = listSkills().find((s) => s.name === template.name);
  if (existing) return { existing };
  return createSkill({
    name: template.name,
    keywords: template.keywords,
    instructions: template.instructions,
    alwaysApply: false,
    enabled: true,
    mode: 'prompt',
  });
}

/** v0.7.1: 워크플로우 예시 템플릿도 같은 버튼으로 추가한다. */
export function addWorkflowTemplate(templateId: string): CustomSkill | { error: string } | { existing: CustomSkill } {
  const template = WORKFLOW_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return { error: '워크플로우 템플릿을 찾을 수 없습니다.' };
  const existing = listSkills().find((s) => s.name === template.name);
  if (existing) return { existing };
  return createSkill({
    name: template.name,
    keywords: template.keywords,
    instructions: template.summary,
    alwaysApply: false,
    enabled: true,
    mode: 'workflow',
    steps: template.steps.map((step) => ({ ...step, id: crypto.randomUUID(), args: step.args ? { ...step.args } : undefined })),
  });
}

/** 화면·API에 함께 내려보내는 워크플로우 템플릿(단계 포함) */
export function workflowTemplatesForClient(): {
  id: string;
  name: string;
  summary: string;
  keywords: string[];
  sampleInput: string;
  steps: WorkflowStep[];
}[] {
  return WORKFLOW_TEMPLATES.map((item) => ({
    id: item.id,
    name: item.name,
    summary: item.summary,
    keywords: item.keywords,
    sampleInput: item.sampleInput,
    steps: item.steps,
  }));
}

/* ------------------------------------------------------------------ */
/* 프롬프트 주입                                                       */
/* ------------------------------------------------------------------ */

/**
 * 비교용 글자 형태 — 띄어쓰기·문장부호·대소문자를 없앤다.
 * '할 일' → '할일', '3줄  핵심 보고!' → '3줄핵심보고'
 */
export function squeeze(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 두 글자 묶음 — '회의록' → {'회의','의록'} */
function bigrams(value: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2));
  return out;
}

/** 낱말 단위로 쪼갠 요청 (한 글자 낱말은 버린다) */
function words(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

/**
 * 지침·스킬 자체를 언급한 요청인지.
 * "방금 만든 지침 적용해서 답해줘"처럼 스킬 이름도 키워드도 없는 요청에서
 * 본문이 통째로 빠지던 문제를 막는다(v0.6.19).
 */
const SKILL_MENTION_RE =
  /(지침|스킬|도구\s*관리|도구\s*설정|커스텀\s*(?:도구|지침|스킬)|방금\s*(?:추가|만든|등록|저장|넣)|금방\s*(?:추가|만든|등록|저장)|아까\s*(?:추가|만든|등록|저장)|방금\s*그|아까\s*그)/i;

export function mentionsSkillTools(request: string): boolean {
  return SKILL_MENTION_RE.test(String(request || ''));
}

/**
 * 키워드 하나가 요청에 걸리는지.
 * 띄어쓰기 차이('할 일' ↔ '할일')와 조사·어미 차이('회의록' ↔ '회의 정리')를 흡수한다.
 */
function keywordHits(text: string, squeezedText: string, wordList: string[], keyword: string): boolean {
  const raw = String(keyword || '').trim().toLowerCase();
  if (!raw) return false;
  if (text.includes(raw)) return true;
  const key = squeeze(raw);
  if (!key) return false;
  if (squeezedText.includes(key)) return true;
  if (key.length < 2) return false;
  // 어미만 다른 말까지: 두 글자 묶음이 절반 이상 겹치면 같은 말로 본다.
  const keyGrams = bigrams(key);
  if (keyGrams.size === 0) return false;
  for (const word of wordList) {
    const squashed = squeeze(word);
    if (squashed.length < 2) continue;
    let hit = 0;
    for (const gram of bigrams(squashed)) if (keyGrams.has(gram)) hit += 1;
    if (hit >= 1 && hit / keyGrams.size >= 0.5) return true;
  }
  return false;
}

/** 제목이 요청에 나오는지 — 대소문자·공백을 무시하고, 여러 낱말 제목은 절반 이상 겹치면 잡는다. */
function nameHits(squeezedText: string, wordList: string[], name: string): boolean {
  const full = squeeze(name);
  if (!full) return false;
  if (full.length >= 2 && squeezedText.includes(full)) return true;
  const tokens = String(name || '')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => squeeze(t))
    .filter((t) => t.length >= 2);
  if (tokens.length < 2) return false;
  const squashedWords = wordList.map((w) => squeeze(w));
  const matched = tokens.filter((token) => squashedWords.some((w) => w === token || w.includes(token) || token.includes(w))).length;
  return matched >= Math.ceil(tokens.length / 2);
}

/**
 * 이번 요청에 발동하는 지침.
 *  · 항상 적용
 *  · 제목이 요청에 나옴(대소문자·공백 무시)
 *  · 키워드 일치(띄어쓰기·조사 차이 흡수)
 *  · 키워드가 비어 있는 지침(기본 안내)
 *  · 지침 자체를 언급한 요청("방금 만든 지침 적용해") → 활성 지침 전부
 * v0.7.1: 워크플로우(mode='workflow')는 지침 본문이 아니라 run_workflow 로 실행하므로 여기서 빠진다.
 */
export function matchSkills(request: string, skills: CustomSkill[] = listSkills()): CustomSkill[] {
  const text = String(request || '').toLowerCase();
  const squeezedText = squeeze(text);
  const wordList = words(text);
  const explicit = mentionsSkillTools(text);
  return skills.filter((skill) => {
    if (!skill.enabled) return false;
    if (skill.mode === 'workflow') return false;
    if (skill.alwaysApply) return true;
    if (explicit) return true;
    if (nameHits(squeezedText, wordList, skill.name)) return true;
    if (skill.keywords.some((keyword) => keywordHits(text, squeezedText, wordList, keyword))) return true;
    // 키워드를 비워 둔 지침은 '기본 안내'로 보고 매번 적용한다.
    return skill.keywords.length === 0;
  });
}

/**
 * v0.7.1: 이번 요청에 맞는 워크플로우(실행 후보).
 * 워크플로우는 지침처럼 매번 본문을 넣지 않고, 시스템 프롬프트에는 목록만 보여 준다.
 */
export function matchWorkflows(request: string, skills: CustomSkill[] = listSkills()): CustomSkill[] {
  const text = String(request || '').toLowerCase();
  const squeezedText = squeeze(text);
  const wordList = words(text);
  return skills.filter((skill) => {
    if (!skill.enabled || skill.mode !== 'workflow') return false;
    if (nameHits(squeezedText, wordList, skill.name)) return true;
    return skill.keywords.some((keyword) => keywordHits(text, squeezedText, wordList, keyword));
  });
}

/** 워크플로우 한 단계를 사람이 읽는 한 줄로 */
export function stepSummaryLine(step: WorkflowStep, index: number): string {
  const head = `${index + 1}. `;
  if (step.kind === 'tool') {
    const args = Object.entries(step.args || {})
      .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ').slice(0, 40)}`)
      .join(', ');
    return `${head}[도구] ${step.tool || '?'}${args ? ` (${args})` : ''}`;
  }
  if (step.kind === 'ai') return `${head}[AI] ${String(step.prompt || '').replace(/\s+/g, ' ').slice(0, 90)}`;
  return `${head}[${step.action === 'todo' ? '할 일' : '알림'}] ${String(step.text || '').replace(/\s+/g, ' ').slice(0, 70)}`;
}

/** 지침 한 줄 요약 — 목록·도구 응답에 쓴다 */
export function skillSummaryLine(skill: CustomSkill): string {
  if (skill.mode === 'workflow') return `- ${skill.name} (워크플로우 · ${skill.steps.length}단계)`;
  if (skill.alwaysApply) return '- ' + skill.name + ' (항상 적용)';
  if (skill.keywords.length === 0) return '- ' + skill.name + ' (키워드 없음 · 기본 적용)';
  return '- ' + skill.name + ' — ' + skill.keywords.join(', ');
}

/** 지침 본문 한 덩어리 (read_skill 응답) */
export function skillBody(skill: CustomSkill): string {
  if (skill.mode === 'workflow') {
    const lines = [
      `### ${skill.name} (워크플로우 · ${skill.steps.length}단계)`,
      skill.instructions ? skill.instructions : '',
      ...skill.steps.map((step, index) => stepSummaryLine(step, index)),
      skill.enabled ? '실행: run_workflow 도구에 이 이름과 입력을 넣으면 서버가 단계를 순서대로 실행합니다.' : '',
      skill.enabled ? '' : '(이 워크플로우는 지금 꺼져 있습니다. 쓰려면 사용자가 도구 관리에서 켜야 합니다.)',
    ].filter((line) => line !== '');
    return lines.join('\n');
  }
  const tag = skill.alwaysApply
    ? '항상 적용'
    : skill.keywords.length === 0
      ? '키워드 없음 · 기본 적용'
      : '발동: ' + skill.keywords.join(', ');
  const off = skill.enabled ? '' : '\n(이 지침은 지금 꺼져 있습니다. 쓰려면 사용자가 도구 관리에서 켜야 합니다.)';
  return '### ' + skill.name + ' (' + tag + ')\n' + skill.instructions + off;
}

/**
 * `read_skill` 내장 도구의 본문.
 * 이름·id로 한 개, all=true면 켜져 있는 지침 전부.
 * 매 호출마다 DB를 새로 읽으므로 UI에서 방금 추가·수정한 지침도 바로 나온다.
 */
export function readSkillForTool(query: unknown, all = false): { content: string; meta: 'skills' } {
  const every = listSkills();
  if (all) {
    const on = every.filter((s) => s.enabled);
    if (!on.length) return { content: '켜져 있는 지침 도구가 없습니다.', meta: 'skills' };
    return { content: on.map(skillBody).join('\n\n'), meta: 'skills' };
  }
  const asked = String(query ?? '').trim();
  const catalog = every.length ? every.map(skillSummaryLine).join('\n') : '(없음)';
  if (!asked) {
    return { content: '어떤 지침을 읽을지 이름을 알려 주세요.\n[지침 목록]\n' + catalog, meta: 'skills' };
  }
  const key = squeeze(asked);
  const exact = every.find((s) => s.id === asked);
  const found =
    exact ||
    every.find((s) => squeeze(s.name) === key) ||
    (key.length >= 2
      ? every.find((s) => squeeze(s.name).includes(key) || key.includes(squeeze(s.name))) ||
        every.find((s) => s.keywords.some((k) => squeeze(k) === key))
      : undefined);
  if (!found) {
    return {
      content: "'" + asked + "' 지침을 찾지 못했습니다.\n[지침 목록]\n" + catalog + '\n필요한 지침이 없으면 사용자에게 도구(스킬) 관리에서 추가해 달라고 안내하세요.',
      meta: 'skills',
    };
  }
  return { content: skillBody(found), meta: 'skills' };
}

/**
 * 시스템 프롬프트에 붙일 지침 블록.
 * 토큰을 아끼려고 맞은 지침만 내용을 넣고, 맞지 않는 지침은 제목 한 줄만 남긴다.
 * (v0.6.19: 남은 지침도 read_skill로 즉시 꺼내 쓸 수 있다고 알려 준다)
 */
export function skillPromptBlock(request: string, skills: CustomSkill[] = listSkills(), precomputed?: CustomSkill[]): string {
  const enabled = skills.filter((s) => s.enabled);
  const promptSkills = enabled.filter((s) => s.mode !== 'workflow');
  const workflows = enabled.filter((s) => s.mode === 'workflow');
  if (enabled.length === 0) return '';
  const active = precomputed ?? matchSkills(request, promptSkills);
  const activeIds = new Set(active.map((s) => s.id));
  const rest = promptSkills.filter((s) => !activeIds.has(s.id));
  const matchedWorkflows = matchWorkflows(request, workflows);

  const lines: string[] = [
    '[사용자 지침 도구]',
    "사용자가 '도구(스킬) 관리'에서 직접 만든 지침입니다. 아래에 내용이 실린 지침은 이번 요청에서 반드시 따르세요. 제목만 보이는 지침이라도 이번 요청에 필요해 보이면 read_skill 도구로 이름을 넣어 전체 내용을 읽은 뒤 따르세요(읽는 즉시 최신 내용이 적용됩니다). 안전 규칙(비밀번호·결제·삭제 금지)과 충돌하면 안전 규칙이 우선입니다.",
  ];

  let budget = 8000;
  for (const skill of active) {
    const body = skill.instructions.slice(0, Math.max(0, budget));
    if (!body) break;
    budget -= body.length;
    const tag = skill.alwaysApply
      ? ' (항상 적용)'
      : skill.keywords.length === 0
        ? ' (키워드 없음 · 기본 적용)'
        : ' (발동: ' + skill.keywords.join(', ') + ')';
    lines.push('', '### ' + skill.name + tag, body);
  }
  if (active.length === 0) {
    lines.push(
      '',
      '이번 요청에 자동으로 맞춰 실린 지침은 없습니다. 아래 목록에서 지금 요청과 관계있어 보이는 지침이 있으면 read_skill 도구로 이름을 넣어 전체 내용을 읽고 그대로 따르세요. 관계없으면 그냥 답하세요.'
    );
  }
  if (rest.length) {
    lines.push(
      '',
      '[다른 지침 도구 — 내용은 생략, 필요하면 read_skill로 읽기]',
      ...rest.map((s) => skillSummaryLine(s))
    );
  }
  /**
   * v0.7.1: 단계별 워크플로우 목록.
   * 사용자가 "그 워크플로우 돌려줘"라고 하면 run_workflow(이름, input)으로 서버가 대신 실행한다.
   * (지침 본문을 토큰으로 넣지 않고, 단계 실행은 서버가 한다)
   */
  if (workflows.length) {
    lines.push(
      '',
      '[저장된 워크플로우 — run_workflow(이름, input)로 실행]',
      "워크플로우는 여러 단계(도구 실행·AI 가공·알림/할 일)를 서버가 순서대로 처리합니다. 사용자가 이름을 부르거나 이번 요청이 아래 워크플로우와 맞으면, 직접 도구를 하나씩 부르지 말고 run_workflow에 이름과 입력(input)을 넣어 실행한 뒤 결과를 요약해 알려 주세요.",
      ...workflows.map((s) =>
        matchedWorkflows.some((m) => m.id === s.id)
          ? `- ${s.name} (워크플로우 · ${s.steps.length}단계 · 이번 요청과 일치${s.keywords.length ? `: ${s.keywords.join(', ')}` : ''})`
          : skillSummaryLine(s)
      )
    );
  }
  return lines.join('\n');
}
