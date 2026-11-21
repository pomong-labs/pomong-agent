/**
 * v0.7.1 스모크 테스트
 *
 *   npx tsx scripts/smoke-v071.ts
 *
 * 1) 버전 0.7.1 일원화(패키지·서버·에셋·SW·도커)
 * 2) 무손실 마이그레이션 — custom_skills(mode·steps_json) / memories(superseded_by·pinned·tags_json)
 * 3) 단계별 워크플로우 — 정규화·검증·변수 치환·도구/AI/알림/할 일 실행·실패 처리·템플릿
 * 4) 하이브리드 기억 — 관련도 순위·최신성·중요도·고정·대체(superseded)·정리
 * 5) 기억 그래프 — 나/분류/기억 노드·엣지·수동 연결
 * 6) 푸시 딥링크 — ?room=&msg=&approval= · 서비스워커·채팅 화면 연결
 * 7) AI 도구 등록 — run_workflow(core) · 시스템 프롬프트 노출
 * 8) 개인정보 비노출 — 공개 저장소 코드·예시·문서에 개인 식별 정보 없음
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v071-'));
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
  const sw = read('public/sw.js');

  /* 1) 버전 --------------------------------------------------------------- */
  console.log('\n[1] 버전');
  check('package.json 0.7.1', pkg.version === '0.7.1', pkg.version);
  check('server/config APP_VERSION', APP_VERSION === pkg.version, APP_VERSION);
  check('에셋 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check('서비스워커 VERSION', sw.includes(`pomong-agent-v${pkg.version}`), 'sw.js');
  check(
    'docker-compose 이미지 태그',
    compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`)
  );

  /* 2) 무손실 마이그레이션 ------------------------------------------------- */
  console.log('\n[2] 무손실 마이그레이션');
  const { db } = await import('../server/db');
  const cols = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
  const skillCols = cols('custom_skills');
  check('custom_skills.mode', skillCols.has('mode'));
  check('custom_skills.steps_json', skillCols.has('steps_json'));
  const memoryCols = cols('memories');
  check('memories.superseded_by', memoryCols.has('superseded_by'));
  check('memories.pinned', memoryCols.has('pinned'));
  check('memories.tags_json', memoryCols.has('tags_json'));
  check('memory_links 테이블', cols('memory_links').has('a_id'));

  const skills = await import('../server/skills');
  const workflows = await import('../server/workflows');
  const memory = await import('../server/memory');
  const tools = await import('../server/tools');
  const toolFilter = await import('../server/tool-filter');
  const push = await import('../server/push');

  // 예전(프롬프트) 도구가 그대로 동작하는지
  const legacy = skills.createSkill({ name: '3줄 보고', keywords: '보고, 요약', instructions: '- 결론부터 쓴다.' });
  check('프롬프트 도구 생성', !('error' in legacy) && legacy.mode === 'prompt' && legacy.steps.length === 0);
  if (!('error' in legacy)) {
    const matched = skills.matchSkills('이거 보고 형식으로 요약해줘');
    check('기존 프롬프트 도구 매칭 유지', matched.some((item) => item.id === legacy.id));
  }

  /* 3) 워크플로우 --------------------------------------------------------- */
  console.log('\n[3] 단계별 워크플로우');
  const normalized = workflows.normalizeWorkflowSteps([
    { kind: 'tool', tool: 'time_now', label: '시각' },
    { kind: 'nope', label: '무시' },
    { kind: 'ai', prompt: '요약: {{input}}' },
    { kind: 'action', action: 'notify', text: '{{input}} 알림' },
  ]);
  check('정규화 — 모르는 종류 제거', normalized.length === 3, `${normalized.length}개`);
  check(
    '정규화 — 기본 라벨·인자',
    normalized[0].tool === 'time_now' && typeof normalized[0].args === 'object' && normalized[2].action === 'notify'
  );
  check('검증 — 빈 단계 거부', 'error' in workflows.validateWorkflowSteps([]));
  check(
    '검증 — 막힌 도구 거부',
    'error' in workflows.validateWorkflowSteps([{ kind: 'tool', tool: 'mail_send', label: '메일', args: {} }])
  );
  check(
    '변수 치환 {{input}}·{{step1}}',
    workflows.substituteVars('{{input}} / {{step1}} / {{없음}}', { input: 'A', step1: 'B' }) === 'A / B / {{없음}}'
  );

  const todoTitle = `스모크 할 일 ${Date.now()}`;
  const run = await workflows.runWorkflowSteps(
    [
      { id: 's1', kind: 'tool', label: '현재 시각', tool: 'time_now' },
      { id: 's2', kind: 'ai', label: '요약', prompt: '다음을 한 줄로: {{input}}\n{{step1}}' },
      { id: 's3', kind: 'action', label: '할 일 등록', action: 'todo', text: todoTitle },
    ],
    { input: '테스트 입력', name: '스모크 워크플로우', generate: async () => '한 줄 요약 결과' }
  );
  check('실행 성공', run.ok && run.steps.length === 3, `${run.steps.map((s) => s.status).join(',')}`);
  check('도구 단계 출력(토큰 없이)', run.steps[0].output.includes('Asia/Seoul'), run.steps[0].output.slice(0, 40));
  check('AI 단계 출력', run.steps[1].output === '한 줄 요약 결과');
  check('할 일 등록 단계', run.steps[2].output.includes('할 일로 등록'), run.steps[2].output.slice(0, 40));
  const savedTask = db.prepare('SELECT title FROM tasks WHERE title = ?').get(todoTitle) as { title: string } | undefined;
  check('할 일이 DB에 실제 등록됨', Boolean(savedTask));
  check('단계별 소요시간 측정', run.steps.every((step) => typeof step.durationMs === 'number'));

  const notifyRun = await workflows.runWorkflowSteps(
    [{ id: 'n1', kind: 'action', label: '알림', action: 'notify', text: '{{input}} 확인' }],
    { input: '점검', notify: false }
  );
  check('알림 단계 — notify:false 면 생략', notifyRun.ok && notifyRun.steps[0].output.includes('생략'));

  const failedRun = await workflows.runWorkflowSteps(
    [
      { id: 'f1', kind: 'tool', label: '없는 도구', tool: 'does_not_exist' },
      { id: 'f2', kind: 'ai', label: '이후', prompt: 'x' },
    ],
    { generate: async () => 'y' }
  );
  check('실패 단계 표시', !failedRun.ok && failedRun.steps[0].status === 'failed');
  check('실패 뒤 단계는 건너뜀', failedRun.steps[1].status === 'skipped');
  check('실행 결과 요약 문자열', workflows.formatWorkflowRun('테스트', failedRun).includes('❌'));

  const wfSkill = skills.createSkill({
    name: '스모크 워크플로우 도구',
    keywords: '스모크, 점검',
    mode: 'workflow',
    steps: [{ kind: 'tool', tool: 'time_now', label: '시각' }],
  });
  check('워크플로우 저장', !('error' in wfSkill) && wfSkill.mode === 'workflow' && wfSkill.steps.length === 1);
  if (!('error' in wfSkill)) {
    const reloaded = skills.getSkill(wfSkill.id);
    check('워크플로우 다시 읽기(단계 보존)', reloaded?.mode === 'workflow' && reloaded.steps[0].tool === 'time_now');
    const toPrompt = skills.updateSkill(wfSkill.id, { mode: 'prompt', instructions: '짧게 답한다.' });
    check('모드 전환 저장', !('error' in toPrompt) && toPrompt.mode === 'prompt');
    const back = skills.updateSkill(wfSkill.id, { mode: 'workflow' });
    check(
      '모드 되돌리기 — 단계 유지',
      !('error' in back) && back.mode === 'workflow' && back.steps.length === 1
    );
    const block = skills.skillPromptBlock('스모크 점검 돌려줘');
    check('시스템 프롬프트에 워크플로우 목록', block.includes('워크플로우') && block.includes('run_workflow'));
    check('워크플로우는 지침 본문으로 주입되지 않음', skills.matchSkills('스모크 점검 돌려줘').every((s) => s.mode !== 'workflow'));
  }

  const tpl = skills.addWorkflowTemplate('brief-then-notify');
  check('워크플로우 템플릿 추가', !('error' in tpl) && tpl.mode === 'workflow' && tpl.steps.length === 3);
  check('템플릿 목록(단계 포함)', skills.workflowTemplatesForClient().every((item) => item.steps.length > 0));
  check('워크플로우 도구 목록에 run_workflow', tools.TOOL_SPECS.some((spec) => spec.name === 'run_workflow'));
  check('카탈로그에 run_workflow', tools.TOOL_CATALOG.some((entry) => entry.name === 'run_workflow'));
  check('core 도구에 run_workflow', toolFilter.CORE_TOOLS.includes('run_workflow'));
  check(
    '도구 필터가 run_workflow 를 남김',
    (() => {
      const picked = toolFilter.selectToolNames({ userRequest: '스모크 점검' });
      return picked.tools === null || picked.tools.includes('run_workflow');
    })()
  );
  const listResult = await tools.runTool('run_workflow', { list: true }, {});
  check('run_workflow 목록 응답', listResult.content.includes('저장된 워크플로우'));
  const runResult = await tools.runTool('run_workflow', { name: '스모크 워크플로우 도구' }, {});
  check('run_workflow 실행 응답', runResult.content.includes('실행 결과') || runResult.content.includes('찾지 못했'));

  /* 4) 하이브리드 기억 ---------------------------------------------------- */
  console.log('\n[4] 하이브리드 기억');
  const coffee = memory.createMemory({ content: '커피는 아메리카노만 마시고 설탕은 넣지 않는다', category: 'taste', importance: 3 });
  memory.createMemory({ content: '주말에는 가끔 등산을 다닌다', category: 'habit', importance: 2 });
  const ruleMemory = memory.createMemory({ content: '배포 전에는 항상 타입체크와 빌드를 확인한다', category: 'rule', importance: 5 });
  const pinned = memory.createMemory({ content: '이번 주 금요일까지 보고서를 마감한다', category: 'promise', importance: 3 });
  memory.setMemoryPinned(pinned.id, true);

  const ranked = memory.rankMemories('커피 취향 알려줘', 4);
  check('관련도 1위가 커피 기억', ranked[0]?.memory.id === coffee.id, ranked[0]?.memory.content);
  check('점수 구성 요소 반환', Boolean(ranked[0] && typeof ranked[0].parts.keyword === 'number'));

  // 최신성 — 같은 주제의 오래된 기억은 새 기억보다 아래로
  const oldOne = memory.createMemory({ content: '커피숍은 집 근처 작은 곳을 자주 간다', category: 'taste', importance: 2 });
  db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 200 * 86_400_000).toISOString(), oldOne.id);
  const recentOne = memory.createMemory({ content: '커피숍은 회사 앞 큰 곳도 자주 간다', category: 'taste', importance: 2 });
  const rankTwo = memory.rankMemories('커피숍 어디 가', 5);
  const oldIndex = rankTwo.findIndex((item) => item.memory.id === oldOne.id);
  const newIndex = rankTwo.findIndex((item) => item.memory.id === recentOne.id);
  check('최신 기억이 오래된 기억보다 위', newIndex >= 0 && (oldIndex < 0 || newIndex < oldIndex), `new ${newIndex} / old ${oldIndex}`);

  const promptBlock = memory.memoryPromptBlock('오늘 날씨 어때');
  check('중요 고정 기억은 항상 프롬프트에', promptBlock.includes('보고서를 마감') && promptBlock.includes('고정'));
  check('중요도 5 기억도 프롬프트에', promptBlock.includes('타입체크'));

  const before = memory.memoryCount();
  const totalBefore = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  const newer = memory.createMemory({ content: '커피는 아메리카노만 마시고 설탕은 절대 넣지 않는다', category: 'taste', importance: 3 });
  const totalAfter = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  const oldRow = db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(coffee.id) as { superseded_by: string | null };
  check('비슷한 새 기억이 옛 기억을 대체', oldRow.superseded_by === newer.id, String(oldRow.superseded_by));
  check('대체된 기억은 목록에서 빠짐', !memory.listMemories('all').some((item) => item.id === coffee.id));
  check('대체된 기억도 includeSuperseded 로 조회', memory.listMemories('all', 200, { includeSuperseded: true }).some((item) => item.id === coffee.id));
  check('기억 행은 지우지 않음(무손실)', totalAfter === totalBefore + 1 && memory.memoryCount() === before, `${totalBefore} → ${totalAfter}`);
  const consolidated = memory.consolidateMemories();
  check('중복 정리 실행', typeof consolidated.superseded === 'number');
  const restored = memory.restoreMemory(coffee.id);
  check('대체 표시 되돌리기', restored.supersededBy === null);

  /* 5) 기억 그래프 -------------------------------------------------------- */
  console.log('\n[5] 기억 그래프');
  const graph = memory.buildMemoryGraph();
  check('나 노드 존재', graph.nodes.some((node) => node.id === 'me' && node.kind === 'me'));
  check('분류 노드 존재', graph.nodes.some((node) => node.kind === 'category'));
  check('기억 노드 존재', graph.nodes.some((node) => node.kind === 'memory'));
  check('나 → 분류 엣지', graph.edges.some((edge) => edge.source === 'me' && edge.kind === 'contains'));
  check('분류 → 기억 엣지', graph.edges.some((edge) => edge.kind === 'contains' && edge.target !== 'me'));
  check('그래프 통계', graph.counts.memories >= 4 && graph.counts.categories >= 3, JSON.stringify(graph.counts));
  const a = memory.createMemory({ content: '그래프 연결 시험 A 항목', category: 'other', importance: 2 });
  const b = memory.createMemory({ content: '그래프 연결 시험 B 항목', category: 'other', importance: 2 });
  check('수동 연결', memory.linkMemories(a.id, b.id));
  check('연결 목록 반영', memory.buildMemoryGraph().edges.some((edge) => edge.kind === 'link'));
  check('연결 해제', memory.unlinkMemories(a.id, b.id));
  const emptyGraph = memory.buildMemoryGraph({ category: 'nothing-here' });
  check('빈 그래프도 안전', emptyGraph.nodes.some((node) => node.id === 'me') && emptyGraph.nodes.filter((n) => n.kind === 'memory').length === 0);

  /* 6) 푸시 딥링크 -------------------------------------------------------- */
  console.log('\n[6] 푸시 딥링크');
  const chatLink = push.chatDeepLink({ session: 'room-1', message: { id: 42 } });
  check('채팅 딥링크 room·msg', chatLink.startsWith('/?') && chatLink.includes('room=room-1') && chatLink.includes('msg=42'), chatLink);
  const approvalLink = push.chatDeepLink({ session: 'room-2', approval: 'ap-9' });
  check('승인 카드 딥링크', approvalLink.includes('approval=ap-9') && approvalLink.includes('room=room-2'), approvalLink);
  check('빈 데이터는 "/"', push.chatDeepLink({}) === '/');
  check('notifyForEvent 가 딥링크 사용', read('server/push.ts').includes('chatDeepLink(data)'));
  check('서비스워커 — 딥링크 메시지', sw.includes('pomong-deeplink') && sw.includes('openWindow'));
  const chatSource = read('src/pages/Chat.tsx');
  check('채팅 화면 — room·msg·approval 쿼리 처리', ['room', 'msg', 'approval'].every((key) => chatSource.includes(`searchParams.get('${key}')`)));
  check('승인 카드 위치 앵커', chatSource.includes('id={`approval-${request.id}`}'));
  check('앱 — 딥링크 메시지 리스너', read('src/App.tsx').includes('pomong-deeplink'));
  check('승인 요청 시 딥링크 알림', read('server/index.ts').includes('approval: card.id'));

  /* 7) 화면·API 라우트 ---------------------------------------------------- */
  console.log('\n[7] 화면·API');
  const serverSource = read('server/index.ts');
  for (const route of [
    "app.post('/api/skills/workflow/test'",
    "app.post('/api/skills/:id/run'",
    "app.get('/api/memory/graph'",
    "app.post('/api/memory/graph/edge'",
    "app.post('/api/memory/consolidate'",
    "app.post('/api/skills/workflow-templates/:id'",
  ]) {
    check(`라우트 ${route.split("'")[1]}`, serverSource.includes(route));
  }
  check('워크플로우 도구 목록 API', read('server/index.ts').includes('workflowTools'));
  const toolsPage = read('src/pages/Tools.tsx');
  check('도구 화면 — 탭 전환', toolsPage.includes('단계별 조립') && toolsPage.includes('글로 쓰기'));
  check('도구 화면 — 테스트 실행', toolsPage.includes('/api/skills/workflow/test'));
  check('도구 화면 — 변수 칩', toolsPage.includes('{{step${i}}}'));
  check('도구 화면 — 실행 버튼', toolsPage.includes('/api/skills/${skill.id}/run'));
  const graphPage = read('src/pages/MemoryGraph.tsx');
  check('그래프 화면 — 필터·검색·상세', graphPage.includes('pa-chip') && graphPage.includes('연결 편집') && graphPage.includes('중요 고정'));
  check('기억함 → 그래프 진입', read('src/pages/Memory.tsx').includes('/memory/graph'));
  check('라우터에 그래프 화면', read('src/App.tsx').includes('memory/graph'));

  /* 8) 2단계 인증 중 로그인 카드 차단 -------------------------------------- */
  console.log('\n[8] 2단계 인증 중 로그인 카드 차단');
  const nowIso = new Date().toISOString();
  const browserSessionId = 'smoke-browser-2fa';
  const insertSession = (patch: Record<string, unknown> = {}) => {
    db.prepare('DELETE FROM browser_sessions WHERE id = ?').run(browserSessionId);
    const row = {
      id: browserSessionId,
      conv_id: 'default',
      status: 'active',
      control_owner: 'agent',
      handover_reason: null,
      control_detail: null,
      lease_expires_at: null,
      url: 'https://example.com/home',
      title: 'Example',
      actions: 1,
      created_at: nowIso,
      last_used_at: nowIso,
      verification: null,
      verification_at: null,
      ...patch,
    } as Record<string, unknown>;
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO browser_sessions(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`
    ).run(...keys.map((key) => row[key]));
  };
  const browserMod = await import('../server/browser');
  insertSession({ control_owner: 'user', handover_reason: 'otp', control_detail: '인증번호를 입력해 주세요', lease_expires_at: new Date(Date.now() + 600_000).toISOString() });
  const leaseState = browserMod.getHandoverState();
  check('제어권 넘김(OTP) → 인증 대기로 판단', leaseState.active && leaseState.kind === 'otp' && leaseState.source === 'lease', JSON.stringify(leaseState));
  check('isAwaitingVerification()', browserMod.isAwaitingVerification());

  const cardsBefore = (db.prepare('SELECT COUNT(*) AS n FROM login_requests').get() as { n: number }).n;
  const blockedCard = await tools.runTool(
    'vault_request_login',
    { service: 'GitHub', login_url: 'https://github.com/login', site_host: 'github.com' },
    { session: 'default' }
  );
  const cardsAfter = (db.prepare('SELECT COUNT(*) AS n FROM login_requests').get() as { n: number }).n;
  check('2FA 중 로그인 카드 생성 차단', cardsAfter === cardsBefore && blockedCard.content.includes('로그인 카드를 띄우지 않았습니다'), blockedCard.content.slice(0, 60));
  check('차단 문구에 vault_request_login 재호출 금지', blockedCard.content.includes('vault_request_login'));
  check('버튼 안내문 포함(화면 돌려주면 자동 진행)', blockedCard.content.includes('자동으로 이어서'));

  insertSession({ url: 'https://github.com/sessions/two-factor', title: 'Two-factor authentication' });
  check('2FA 주소만으로도 인증 대기', browserMod.getHandoverState().source === 'url');

  insertSession({ url: 'https://example.com/home', verification: 'captcha', verification_at: new Date().toISOString() });
  const captchaState = browserMod.getHandoverState();
  check('캡차 화면 기록 → 인증 대기', captchaState.active && captchaState.kind === 'captcha');
  const captchaCard = await tools.runTool('vault_request_login', { service: 'GitHub', login_url: 'https://github.com/login' }, { session: 'default' });
  check('캡차 중에도 카드 차단', captchaCard.content.includes('로그인 카드를 띄우지 않았습니다'));

  insertSession({ url: 'https://example.com/home', verification: 'otp', verification_at: new Date(Date.now() - 40 * 60_000).toISOString() });
  check('오래된 인증 기록은 만료', !browserMod.isAwaitingVerification());

  db.prepare('DELETE FROM browser_sessions WHERE id = ?').run(browserSessionId);
  const normalCard = await tools.runTool('vault_request_login', { service: 'SmokeSite', login_url: 'https://example.com/login' }, { session: 'default' });
  const cardsNormal = (db.prepare('SELECT COUNT(*) AS n FROM login_requests').get() as { n: number }).n;
  check('인증 대기 아닐 때는 카드 정상 생성', cardsNormal === cardsBefore + 1 && normalCard.content.includes('로그인 카드를 띄웠습니다'));
  check('browser_login_with_vault — 카드 재호출 금지 안내', read('server/tools.ts').includes('vault_request_login(로그인 카드)을 다시 띄우지 마세요'));
  check('시스템 프롬프트 — 2FA 중 카드 금지 규칙', read('server/index.ts').includes('vault_request_login(로그인 카드)을 **절대 다시 부르지 마세요**'));

  /* 9) 핸드오버 완료 후 자동 재개 ---------------------------------------- */
  console.log('\n[9] 핸드오버 완료 후 자동 재개');
  const resume = await import('../server/handover-resume');
  const base = { convId: 'default', now: 1_000_000, previousAt: null, busy: false, hasHistory: true };
  check('자동 재개 — 정상', resume.handoverResumeDecision(base).started);
  check('대화방 없음이면 재개 안 함', resume.handoverResumeDecision({ ...base, convId: null }).reason === 'no_conversation');
  check(
    '중복 실행 방지(쿨다운)',
    resume.handoverResumeDecision({ ...base, previousAt: base.now - 5_000, cooldownMs: resume.HANDOVER_RESUME_COOLDOWN_MS }).reason === 'duplicate'
  );
  check('쿨다운 지나면 재개', resume.handoverResumeDecision({ ...base, previousAt: base.now - 60_000 }).started);
  check('턴이 돌고 있으면 재개 안 함', resume.handoverResumeDecision({ ...base, busy: true }).reason === 'busy');
  check('대화 기록 없으면 재개 안 함', resume.handoverResumeDecision({ ...base, hasHistory: false }).reason === 'empty');
  const triggerText = resume.handoverResumeTrigger({ stillVerifying: false, url: 'https://example.com/inbox', title: 'Inbox' });
  check('재개 트리거 문구 — 이어서 진행', triggerText.includes('그 다음 단계부터') && triggerText.includes('https://example.com/inbox'));
  check('재개 트리거 — 로그인 카드 금지', triggerText.includes('vault_request_login'));
  check('아직 인증 중이면 다시 넘기기 안내', resume.handoverResumeTrigger({ stillVerifying: true, label: '2단계 인증(OTP)' }).includes('browser_handover'));
  check('resume 라우트 → 자동 재개 연결', read('server/index.ts').includes('scheduleHandoverFollowUp(result.sessionId, result.convId)'));
  check('자동 재개 턴 트리거', read('server/index.ts').includes("trigger: 'handover_resume'"));
  check('중복 가드 — liveTurns', read('server/index.ts').includes("liveTurns.has"));
  check('화면 버튼 — 이어서 진행 Label', read('src/pages/Browser.tsx').includes('인증 완료 · 이어서 진행'));
  check('화면 — 자동 이어짐 안내', read('src/pages/Browser.tsx').includes('AI가 바로 이어서 진행합니다'));
  check('취소 시 자동 재개 없음', !read('server/index.ts').includes('cancelHandoverFollowUp'));

  /* 10) 작업 중 사용자 말풍선 유지 ---------------------------------------- */
  console.log('\n[10] 작업 중 사용자 말풍선 유지');
  const { mergeMessages } = await import('../src/lib/chat-merge');
  const optimisticMessage = {
    id: -1700000000000,
    role: 'user' as const,
    content: '깃허브 메시지함 확인해줘',
    meta: null,
    createdAt: '2026-11-21T10:00:00.000Z',
  };
  const assistantMessage = {
    id: 501,
    role: 'assistant' as const,
    content: '확인 중이에요',
    meta: null,
    createdAt: '2026-11-21T10:00:05.000Z',
  };
  check('낙관적 말풍선 유지 — 서버 사본 전 폴링', mergeMessages([optimisticMessage], [assistantMessage]).some((m) => m.id === optimisticMessage.id));
  check('빈 동기화 결과에 지우지 않음', mergeMessages([optimisticMessage], []).length === 1);
  const savedUser = { ...optimisticMessage, id: 500 };
  const afterSave = mergeMessages([optimisticMessage], [savedUser, assistantMessage]);
  check('서버 사본 오면 임시 말풍선만 정리(중복 없음)', afterSave.length === 2 && afterSave[0].id === 500 && afterSave[1].id === 501);
  check('id 순서 보존', afterSave.every((m, i) => i === 0 || afterSave[i - 1].id < m.id));

  const chatSource2 = read('src/pages/Chat.tsx');
  check('Chat — 맨 아래 추적 가드(atBottomRef)', chatSource2.includes('atBottomRef') && chatSource2.includes('onScroll={onScroll}'));
  check('Chat — 보낼 때 내 말풍선 고정', chatSource2.includes('atBottomRef.current = true;'));
  const postRoute = serverSource.slice(serverSource.indexOf("app.post('/api/chat/messages'"));
  const insertAt = postRoute.indexOf('INSERT INTO messages(session_id, role, content, meta, created_at, reply_to_id)');
  const loopAt = postRoute.indexOf("runInLane('chat'");
  check('서버 — 루프 전에 사용자 메시지 저장', insertAt > 0 && loopAt > 0 && insertAt < loopAt, `insert ${insertAt} < loop ${loopAt}`);
  const publishAt = postRoute.indexOf("type: 'chat_message'");
  check('서버 — 저장 직후 화면(SSE)에 사용자 말풍선 알림', publishAt > 0 && publishAt < loopAt);

  /* 11) 개인정보 비노출 ---------------------------------------------------- */
  console.log('\n[11] 개인정보 비노출');
  const scanTargets = [
    ...walk(path.join(ROOT, 'server')),
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'public')),
    path.join(ROOT, 'index.html'),
    path.join(ROOT, 'README.md'),
    path.join(ROOT, '.env.example'),
    path.join(ROOT, 'docker-compose.yml'),
    path.join(ROOT, 'Dockerfile'),
  ].filter((file) => fs.existsSync(file) && /\.(?:ts|tsx|js|jsx|json|md|html|css|cjs|yml|yaml|conf|sh|txt|example)$/.test(file));
  /**
   * 실제 개인정보 원문은 검사기에도 남기지 않는다(공개 저장소).
   * 대신 '개인정보 형태'를 잡는다 — 실제 값이 들어오면 형식이 걸린다.
   */
  const DUMMY_PHONE = /010[\s-]?1234[\s-]?5678/g;
  const patterns: { label: string; re: RegExp }[] = [
    { label: '휴대전화 번호', re: /\b01[016789][\s-]?\d{3,4}[\s-]?\d{4}\b/g },
    { label: '도로명 주소', re: /[가-힣]{2,8}(?:시|군|구)\s+[가-힣]{2,8}(?:로|길)\s*\d{1,4}/g },
    { label: '개인 메일 주소', re: /[\w.+-]+@(?:naver|gmail|kakao)\.com/gi },
  ];
  const ALLOWED_MAIL = /^(?:you|user|example|test|sample|me|hong|pomong\.labs|push)@/i;
  const leaks: string[] = [];
  for (const file of scanTargets) {
    let text = fs.readFileSync(file, 'utf8');
    // 예시용 더미 번호는 개인정보가 아니다(검사에 다시 걸리지 않는 형태로 바꾼다).
    text = text.replace(DUMMY_PHONE, '010-XXXX-XXXX');
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      for (const match of text.matchAll(pattern.re)) {
        const value = match[0];
        if (pattern.label === '개인 메일 주소' && ALLOWED_MAIL.test(value)) continue;
        leaks.push(`${path.relative(ROOT, file)} · ${pattern.label}`);
      }
    }
  }
  check('공개 파일에 개인정보 형태 없음', leaks.length === 0, [...new Set(leaks)].slice(0, 5).join(' / '));
  check(
    '날씨 예시는 중립 지명',
    read('server/tools.ts').includes('"부산", "서울", "대전"')
  );

  console.log(`\n${failures === 0 ? '✅ 모든 검사 통과' : `❌ 실패 ${failures}건`}`);
  db.close();
  if (failures > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error('스모크 실행 실패:', err);
  process.exitCode = 1;
});
