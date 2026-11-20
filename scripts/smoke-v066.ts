/**
 * v0.6.6 스모크 테스트
 *
 *   npx tsx scripts/smoke-v066.ts
 *
 * 외부 네트워크 없이 확인할 수 있는 것만 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset)
 *   2) 기본 도구 ON/OFF — 그룹 펼치기·정규화·실제 도구 목록에서 제외
 *   3) 나만의 지침 도구 — 생성·수정·삭제·키워드 매칭·토큰 절약 주입
 *   4) 예시 템플릿 4종 원클릭 추가(중복 방지) · 개인정보 0건
 *   5) 화면 회귀 방지 — 상단바 슬림화, 상태바 색 통일, 설정 고정 헤더, 도구 관리자 진입
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v066-'));
process.env.DATA_DIR = tmp;
process.env.BROWSER_ENABLED = '0';
process.env.MONITOR_ENABLED = '0';
process.env.HOST_LOG_DIR = path.join(tmp, 'hostlog');
process.env.DOCKER_SOCKET = path.join(tmp, 'no-docker.sock');

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'server-dist') continue;
    if (entry.name === 'data' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');
  const toolFilter = await import('../server/tool-filter');
  const skills = await import('../server/skills');
  const { TOOL_SPECS } = await import('../server/tools');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check(
    'docker-compose 이미지 태그',
    compose.includes(`pomong-agent:${pkg.version}`) && compose.includes(`pomong-agent-browser:${pkg.version}`)
  );
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check('에셋 캐시 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);

  /* 2) 기본 도구 ON/OFF --------------------------------------------------- */
  const normalized = toolFilter.normalizeToolPrefs({
    disabledGroups: ['browser', 'mail', 'nope', 7],
    disabledTools: ['browser_open', 'not_a_tool'],
  });
  check('모르는 그룹은 버린다', normalized.disabledGroups.join(',') === 'browser,mail', normalized.disabledGroups.join(','));
  check('모르는 도구는 버린다', normalized.disabledTools.join(',') === 'browser_open', normalized.disabledTools.join(','));
  check('빈 설정도 안전', toolFilter.normalizeToolPrefs(null).disabledGroups.length === 0);

  const off = toolFilter.disabledToolNames({ disabledGroups: ['mail'], disabledTools: ['browser_open'] });
  check('그룹을 끄면 그룹 도구 전부 꺼짐', off.has('mail_send') && off.has('mail_list'));
  check('개별 도구도 함께 꺼짐', off.has('browser_open'));
  check('안 끈 도구는 남는다', !off.has('weather_get'));

  const allKeep = toolFilter.filterToolsByPrefs(TOOL_SPECS, toolFilter.DEFAULT_TOOL_PREFS);
  check('설정이 없으면 도구 그대로', allKeep.length === TOOL_SPECS.length);
  const filtered = toolFilter.filterToolsByPrefs(TOOL_SPECS, { disabledGroups: ['mail'], disabledTools: ['browser_open'] });
  check('메일 도구가 모델 목록에서 빠진다', !filtered.some((t) => t.name.startsWith('mail_')));
  check('개별로 끈 도구도 빠진다', !filtered.some((t) => t.name === 'browser_open'));
  check('나머지 도구는 유지', filtered.some((t) => t.name === 'browser_click'));
  check('그룹 메타 10종', toolFilter.TOOL_GROUP_META.length === 10);
  check(
    '그룹 메타가 모든 도구를 담는다',
    toolFilter.TOOL_GROUP_META.every((g) => Array.isArray(toolFilter.TOOL_GROUPS[g.id]) && toolFilter.TOOL_GROUPS[g.id].length > 0)
  );

  /* 3) 나만의 지침 도구 --------------------------------------------------- */
  const { db } = await import('../server/db');
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_skills'").get() as
    | { name: string }
    | undefined;
  check('custom_skills 테이블 생성', table?.name === 'custom_skills');

  check('처음엔 지침 도구가 없다', skills.listSkills().length === 0);
  check('이름이 없으면 거절', 'error' in skills.createSkill({ name: '  ', instructions: '내용' }));
  check('지침이 없으면 거절', 'error' in skills.createSkill({ name: '이름', instructions: '' }));

  const created = skills.createSkill({
    name: '3줄 보고',
    keywords: '요약, 정리, 보고',
    instructions: '- 결론 한 줄\n- 근거 2개\n- 다음 할 일',
  });
  if ('error' in created) throw new Error(created.error);
  check('지침 도구 생성', created.name === '3줄 보고' && created.enabled);
  check('키워드 쉼표 분리', created.keywords.join(',') === '요약,정리,보고', created.keywords.join(','));
  check('목록에 들어간다', skills.listSkills().length === 1);

  const keywordMatch = skills.matchSkills('회의 내용 좀 정리해줘');
  check('키워드가 맞으면 발동', keywordMatch.some((s) => s.id === created.id));
  const noMatch = skills.matchSkills('오늘 날씨 어때');
  check('키워드가 안 맞으면 발동하지 않는다', !noMatch.some((s) => s.id === created.id));

  const matchedBlock = skills.skillPromptBlock('회의 내용 정리해줘');
  check('맞은 지침은 본문이 들어간다', matchedBlock.includes('3줄 보고') && matchedBlock.includes('결론 한 줄'));
  check('지침 블록 머리말', matchedBlock.includes('[사용자 지침 도구]'));
  const otherBlock = skills.skillPromptBlock('오늘 날씨 어때');
  check('안 맞는 지침은 본문을 넣지 않는다(토큰 절약)', !otherBlock.includes('결론 한 줄'));
  check('안 맞는 지침은 제목·키워드 한 줄만', otherBlock.includes('- 3줄 보고 — 요약, 정리, 보고'));
  check('발동 지침이 없으면 안내 문구', otherBlock.includes('이번 요청에 맞는 지침은 없습니다'));

  const always = skills.createSkill({
    name: '항상 말끝에 날짜',
    keywords: '',
    instructions: '답변 마지막에 오늘 날짜를 적습니다.',
    alwaysApply: true,
  });
  if ('error' in always) throw new Error(always.error);
  check('항상 적용은 어떤 요청에도 들어간다', skills.skillPromptBlock('아무 말').includes('오늘 날짜를 적습니다'));

  const updated = skills.updateSkill(created.id, { enabled: false });
  check('활성 토글만 바꿔도 지침은 남는다', !('error' in (updated as object)) && (updated as { instructions: string }).instructions.includes('결론 한 줄'));
  check('꺼진 지침은 발동하지 않는다', !skills.matchSkills('정리해줘').some((s) => s.id === created.id));
  check('꺼진 지침은 목록에서 빠진다', !skills.skillPromptBlock('정리해줘').includes('3줄 보고'));
  const reEnabled = skills.updateSkill(created.id, { enabled: true });
  check('다시 켜면 발동', !('error' in (reEnabled as object)) && skills.matchSkills('정리해줘').some((s) => s.id === created.id));

  check('없는 지침 수정은 null', skills.updateSkill('missing-id', { name: 'x' }) === null);
  check('지침 삭제', skills.deleteSkill(always.id) && skills.listSkills().length === 1);
  check('없는 지침 삭제는 false', skills.deleteSkill('missing-id') === false);

  /* 4) 예시 템플릿 --------------------------------------------------------- */
  check('템플릿 4종', skills.SKILL_TEMPLATES.length === 4, String(skills.SKILL_TEMPLATES.length));
  check(
    '템플릿 키워드가 모두 있다',
    skills.SKILL_TEMPLATES.every((t) => t.keywords.length > 0 && t.instructions.length > 30)
  );
  const templateIds = skills.SKILL_TEMPLATES.map((t) => t.id);
  check('3줄 보고 템플릿', templateIds.includes('three-line-report'));
  check('문의 응대 템플릿', templateIds.includes('inquiry-reply'));
  check('가격 비교 템플릿', templateIds.includes('price-compare'));

  const added = skills.addTemplate('three-line-report');
  check('템플릿 원클릭 추가', !('error' in (added as object)) && skills.listSkills().some((s) => s.name === '3줄 핵심 보고'));
  const again = skills.addTemplate('three-line-report');
  check('같은 템플릿은 중복 추가하지 않는다', 'existing' in (again as object));
  check('템플릿이 키워드와 함께 저장된다', skills.listSkills().find((s) => s.name === '3줄 핵심 보고')?.keywords.includes('요약') === true);
  check('없는 템플릿은 오류', 'error' in (skills.addTemplate('nope') as object));

  /* 5) 서버 배선 ----------------------------------------------------------- */
  const serverIndex = read('server/index.ts');
  check('채팅에 지침 주입', serverIndex.includes('skills.skillPromptBlock(input.prompt)'));
  check('예약 실행에도 지침 주입', serverIndex.includes('skills.skillPromptBlock(job.prompt)'));
  check('시스템 프롬프트가 지침 블록을 받는다', serverIndex.includes("function systemPrompt(memoryBlock = '', skillBlock = '')"));
  check('턴마다 꺼진 도구 제외', serverIndex.includes('filterToolsByPrefs(') && serverIndex.includes('readToolPrefs()'));
  check('도구 설정 API', serverIndex.includes("app.post('/api/tools/prefs'"));
  check('지침 API', serverIndex.includes("app.get('/api/skills'") && serverIndex.includes("app.post('/api/skills'"));
  check('템플릿 API', serverIndex.includes("app.post('/api/skills/templates/:id'"));
  check('도구 관리자용 그룹 목록', serverIndex.includes('groups, prefs, disabledCount'));

  /* 6) 화면 — 상단바 슬림화 ----------------------------------------------- */
  const header = read('src/components/AppHeader.tsx');
  const chat = read('src/pages/Chat.tsx');
  check('캐릭터 아바타 48px(축소)', header.includes('const avatar = compact ? 34 : 48'));
  check('아이콘–이름 간격 축소', header.includes('mt-1.5 text-[15px]') && !header.includes('mt-2.5 text-[17px]'));
  check('이름–배지 간격 축소', header.includes("mt-1 text-[15px]") === false || header.includes('mt-1 gap-1.5 px-2.5'));
  check('헤더 높이 상수를 공유', header.includes('export const HEADER_SPACE') && chat.includes('HEADER_SPACE.normal'));
  check('페이드가 이름·배지까지 불투명', header.includes('const fadeSolid = compact ? 70 : 112'));
  // v0.6.7: 페이드 시작색이 상태바가 아니라 본문 표면색(--pa-surface)이 되었다(두 값은 같다).
  check('페이드 시작색이 본문 표면색', header.includes('linear-gradient(to bottom, var(--pa-surface) 0px'));

  /* 7) 화면 — 상태바 색 통일 ---------------------------------------------- */
  const theme = read('src/lib/theme.ts');
  const css = read('src/index.css');
  const shell = read('src/components/AppShell.tsx');
  const html = read('index.html');
  check('--pa-top 계산 함수', theme.includes('export function topSurfaceColor') && theme.includes("'--pa-top': topSurfaceColor(accent, 'light')"));
  check('theme-color를 --pa-top으로', theme.includes("meta.setAttribute('content', top)"));
  check('html/body 배경이 --pa-top', css.includes('background: var(--pa-top)') && (css.match(/--pa-top/g) || []).length >= 2);
  check('첫 페인트 스크립트도 --pa-top', html.includes("s.vars['--pa-top']"));
  // v0.6.7: 정적 메타 하나 → 라이트/다크 media 메타 2개.
  check(
    '라이트·다크 theme-color 메타',
    html.includes('media="(prefers-color-scheme: light)"') && html.includes('media="(prefers-color-scheme: dark)"')
  );
  // v0.6.7: 세이프 에어리어 아래 그라데이션을 없애고 본문 배경 단일 색으로 통일했다.
  check(
    '세이프 에어리어 띠를 같은 색으로',
    shell.includes("background: 'var(--pa-surface)'") && !shell.includes('env(safe-area-inset-top, 0px) + 60px')
  );

  /* 8) 화면 — 설정 카테고리 고정 헤더 -------------------------------------- */
  const settings = read('src/pages/Settings.tsx');
  check('sticky 제거', !settings.includes('sticky top-0 z-20'));
  check('스크롤 밖 고정 헤더', settings.includes('className="flex h-full min-h-0 flex-col"') && settings.includes('shrink-0 px-4 pb-0.5 pt-5'));
  check('콘텐츠만 스크롤', settings.includes('pa-scroll mt-3 min-h-0 flex-1 overflow-y-auto'));

  /* 9) 화면 — 도구 관리자 -------------------------------------------------- */
  const toolsPage = read('src/pages/Tools.tsx');
  const more = read('src/pages/More.tsx');
  const app = read('src/App.tsx');
  check('더보기 메뉴 이름', more.includes('도구(스킬) 관리') && more.includes("to: '/tools'"));
  check('라우트 연결', app.includes("path=\"tools\"") && app.includes('import Tools from'));
  check('그룹 스위치', toolsPage.includes('role="switch"') && toolsPage.includes('toggleGroup'));
  check('도구별 스위치', toolsPage.includes('toggleTool('));
  check('새 도구 만들기', toolsPage.includes('새 도구 만들기') && toolsPage.includes("api.post('/api/skills'"));
  check('키워드·항상 적용·지침 입력', toolsPage.includes('발동 조건') && toolsPage.includes('항상 적용') && toolsPage.includes('지침 내용'));
  check('수정·삭제', toolsPage.includes('api.put(`/api/skills/${') && toolsPage.includes('api.del(`/api/skills/${skill.id}`'));
  check('템플릿 추가 버튼', toolsPage.includes('api.post<{ existing: boolean }>(`/api/skills/templates/'));

  /* 10) 개인정보 0건 ------------------------------------------------------- */
  const patterns: [string, RegExp][] = [
    ['이름', /김현준|현준/],
    ['네이버 아이디', /hyunjun|kimhj050326/i],
    ['깃허브 핸들', /khjkr/i],
    ['전화번호', /4343-?5216/],
    ['거주지 예시', /익산시 평동로/],
  ];
  const targets = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'server')))
    .concat(walk(path.join(ROOT, 'scripts')))
    .concat(walk(path.join(ROOT, 'tools')))
    .concat(walk(path.join(ROOT, 'public')))
    .concat([path.join(ROOT, 'index.html'), path.join(ROOT, 'README.md'), path.join(ROOT, 'SECURITY.md')])
    .filter((file) => /\.(ts|tsx|js|jsx|css|html|md|json|sh|py)$/.test(file));
  for (const [label, re] of patterns) {
    const hits: string[] = [];
    for (const file of targets) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('scripts/smoke-')) continue; // 검사 패턴 자체는 제외
      if (rel.startsWith('public/sw.js')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (re.test(text)) hits.push(rel);
    }
    check(`개인정보(${label}) 0건`, hits.length === 0, hits.join(', '));
  }

  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
