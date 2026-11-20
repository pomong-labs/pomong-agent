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

export interface CustomSkill {
  id: string;
  name: string;
  /** 발동 키워드 (없으면 항상 적용이 아닌 한 발동하지 않는다) */
  keywords: string[];
  instructions: string;
  /** 키워드와 상관없이 항상 적용 */
  alwaysApply: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillInput {
  name?: unknown;
  keywords?: unknown;
  instructions?: unknown;
  alwaysApply?: unknown;
  enabled?: unknown;
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
  created_at: string;
  updated_at: string;
}

function toSkill(row: SkillRow): CustomSkill {
  return {
    id: row.id,
    name: row.name,
    keywords: normalizeKeywords(row.keywords),
    instructions: row.instructions,
    alwaysApply: Boolean(row.always_on),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = 'SELECT id, name, keywords, instructions, always_on, enabled, created_at, updated_at FROM custom_skills';

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

function validInput(input: SkillInput): { name: string; keywords: string[]; instructions: string; alwaysApply: boolean; enabled: boolean } | { error: string } {
  const name = cleanText(input.name, SKILL_LIMITS.name);
  if (!name) return { error: '도구 이름을 입력해 주세요.' };
  const instructions = cleanText(input.instructions, SKILL_LIMITS.instructions);
  if (!instructions) return { error: '지침 내용을 입력해 주세요.' };
  return {
    name,
    keywords: normalizeKeywords(input.keywords),
    instructions,
    alwaysApply: toBool(input.alwaysApply, false),
    enabled: toBool(input.enabled, true),
  };
}

export function createSkill(input: SkillInput): CustomSkill | { error: string } {
  const clean = validInput(input);
  if ('error' in clean) return clean;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO custom_skills(id, name, keywords, instructions, always_on, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id, clean.name, clean.keywords.join(', '), clean.instructions, clean.alwaysApply ? 1 : 0, clean.enabled ? 1 : 0, now, now);
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
  };
  const clean = validInput(merged);
  if ('error' in clean) return clean;
  db.prepare(
    'UPDATE custom_skills SET name = ?, keywords = ?, instructions = ?, always_on = ?, enabled = ?, updated_at = ? WHERE id = ?'
  ).run(clean.name, clean.keywords.join(', '), clean.instructions, clean.alwaysApply ? 1 : 0, clean.enabled ? 1 : 0, new Date().toISOString(), id);
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
  });
}

/* ------------------------------------------------------------------ */
/* 프롬프트 주입                                                       */
/* ------------------------------------------------------------------ */

/** 이번 요청에 발동하는 지침 (항상 적용 + 키워드 일치) */
export function matchSkills(request: string, skills: CustomSkill[] = listSkills()): CustomSkill[] {
  const text = String(request || '').toLowerCase();
  return skills.filter((skill) => {
    if (!skill.enabled) return false;
    if (skill.alwaysApply) return true;
    return skill.keywords.some((keyword) => text.includes(keyword));
  });
}

/**
 * 시스템 프롬프트에 붙일 지침 블록.
 * 토큰을 아끼려고 맞은 지침만 내용을 넣고, 맞지 않는 지침은 제목+키워드 한 줄만 남긴다.
 */
export function skillPromptBlock(request: string, skills: CustomSkill[] = listSkills()): string {
  const enabled = skills.filter((s) => s.enabled);
  if (enabled.length === 0) return '';
  const active = matchSkills(request, enabled);
  const activeIds = new Set(active.map((s) => s.id));
  const rest = enabled.filter((s) => !activeIds.has(s.id));

  const lines: string[] = [
    '[사용자 지침 도구]',
    "사용자가 '도구(스킬) 관리'에서 직접 만든 지침입니다. 아래 지침 중 이번 요청에 해당하는 것은 반드시 따르세요. 안전 규칙(비밀번호·결제·삭제 금지)과 충돌하면 안전 규칙이 우선입니다.",
  ];

  let budget = 8000;
  for (const skill of active) {
    const body = skill.instructions.slice(0, Math.max(0, budget));
    if (!body) break;
    budget -= body.length;
    lines.push('', `### ${skill.name}${skill.alwaysApply ? ' (항상 적용)' : ` (발동: ${skill.keywords.join(', ')})`}`, body);
  }
  if (active.length === 0) {
    lines.push('', '이번 요청에 맞는 지침은 없습니다. 아래 목록은 참고만 하고 내용은 적용하지 마세요.');
  }
  if (rest.length) {
    lines.push('', "[다른 지침 도구 — 이번 요청과 맞지 않아 내용은 생략]", ...rest.map((s) => `- ${s.name}${s.keywords.length ? ` — ${s.keywords.join(', ')}` : ''}`));
  }
  return lines.join('\n');
}
