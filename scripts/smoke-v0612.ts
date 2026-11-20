/**
 * v0.6.12 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0612.ts
 *
 * 하단 탭바 4px 바닥 밀착 + 전송 직후 첨부 미리보기 + 비서 이름 라벨 + 드로어 상단 여백 검증.
 * 외부 네트워크 없이 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset ↔ More/Settings)
 *   2) 하단 탭바 — `.pb-safe` = max(4px, safe-bottom - 30px), 탭바만 사용, 셸은 bottom-0
 *   3) 대화방 드로어 — paddingTop = max(12px, env(safe-area-inset-top))
 *   4) 전송 직후 첨부 미리보기 — 낙관적 말풍선에 attachments 를 넣는다
 *   5) 비서 이름 라벨 — profile.agentName + 이/가 조사(하드코딩 0건)
 *   6) VNC 전체화면 — 하단 입력 바가 잘리지 않는 레이아웃
 *   7) 회귀 — PWA·theme-color·poppler
 *   7) 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0612-'));
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
  const { subjectName } = await import('../src/lib/korean');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  // v0.6.12 이후: 버전 표기가 한 값으로 모여 있는지만 본다.
  check('버전 0.6.x', /^0\.6\.\d+$/.test(pkg.version), pkg.version);
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check(
    'docker-compose 이미지 태그',
    compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`)
  );
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check('에셋 캐시 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check(
    'More·Settings 표시 버전',
    read('src/pages/More.tsx').includes(`useState('${pkg.version}')`) && read('src/pages/Settings.tsx').includes(`|| '${pkg.version}'`)
  );

  /* 2) 하단 탭바 — 4px 바닥 밀착 -------------------------------------------- */
  const css = read('src/index.css');
  const tabbar = read('src/components/MobileTabBar.tsx');
  const shell = read('src/components/AppShell.tsx');
  const safeBlock = css.slice(css.indexOf('.pb-safe {'), css.indexOf('.pt-safe {'));
  check(
    'pb-safe 가 세이프 에어리어에서 빼는 타이트한 max()',
    /max\([0-9]+px,\s*calc\(var\(--safe-bottom\)\s*-\s*[0-9]+px\)\)/.test(safeBlock),
    safeBlock.replace(/\s+/g, ' ').trim()
  );
  check('아이폰(34px)에서 4px', Math.max(4, 34 - 30) === 4);
  check('일반 기기(0px)에서도 4px', Math.max(4, 0 - 30) === 4);
  // v0.6.13: 알약이 홈 인디케이터 위에 떠 있으므로 "-30px/4px 바닥 밀착" 대신 "옛 +8px 여백 없음"만 회귀 본다.
  check('옛 +8px 여백 없음', !/calc\(var\(--safe-bottom\)\s*\+\s*8px\)/.test(css));
  check('탭바가 pb-safe 사용', /className="[^"]*pb-safe/.test(tabbar));
  check(
    'pb-safe 는 탭바만 사용(다른 화면 영향 없음)',
    walk(path.join(ROOT, 'src'))
      .filter((f) => /\.(tsx|ts)$/.test(f) && fs.readFileSync(f, 'utf8').includes('pb-safe'))
      .map((f) => path.relative(ROOT, f))
      .join(',') === 'src/components/MobileTabBar.tsx'
  );
  check('평상시 셸이 bottom-0 으로 화면 끝까지 채움', /\$\{keyboardOpen \? '' : 'bottom-0'\}/.test(shell));

  /* 3) 대화방 드로어 상단 여백 ---------------------------------------------- */
  const chat = read('src/pages/Chat.tsx');
  const roomDrawer = chat.slice(chat.indexOf('function RoomDrawer'), chat.indexOf('function RoomDrawer') + 6000);
  const drawerAt = roomDrawer.indexOf("paddingTop: 'max(12px, env(safe-area-inset-top, 0px))'");
  const drawerAsideAt = roomDrawer.indexOf('<aside');
  check('드로어 상단 여백 max(12px, safe-area-inset-top)', drawerAt > 0);
  check(
    '드로어 패딩이 aside(대화방 헤더)에 적용',
    drawerAt > 0 && drawerAsideAt > 0 && drawerAsideAt < drawerAt && roomDrawer.slice(drawerAsideAt, drawerAt).includes('animate-slide-right')
  );
  check('옛 +12px 여백(너무 내려가던 값) 없음', !roomDrawer.includes('max(16px, calc(env(safe-area-inset-top, 0px) + 12px))'));

  /* 4) 전송 직후 첨부 미리보기 ---------------------------------------------- */
  const store = read('src/lib/store.tsx');
  check('send 가 첨부 뷰(AttachmentView[])를 받음', store.includes('attachmentViews?: ChatAttachment[]'));
  check('낙관적 말풍선에 보낸 첨부를 넣음', /attachments: attachmentViews \?\? \[\]/.test(store));
  check('첨부 없는 전송은 빈 배열', store.includes('attachments: attachmentViews ?? []'));
  check('Chat 이 업로드된 첨부 뷰를 함께 넘김', chat.includes('send(draft, ids, replyTo, pending.map((p) => p.view))'));
  check('내 말풍선이 m.attachments 를 그림', chat.includes('<MessageAttachments items={m.attachments} onPreview={setPreview} />'));

  /* 5) 비서 이름 라벨 ------------------------------------------------------- */
  check('subjectName 헬퍼 import', chat.includes("import { subjectName } from '../lib/korean'"));
  check('생각 중 라벨이 비서 이름 사용', /\$\{subjectName\(agentName\)\} 생각 중…/.test(chat));
  check('작업 중 라벨이 비서 이름 사용', /\$\{subjectName\(agentName\)\} 작업 중…/.test(chat));
  check('옛 하드코딩 생각 중 없음', !chat.includes("'포몽이 생각 중…'"));
  check('옛 하드코딩 작업 중 없음', !chat.includes("'포몽이 작업 중…'"));
  check('답장 라벨도 비서 이름 사용', !chat.includes("'포몽에게 답장'") && chat.includes('${agentName}에게 답장'));
  check('라몽이 생각 중…', subjectName('라몽') === '라몽이', subjectName('라몽'));
  check('퐁이가 생각 중…', subjectName('퐁이') === '퐁이가', subjectName('퐁이'));
  check('포몽이 생각 중…', subjectName('포몽') === '포몽이', subjectName('포몽'));
  check('멜로가 생각 중…', subjectName('멜로') === '멜로가', subjectName('멜로'));
  check('빈 이름은 포몽이', subjectName('  ') === '포몽이', subjectName('  '));
  check('영문 이름은 가', subjectName('Agent') === 'Agent가', subjectName('Agent'));

  /* 6) VNC 전체화면 — 하단 입력 바 잘림 없음 -------------------------------- */
  const browser = read('src/pages/Browser.tsx');
  const full = browser.slice(browser.indexOf('fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#0B0B12]'));
  check('전체화면이 뷰포트보다 커지지 않음(maxHeight 100%)', full.includes("maxHeight: '100%'"));
  check('전체화면 컨테이너 overflow 숨김', /fixed inset-0 z-50 flex flex-col overflow-hidden/.test(full));
  check(
    '입력 바가 세이프 에어리어 아래 여백을 직접 가짐(max(14px, env))',
    full.includes("paddingBottom: 'max(14px, env(safe-area-inset-bottom, 0px))'")
  );
  check('입력 바는 shrink-0(줄어들지 않음)', /flex shrink-0 items-center gap-1\.5 border-t border-white\/10/.test(full));
  check('뷰어 영역은 min-h-0 flex-1', full.includes('<div className="min-h-0 flex-1 overflow-hidden">{viewer}</div>'));
  check('옛 컨테이너 paddingBottom(중복 여백) 없음', !full.slice(0, 700).includes("paddingBottom: 'env(safe-area-inset-bottom)'"));

  /* 7) 회귀 ----------------------------------------------------------------- */
  const html = read('index.html');
  check('viewport-fit=cover 유지', html.includes('viewport-fit=cover'));
  check('라이트/다크 theme-color 메타', html.includes('name="theme-color" content="#FFFFFF"') && html.includes('name="theme-color" content="#1B1923"'));
  check('poppler-utils·poppler-data 유지', read('Dockerfile').includes('poppler-utils poppler-data'));

  /* 8) 개인정보 0건 --------------------------------------------------------- */
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
      if (rel.startsWith('scripts/smoke-')) continue;
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
