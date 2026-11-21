/**
 * v0.6.4 스모크 테스트
 *
 *   npx tsx scripts/smoke-v064.ts
 *
 * 외부 네트워크 없이 확인할 수 있는 것만 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose)
 *   2) 대화방별 메시지·작업 카드 병합(깜빡임·중복 방지) — src/lib/chat-merge.ts
 *   3) 작업 카드 activeRun (방을 오갈 때 진행 중 카드 복원용)
 *   4) 개인정보 하드코딩 0건 (공개 저장소 배포 조건)
 *   5) 글꼴 선택(기본·프리텐다드·카카오 큰글씨)과 실제 폰트 파일/링크
 *   6) UI 회귀 방지 — VNC 비율 늘림 제거, 탭바 숨김, 업로드 버튼, 설정 탭, CTA 대비
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v064-'));
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
  const { mergeMessages, mergeTaskRuns } = await import('../src/lib/chat-merge');
  const font = await import('../src/lib/font');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('docker-compose 이미지 태그', compose.includes(`pomong-agent:${pkg.version}`) && compose.includes(`pomong-agent-browser:${pkg.version}`));

  /* 2) 메시지 병합 -------------------------------------------------------- */
  type Msg = Parameters<typeof mergeMessages>[0][number];
  const mk = (id: number, role: 'user' | 'assistant', content: string): Msg =>
    ({ id, role, content, meta: null, createdAt: '2026-11-20T00:00:00.000Z' }) as Msg;

  const optimistic = mk(-1, 'user', '안녕');
  const savedUser = mk(10, 'user', '안녕');
  const reply = mk(11, 'assistant', '네, 안녕하세요!');

  const mergedSaved = mergeMessages([optimistic], [savedUser]);
  check('낙관적 말풍선이 저장본으로 대체된다', mergedSaved.length === 1 && mergedSaved[0].id === 10);

  const withReply = mergeMessages(mergedSaved, [savedUser, reply]);
  check('답변이 내 말풍선 뒤에 붙는다', withReply.map((m) => m.id).join(',') === '10,11');

  const again = mergeMessages(withReply, [savedUser, reply]);
  check('같은 응답을 다시 합쳐도 그대로(깜빡임 없음)', again === withReply);

  const outOfOrder = mergeMessages([mk(11, 'assistant', 'a'), mk(10, 'user', 'u')], [mk(12, 'assistant', 'b')]);
  check('들어온 순서와 무관하게 id 순으로 정렬', outOfOrder.map((m) => m.id).join(',') === '10,11,12');

  const stillPending = mergeMessages([optimistic], [mk(99, 'assistant', '다른 답')]);
  check('아직 저장되지 않은 낙관적 말풍선은 남는다', stillPending.some((m) => m.id === -1));

  /* 3) 작업 카드 병합 ----------------------------------------------------- */
  type Run = Parameters<typeof mergeTaskRuns>[0][number];
  const runBase = (patch: Partial<Run>): Run =>
    ({
      id: 'run-1',
      sessionId: 'default',
      messageId: null,
      title: '작업하는 중',
      status: 'running',
      steps: 1,
      startedAt: '2026-11-20T00:00:00.000Z',
      endedAt: null,
      items: [],
      ...patch,
    }) as Run;

  const running = runBase({ items: [{ id: 'a' }] as Run['items'] });
  const older = runBase({ title: '작업하는 중' });
  const runMerged = mergeTaskRuns([older], [running]);
  check('작업 카드는 진행률이 찬 것을 남긴다', runMerged[0].items.length === 1);
  const finished = runBase({ status: 'done', endedAt: '2026-11-20T00:01:00.000Z', steps: 2 });
  check('끝난 카드가 오면 완료 상태로 바뀐다', mergeTaskRuns(runMerged, [finished])[0].status === 'done');

  /* 3-b) 진행 중 작업 조회(방 이동 복원) ---------------------------------- */
  const { db } = await import('../server/db');
  const taskRuns = await import('../server/task-runs');
  check('진행 중 작업이 없으면 null', taskRuns.activeRun('default') === null);
  db.prepare("INSERT INTO chat_sessions(id, title, created_at, updated_at) VALUES('s1','방',?,?)").run(
    '2026-11-20T00:00:00.000Z',
    '2026-11-20T00:00:00.000Z'
  );
  const created = taskRuns.createRun('s1', '작업하는 중');
  check('진행 중 작업을 찾아낸다', taskRuns.activeRun('s1')?.id === created.id);
  taskRuns.finishRun(created.id, 'done');
  check('끝난 작업은 activeRun 에서 빠진다', taskRuns.activeRun('s1') === null);
  check('다른 방의 진행 상태와 섞이지 않는다', taskRuns.activeRun('s2') === null);

  /* 4) 개인정보 하드코딩 0건 ---------------------------------------------- */
  // 개인 식별 문자열은 공개 저장소에 두지 않는다(오픈소스 배포 조건).
  // 그래서 저장소에서는 개인정보의 '형태'를 검사하고, 유지보수자는 저장소 밖 패턴 파일을
  // 지정해 실명·계정까지 함께 검사한다.
  //   PII_PATTERNS_FILE=/절대/경로/pii-patterns.json   → [["라벨", "정규식"], ...]
  const allow = /(?:you@naver\.com|pomong\.labs@gmail\.com|010-1234-5678|test-user@example\.com|홍길동)/;
  const localFile = process.env.PII_PATTERNS_FILE;
  const localPatterns: [string, RegExp][] =
    localFile && fs.existsSync(localFile)
      ? (JSON.parse(fs.readFileSync(localFile, 'utf8')) as [string, string][]).map(
          ([label, src]) => [label, new RegExp(src)] as [string, RegExp]
        )
      : [];
  const patterns: [string, RegExp][] = [
    ['개인 메일 계정', /[A-Za-z0-9._%+-]+@(?:gmail|naver|daum|hanmail|nate|kakao)\.[A-Za-z.]{2,}/],
    ['전화번호', /\b0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}\b/],
    ['주민등록번호', /\b\d{6}[-.\s]?[1-4]\d{6}\b/],
    ['생년월일', /\b(?:199|200)\d[-./]?(?:0[1-9]|1[0-2])[-./]?(?:0[1-9]|[12]\d|3[01])\b/],
    ...localPatterns,
  ];
  // 문서·데모용으로 일부러 둔 더미 값만 허용한다.
  const piiHit = (re: RegExp, body: string): boolean =>
    (body.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).some(
      (m) => !allow.test(m)
    );
  const targets = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'server')))
    .concat(walk(path.join(ROOT, 'scripts')))
    .concat(walk(path.join(ROOT, 'tools')))
    .concat([path.join(ROOT, 'index.html'), path.join(ROOT, 'README.md'), path.join(ROOT, 'SECURITY.md')])
    .filter((file) => /\.(ts|tsx|js|jsx|css|html|md|json|sh|py)$/.test(file));
  for (const [label, re] of patterns) {
    const hits: string[] = [];
    for (const file of targets) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('scripts/smoke-')) continue; // 스모크 테스트의 검사 패턴 자체는 제외
      const text = fs.readFileSync(file, 'utf8');
      if (piiHit(re, text)) hits.push(rel);
    }
    check(`개인정보(${label}) 0건`, hits.length === 0, hits.join(', '));
  }

  /* 5) 글꼴 선택 ---------------------------------------------------------- */
  check('글꼴 선택지 3종', font.FONT_OPTIONS.length === 3);
  check(
    '글꼴 id 매핑',
    font.FONT_OPTIONS.map((f) => f.id).join(',') === 'default,pretendard,kakaobigsans'
  );
  check('알 수 없는 값은 기본 글꼴', font.normalizeFont('comic', 'default') === 'default');
  check('프리텐다드 보존', font.normalizeFont('pretendard', 'default') === 'pretendard');
  check('카카오 큰글씨 보존', font.normalizeFont('kakaobigsans', 'default') === 'kakaobigsans');
  for (const file of ['Regular', 'Bold', 'ExtraBold']) {
    const rel = `public/fonts/kakao-bigsans/KakaoBigSans-${file}.woff2`;
    const full = path.join(ROOT, rel);
    const ok = fs.existsSync(full) && fs.readFileSync(full).subarray(0, 4).toString('ascii') === 'wOF2';
    check(`카카오 큰글씨 ${file} woff2 포함`, ok, rel);
  }
  const css = read('src/index.css');
  check('카카오 큰글씨 @font-face', css.includes("font-family: 'Kakao Big Sans'") && css.includes('/fonts/kakao-bigsans/'));
  const html = read('index.html');
  check(
    '프리텐다드 CDN 연결',
    html.includes('cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css')
  );
  check('첫 페인트 글꼴 적용 스크립트', html.includes("localStorage.getItem('pomong.font')"));
  check('글꼴 클래스 규칙', css.includes('html.font-pretendard') && css.includes('html.font-kakaobigsans'));

  /* 6) UI 회귀 방지 ------------------------------------------------------- */
  const browser = read('src/pages/Browser.tsx');
  const viewer = read('src/components/NoVncViewer.tsx');
  const shell = read('src/components/AppShell.tsx');
  const chat = read('src/pages/Chat.tsx');
  const settings = read('src/pages/Settings.tsx');
  const modelBar = read('src/components/ModelBar.tsx');

  check('VNC 늘림(object-fit: fill) 제거', !css.includes('object-fit: fill') && !css.includes('pa-vnc-stretch'));
  check('원본 비율 유지(contain) 규칙', css.includes("object-fit: contain"));
  check('뷰어 모드 fit/actual', viewer.includes("mode?: 'fit' | 'actual'") && browser.includes("useState<'fit' | 'actual'>('fit')"));
  check('전체화면에서 하단 탭바 숨김', shell.includes('immersive ? null : <MobileTabBar />'));
  check('브라우저가 몰입 모드를 켠다', browser.includes('setImmersive(viewerFull)'));
  check('인증 완료 CTA 글자색 고정', browser.includes("color: '#1F1D2B'") && !browser.includes('text-[#2F2A4A]'));
  check('CTA 아래 여백 확보', browser.includes("'pb-44'"));

  check('채팅 파일 첨부 버튼 노출', /title="사진·파일 첨부"/.test(chat) && !chat.includes('파일 첨부 (준비 중)'));
  check('파일 다중 선택 input', chat.includes('ref={fileRef}') && chat.includes('multiple') && chat.includes('accept="image/*'));
  check('첨부 미리보기·삭제', chat.includes('removePending(p.id)') && chat.includes('올리는 중…'));
  check('드래그&드롭·붙여넣기', chat.includes('onDrop=') && chat.includes('onPaste='));

  check('모델 바 한 줄 고정', modelBar.includes('flex-nowrap') && modelBar.includes('overflow-x-auto') && !modelBar.includes('flex-wrap'));
  check('모델 바 ... 접기/펼치기', modelBar.includes('MoreHorizontal') && modelBar.includes('ChevronLeft'));

  check('설정 카테고리 탭 4종', ['look', 'ai', 'mail', 'system'].every((t) => settings.includes(`tab === '${t}'`)));
  check('설정 탭 라벨', ['캐릭터·테마', 'AI·자동선택', '이메일·알림', '백업·시스템'].every((l) => settings.includes(l)));
  check('AI 카드 1줄 접기(수정)', settings.includes("'수정'") && settings.includes('openProvider'));

  const store = read('src/lib/store.tsx');
  check('대화방별 메시지 보관', store.includes('messagesBySession') && store.includes('runtimeBySession'));
  check('대화방별 진행 상태', store.includes('patchRuntime') && store.includes('isSending'));
  check('진행 상태 복원 엔드포인트 사용', store.includes('/active'));
  const index = read('server/index.ts');
  check('서버 active 엔드포인트', index.includes("'/api/chat/sessions/:id/active'"));
  check('서버 방별 턴 시작 시각', index.includes('liveTurnStartedAt'));

  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
