/**
 * v0.6.13 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0613.ts
 *
 * 플로팅 글래스 알약 하단바 + 계정 비밀번호 변경 + PWA 캐시 초기화 검증.
 * 외부 네트워크 없이 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset ↔ More/Settings)
 *   2) 하단바 — 전체 폭 도킹형 바 제거, 중앙 플로팅 유리 알약(`pa-glass` + rounded-full)
 *   3) 여백 — `.pb-safe` = max(8px, safe-bottom - 18px), 셸 flex 흐름 유지, 키보드 숨김
 *   4) 비밀번호 변경 API — requireAuth · verifyPassword · 8자 검사 · hashPassword · users UPDATE
 *   5) 비밀번호 변경 UI — 설정 「백업·시스템」 카드 3입력 + 피드백
 *   6) PWA 캐시 초기화 UI — caches.keys() 삭제 + 서비스워커 해제 + 새로고침
 *   7) 회귀 — PWA·theme-color·poppler, 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0613-'));
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
  const { hashPassword, verifyPassword } = await import('../server/crypto');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  check('버전 0.6.13', pkg.version === '0.6.13', pkg.version);
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
  check('옛 0.6.12 표기 없음', !read('src/pages/More.tsx').includes("useState('0.6.12')"));

  /* 2) 플로팅 유리 알약 하단바 --------------------------------------------- */
  const css = read('src/index.css');
  const tabbar = read('src/components/MobileTabBar.tsx');
  const shell = read('src/components/AppShell.tsx');
  check('탭바가 pa-tabbar(키보드 숨김 대응) 유지', tabbar.includes('pa-tabbar'));
  check('알약이 pa-glass(상단바 버튼과 같은 유리)', tabbar.includes('pa-glass'));
  check('알약이 rounded-full 캡슐', tabbar.includes('rounded-full'));
  check('알약이 가운데 정렬(mx-auto)', /mx-auto[^"]*max-w-\[460px\]/.test(tabbar) || tabbar.includes('mx-auto'));
  check('알약 최대 폭 max-w-[460px]', tabbar.includes('max-w-[460px]'));
  check('좌우 여백 px-3', /className="pa-tabbar[^"]*px-3/.test(tabbar));
  check('도킹형 border-t 제거', !tabbar.replace(/\/\*[\s\S]*?\*\//g, '').includes('border-t'));
  check('도킹형 bg-white 제거', !tabbar.replace(/\/\*[\s\S]*?\*\//g, '').includes('bg-white'));
  check('탭 5개 유지', (tabbar.match(/icon: /g) || []).length === 5);
  check('탭 라벨 순서(채팅·관제실·자동화·금고·더보기)', /t\.nav\.chat[\s\S]*t\.nav\.monitor[\s\S]*t\.nav\.automation[\s\S]*t\.nav\.vault[\s\S]*t\.nav\.more/.test(tabbar));
  check('활성 탭 알약 클래스', tabbar.includes('pa-tab-item-active'));
  check('활성 탭 색 = 포인트 컬러 알약(.pa-tab-item-active)', /\.pa-tab-item-active\s*\{[^}]*background:\s*var\(--accent-soft\)/.test(css));
  check('비활성 탭 색 = 보조 글자색', /\.pa-tab-item\s*\{[^}]*color:\s*var\(--pa-mute\)/.test(css));
  check('알약 그림자 클래스', /\.pa-tabbar-pill\s*\{[^}]*box-shadow/.test(css));
  check('다크 모드 알약 그림자', css.includes('html.dark .pa-tabbar-pill'));
  check('과한 흰 광택 없음', !/pa-tabbar-pill[^}]*linear-gradient\([^)]*white/.test(css));

  /* 3) 여백 · 레이아웃 ------------------------------------------------------ */
  const safeBlock = css.slice(css.indexOf('.pb-safe {'), css.indexOf('.pt-safe {'));
  check(
    'pb-safe = max(8px, safe-bottom - 18px)',
    /max\(8px,\s*calc\(var\(--safe-bottom\)\s*-\s*18px\)\)/.test(safeBlock),
    safeBlock.replace(/\s+/g, ' ').trim()
  );
  check('아이폰(34px)에서 16px', Math.max(8, 34 - 18) === 16);
  check('세이프 에어리어 없는 기기에서 8px', Math.max(8, 0 - 18) === 8);
  check('탭바가 pb-safe 사용', /className="[^"]*pb-safe/.test(tabbar));
  check(
    'pb-safe 는 탭바만 사용(다른 화면 영향 없음)',
    walk(path.join(ROOT, 'src'))
      .filter((f) => /\.(tsx|ts)$/.test(f) && fs.readFileSync(f, 'utf8').includes('pb-safe'))
      .map((f) => path.relative(ROOT, f))
      .join(',') === 'src/components/MobileTabBar.tsx'
  );
  check('셸 flex 흐름 유지(shrink-0 → 본문이 가려지지 않음)', /className="pa-tabbar[^"]*shrink-0/.test(tabbar));
  check('키보드 열리면 탭바 숨김(html.kb-open .pa-tabbar)', /html\.kb-open \.pa-tabbar\s*\{\s*display:\s*none/.test(css));
  check('전체화면(immersive)에서 탭바 숨김 유지', shell.includes('immersive ? null : <MobileTabBar />'));

  /* 4) 비밀번호 변경 API ---------------------------------------------------- */
  const server = read('server/index.ts');
  const pwRoute = server.slice(server.indexOf("app.post('/api/auth/change-password'"));
  const routeBody = pwRoute.slice(0, pwRoute.indexOf('\n});'));
  check('POST /api/auth/change-password 존재', server.includes("app.post('/api/auth/change-password', requireAuth"));
  check('현재 비밀번호 검증(verifyPassword)', routeBody.includes('verifyPassword('));
  check('현재 비밀번호 불일치 400', routeBody.includes('invalid_current_password'));
  check('새 비밀번호 8자 검사', /newPassword[\s\S]*length < 8/.test(routeBody) && routeBody.includes('weak_password'));
  check('같은 비밀번호 거부', routeBody.includes('same_password'));
  check('해시로 users 업데이트(hashPassword)', routeBody.includes('hashPassword(') && /UPDATE users SET password_hash = \?/.test(routeBody));
  check('지금 세션은 유지(강제 로그아웃 없음)', !routeBody.includes('clearCookie'));
  // 해시 왕복 — 실제 저장·검증 경로가 맞는지
  const stored = hashPassword('pomong-test-0813');
  check('hashPassword → verifyPassword 왕복', verifyPassword('pomong-test-0813', stored));
  check('틀린 비밀번호는 거부', !verifyPassword('pomong-test-0814', stored));

  /* 5) 비밀번호 변경 UI ----------------------------------------------------- */
  const settings = read('src/pages/Settings.tsx');
  check('Settings 에 changePassword 핸들러', settings.includes('const changePassword = async () =>'));
  check('UI 가 /api/auth/change-password 호출', settings.includes("api.post('/api/auth/change-password', { currentPassword: pwForm.current, newPassword: pwForm.next })"));
  check('현재·새·확인 3입력', ['pwForm.current', 'pwForm.next', 'pwForm.confirm'].every((k) => settings.includes(k)));
  check('autoComplete current-password', settings.includes('autoComplete="current-password"'));
  check('8자 미만 클라이언트 검사', /pwForm\.next\.length < 8/.test(settings));
  check('확인 불일치 검사', settings.includes('pwForm.next !== pwForm.confirm'));
  check('저장 피드백(pwMsg)', settings.includes('pwMsg') && settings.includes('비밀번호를 바꿨어요'));
  const systemTab = settings.slice(settings.indexOf("{tab === 'system' ? ("));
  check('「백업·시스템」 탭 안에 비밀번호 카드', systemTab.includes('계정 비밀번호 변경'));
  check('「백업·시스템」 탭 안에 캐시 카드', systemTab.includes('앱 캐시 초기화'));

  /* 6) PWA 캐시 초기화 UI --------------------------------------------------- */
  check('Settings 에 resetAppCache 핸들러', settings.includes('const resetAppCache = async () =>'));
  check('Cache Storage 전체 삭제(caches.keys)', settings.includes('window.caches.keys()') && settings.includes('window.caches.delete(key)'));
  check('서비스워커 등록 해제', settings.includes('navigator.serviceWorker.getRegistrations()') && settings.includes('reg.unregister()'));
  check('마지막에 새로고침', settings.includes('window.location.reload()'));
  check('버튼 이름 「앱 캐시 초기화 및 새로고침」', settings.includes('앱 캐시 초기화 및 새로고침'));
  check('서비스워커 재등록 경로 유지(main.tsx)', read('src/main.tsx').includes("navigator.serviceWorker.register('/sw.js')"));

  /* 7) 회귀 ----------------------------------------------------------------- */
  const html = read('index.html');
  check('viewport-fit=cover 유지', html.includes('viewport-fit=cover'));
  check('라이트/다크 theme-color 메타', html.includes('name="theme-color" content="#FFFFFF"') && html.includes('name="theme-color" content="#1B1923"'));
  check('poppler-utils·poppler-data 유지', read('Dockerfile').includes('poppler-utils poppler-data'));

  /* 개인정보 0건 */
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
      if (re.test(fs.readFileSync(file, 'utf8'))) hits.push(rel);
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
