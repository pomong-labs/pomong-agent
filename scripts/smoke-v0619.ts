/**
 * v0.6.19 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0619.ts
 *
 * 1) 버전 0.6.19 일원화(패키지·서버·에셋·SW·도커·화면 표기)
 * 2) 커스텀 지침 매칭 — 제목 일치(대소문자·공백 무시) · 키워드 없는 지침 기본 적용 · 지침 언급 요청
 * 3) 지침 블록 — 차단 문구 제거 · read_skill 안내 · 본문 예산 · 남은 지침은 제목만
 * 4) read_skill 도구 — 이름·일부 이름·id·전체 읽기·없는 이름 안내 · 꺼진 지침 표시
 * 5) 도구 필터 — read_skill은 core · 지침 본문의 의도까지 반영
 * 6) 서버 연결 — 채팅·예약 실행 모두 매 턴 DB 조회 + 지침 본문을 도구 필터에 전달
 * 7) 화면 — 도구 관리 문구·저장 피드백
 * 8) 개인정보 비노출
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0619-'));
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
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');
  const compose = read('docker-compose.yml');

  /* 1) 버전 --------------------------------------------------------------- */
  // v0.7.0: 버전 검사는 '0.6.19 이상'인지만 본다(최신 릴리스에서도 회귀 확인용으로 계속 돈다).
  check('버전 0.6.19 이상', Number(pkg.version.split('.')[0]) > 0 || Number(pkg.version.split('.')[1] || 0) > 6 || (Number(pkg.version.split('.')[1] || 0) === 6 && Number(pkg.version.split('.')[2] || 0) >= 19), pkg.version);
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('에셋 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check(
    'docker-compose 이미지 태그',
    compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`)
  );
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check(
    'More·Settings 표시 버전',
    read('src/pages/More.tsx').includes(`useState('${pkg.version}')`) &&
      read('src/pages/Settings.tsx').includes(`|| '${pkg.version}'`)
  );

  /* 2) 매칭 --------------------------------------------------------------- */
  const sk = await import('../server/skills');
  const skill = (over: Partial<sk.CustomSkill>): sk.CustomSkill => ({
    id: over.id ?? 'id-' + (over.name ?? 'x'),
    name: over.name ?? '이름',
    keywords: over.keywords ?? [],
    instructions: over.instructions ?? '본문',
    alwaysApply: over.alwaysApply ?? false,
    enabled: over.enabled ?? true,
    createdAt: '',
    updatedAt: '',
  });

  const core = skill({ id: 'core', name: '3줄 핵심 보고', keywords: ['요약', '보고'], instructions: '결론→근거→할 일' });
  const meet = skill({ id: 'meet', name: '회의록 정리', keywords: ['회의록'], instructions: '결정/논의/할 일' });
  const noKeyword = skill({ id: 'nokey', name: '기본 응대', keywords: [], instructions: '인사는 짧게' });
  const off = skill({ id: 'off', name: '꺼진 지침', keywords: ['요약'], enabled: false });
  const always = skill({ id: 'always', name: '항상 지침', alwaysApply: true });
  const bag = [core, meet, noKeyword, off, always];

  check('키워드 일치', sk.matchSkills('오늘 회의록 정리해줘', bag).some((s) => s.id === 'meet'));
  check('제목 그대로 일치', sk.matchSkills('3줄 핵심 보고로 알려줘', bag).some((s) => s.id === 'core'));
  check(
    '제목 공백·대소문자 무시',
    sk.matchSkills('3줄핵심보고 로 정리', bag).some((s) => s.id === 'core')
  );
  check('제목 낱말 절반 겹침', sk.matchSkills('핵심 보고 형식으로 써줘', bag).some((s) => s.id === 'core'));
  check('키워드 띄어쓰기 무시', sk.matchSkills('요약정리 부탁해', bag).some((s) => s.id === 'core'));
  check('어미 차이(회의록 ↔ 회의)', sk.matchSkills('회의 정리 좀 해줘', bag).some((s) => s.id === 'meet'));
  check('키워드 없는 지침은 기본 적용', sk.matchSkills('심심하다', bag).some((s) => s.id === 'nokey'));
  check('꺼진 지침은 적용 안 됨', !sk.matchSkills('요약해줘', bag).some((s) => s.id === 'off'));
  check('항상 적용', sk.matchSkills('아무 말', bag).some((s) => s.id === 'always'));
  const explicit = sk.matchSkills('방금 만든 지침 적용해서 답해줘', bag);
  check(
    '지침 언급 요청 → 활성 지침 전부',
    [core, meet, noKeyword, always].every((s) => explicit.some((m) => m.id === s.id)) && !explicit.some((s) => s.id === 'off'),
    explicit.map((s) => s.name).join(', ')
  );
  check('지침 언급 감지', sk.mentionsSkillTools('방금 추가한 스킬 써봐') && sk.mentionsSkillTools('내 지침대로 해줘'));
  check('일반 대화는 언급 아님', !sk.mentionsSkillTools('오늘 날씨 알려줘'));

  /* 3) 지침 블록 ----------------------------------------------------------- */
  const block = sk.skillPromptBlock('오늘 회의록 정리해줘', bag);
  check('적용 지침 본문 포함', block.includes('결정/논의/할 일') && block.includes('### 회의록 정리'));
  check('남은 지침은 제목만', block.includes('- 3줄 핵심 보고') && !block.includes('결론→근거→할 일'));
  check('read_skill 안내', block.includes('read_skill'));
  check('차단 문구 제거', !block.includes('적용하지 마세요'));
  const emptyBlock = sk.skillPromptBlock('그냥 잡담', [core]);
  check(
    '맞는 지침 없을 때도 read_skill로 읽기 안내',
    emptyBlock.includes('read_skill') && emptyBlock.includes('- 3줄 핵심 보고'),
    emptyBlock.split('\n').slice(0, 3).join(' / ')
  );
  check('지침이 없으면 블록 없음', sk.skillPromptBlock('아무 말', []) === '');
  const longSkill = skill({ id: 'long', name: '긴 지침', alwaysApply: true, instructions: 'x'.repeat(12000) });
  check('본문 예산 8000자', sk.skillPromptBlock('아무 말', [longSkill]).length < 9000);

  /* 4) read_skill 도구 ----------------------------------------------------- */
  const db = await import('../server/db');
  check(
    'custom_skills 테이블',
    Boolean(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_skills'").get())
  );
  const created = sk.createSkill({ name: '테스트 지침', keywords: '테스트', instructions: '1. 테스트 본문입니다.' });
  const made = 'error' in created ? null : created;
  check('지침 추가', Boolean(made), 'error' in created ? created.error : made?.name);
  const byName = sk.readSkillForTool('테스트 지침');
  check('이름으로 읽기', byName.content.includes('1. 테스트 본문입니다.'), byName.content.split('\n')[0]);
  check('일부 이름으로 읽기', sk.readSkillForTool('테스트').content.includes('1. 테스트 본문입니다.'));
  check('id로 읽기', made ? sk.readSkillForTool(made.id).content.includes('1. 테스트 본문입니다.') : false);
  check('전체 읽기', sk.readSkillForTool('', true).content.includes('테스트 지침'));
  const missing = sk.readSkillForTool('없는이름');
  check('없는 이름은 목록 안내', missing.content.includes('찾지 못했습니다') && missing.content.includes('테스트 지침'));
  if (made) sk.updateSkill(made.id, { enabled: false });
  check('꺼진 지침은 꺼짐 표시', sk.readSkillForTool('테스트 지침').content.includes('꺼져 있습니다'));
  if (made) sk.deleteSkill(made.id);
  check('지침 삭제', sk.listSkills().every((s) => s.id !== made?.id));

  const tools = await import('../server/tools');
  check('TOOL_SPECS에 read_skill', tools.TOOL_SPECS.some((t) => t.name === 'read_skill'));
  const added = sk.createSkill({ name: '도구 호출 확인', keywords: '', instructions: '도구로 읽은 본문' });
  const addedSkill = 'error' in added ? null : added;
  const toolOut = await tools.runTool('read_skill', { name: '도구 호출 확인' });
  check('도구 실행 결과', toolOut.content.includes('도구로 읽은 본문'), toolOut.content.split('\n')[0]);
  check('도구 라벨', tools.TOOL_LABELS.read_skill === '지침 읽기');
  if (addedSkill) sk.deleteSkill(addedSkill.id);

  /* 5) 도구 필터 ----------------------------------------------------------- */
  const filter = await import('../server/tool-filter');
  check('read_skill은 core', filter.CORE_TOOLS.includes('read_skill') && filter.TOOL_GROUPS.core.includes('read_skill'));
  const onlyRequest = filter.selectToolNames({ userRequest: '안녕' });
  check('짧은 인사는 전체 허용', onlyRequest.tools === null && onlyRequest.reason === 'all');
  const planOnly = filter.selectToolNames({ userRequest: '오늘 일정 정리해줘' });
  check('일정 요청만으로는 택배 도구 없음', !(planOnly.tools ?? []).includes('track_parcel'));
  const withSkill = filter.selectToolNames({
    userRequest: '오늘 일정 정리해줘',
    skillText: '운송장 번호는 track_parcel 도구로 배송 상태를 조회하고, 환율은 get_market_quote로 확인한다.',
  });
  check(
    '지침이 요구하는 도구 그룹 포함',
    Boolean(withSkill.tools?.includes('track_parcel') && withSkill.tools?.includes('get_market_quote')),
    (withSkill.tools ?? []).length + '개'
  );
  check('지침이 있어도 원래 요청 도구 유지', (withSkill.tools ?? []).includes('tasks_add'));
  const browserSkill = filter.selectToolNames({ userRequest: '그거 해줘', skillText: '브라우저로 사이트에 로그인해서 확인한다.' });
  check('지침의 브라우저 요구 반영', Boolean(browserSkill.tools?.includes('browser_open')));

  /* 6) 서버 연결 ----------------------------------------------------------- */
  const index = read('server/index.ts');
  check('채팅 턴마다 DB 조회', index.includes('skills.listSkills()') && index.includes('skills.matchSkills(input.prompt'));
  check('채팅 지침 본문을 필터에 전달', index.includes('skillText: activeSkills.map((s) => s.instructions).join'));
  check('채팅 프롬프트에 활성 지침 전달', index.includes('skills.skillPromptBlock(input.prompt, turnSkills, activeSkills)'));
  check('예약 실행도 동일', index.includes('const jobActiveSkills = skills.matchSkills(job.prompt, jobSkills)'));
  check('예약 프롬프트 연결', index.includes('skills.skillPromptBlock(job.prompt, jobSkills, jobActiveSkills)'));
  check(
    '지침 저장 API',
    index.includes("app.post('/api/skills'") && index.includes("app.put('/api/skills/:id'") && index.includes("app.delete('/api/skills/:id'")
  );

  /* 7) 화면 --------------------------------------------------------------- */
  const toolsPage = read('src/pages/Tools.tsx');
  check('키워드 없음 기본 적용 표기', toolsPage.includes('키워드 없음 · 기본 적용') && !toolsPage.includes('발동하지 않아요'));
  check('저장 피드백에 즉시 반영 안내', toolsPage.includes('다음 대화부터 바로 반영돼요'));
  check('토글 후 목록 갱신', toolsPage.includes('res.skill') && toolsPage.includes('지침 도구를 켰어요'));
  check('대화 중 읽기 안내', toolsPage.includes('그 지침 읽어서 적용해'));

  /* 8) 개인정보 비노출 ----------------------------------------------------- */
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
    .filter((file) => /\.(ts|tsx|js|jsx|css|html|md|json|sh|py|txt)$/.test(file));
  for (const [label, re] of patterns) {
    const hits: string[] = [];
    for (const file of targets) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('scripts/smoke-')) continue;
      if (rel.startsWith('public/sw.js')) continue;
      if (re.test(fs.readFileSync(file, 'utf8'))) hits.push(rel);
    }
    check(`개인정보(${label}) 0건`, hits.length === 0, hits.join(', '));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
