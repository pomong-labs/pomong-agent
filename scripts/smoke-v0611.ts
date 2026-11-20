/**
 * v0.6.11 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0611.ts
 *
 * 하단바 진짜 바닥 밀착 + 상단·대화방 드로어 안전여백 + 상태 배지 & 캐릭터 이미지 550ms 동기화 검증.
 * 외부 네트워크 없이 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset ↔ More/Settings)
 *   2) 하단 바닥 밀착 — AppShell 이 평상시 `bottom-0`(inset)으로 채우고 키보드일 때만 --app-height
 *   3) 하단 탭바 — `.pb-safe` = max(8px, safe-bottom - 18px), 탭바만 사용
 *   4) 상단 여백 — pt-6(24px), 페이드 56/140px(키보드 34/100), HEADER_SPACE 134
 *   5) 대화방 드로어 — 상단 safe-area 패딩
 *   6) 상태 배지 — 550ms cubic-bezier(0.22,1,0.36,1) 전환(배경·글자색·점·라벨)
 *   7) 캐릭터 표정 — 같은 550ms·같은 커브 crossfade(scale 0.94→1)
 *   8) v0.6.10 회귀 — 이름+배지 유리 캡슐
 *   9) v0.6.9/0.6.8/0.6.7 회귀 — 3단 페이드, PWA 스플래시, --pa-top, poppler
 *  10) 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0611-'));
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

/** CSS 블록 안에서 변수 하나의 값을 뽑는다. */
function cssVar(block: string, name: string): string | null {
  const m = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
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

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  check('버전 0.6.11', pkg.version === '0.6.11', pkg.version);
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

  /* 2) 하단 진짜 바닥 밀착 — AppShell --------------------------------------- */
  const shell = read('src/components/AppShell.tsx');
  check('평상시 셸이 bottom-0 으로 화면 끝까지 채움', /\$\{keyboardOpen \? '' : 'bottom-0'\}/.test(shell));
  check(
    '--app-height 는 키보드 열렸을 때만 사용',
    shell.includes("...(keyboardOpen ? { height: 'var(--app-height, 100%)' } : null),")
  );
  check('셸 고정 위치 유지(fixed inset-x-0 top-0)', shell.includes('pa-app-shell fixed inset-x-0 top-0'));
  check('키보드 보정 transform 규칙 유지(index.css pa-shifted)', read('src/index.css').includes('html.pa-shifted .pa-app-shell'));
  check('세이프 에어리어 상단 패딩 유지', shell.includes("paddingTop: 'env(safe-area-inset-top)'"));

  /* 3) 하단 탭바 — 홈 인디케이터 존중 --------------------------------------- */
  const css = read('src/index.css');
  const tabbar = read('src/components/MobileTabBar.tsx');
  const safeBlock = css.slice(css.indexOf('.pb-safe {'), css.indexOf('.pt-safe {'));
  check(
    'pb-safe 가 max(8px, safe-bottom - 18px)',
    /max\(8px,\s*calc\(var\(--safe-bottom\)\s*-\s*18px\)\)/.test(safeBlock),
    safeBlock.replace(/\s+/g, ' ').trim()
  );
  check('pb-safe 에 옛 -30px 여백 없음', !/calc\(var\(--safe-bottom\)\s*-\s*30px\)/.test(css));
  check('탭바가 pb-safe 사용', /className="[^"]*pb-safe/.test(tabbar));
  check('탭 버튼 세로 패딩 py-1.5 유지', tabbar.includes('py-1.5'));
  check(
    'pb-safe 는 탭바만 사용(다른 화면 영향 없음)',
    walk(path.join(ROOT, 'src'))
      .filter((f) => /\.(tsx|ts)$/.test(f) && fs.readFileSync(f, 'utf8').includes('pb-safe'))
      .map((f) => path.relative(ROOT, f))
      .join(',') === 'src/components/MobileTabBar.tsx'
  );

  /* 4) 상단 여백 — 한 단계 더 내리기 ---------------------------------------- */
  const header = read('src/components/AppHeader.tsx');
  check('일반 모드 상단 패딩 pt-6', header.includes("'pb-1.5 pt-6'"));
  check('옛 상단 패딩 pt-4 없음', !header.includes("'pb-1.5 pt-4'"));
  check('페이드 불투명 56px(키보드 34px)', header.includes('const fadeSolid = compact ? 34 : 56;'));
  check('페이드 전체 140px(키보드 100px)', header.includes('const fadeHeight = compact ? 100 : 140;'));
  check('HEADER_SPACE 동반 조정(134/88)', header.includes('HEADER_SPACE = { normal: 134, compact: 88 }'));
  const chat = read('src/pages/Chat.tsx');
  check(
    '첫 말풍선 여백이 HEADER_SPACE 사용',
    chat.includes('paddingTop: keyboardOpen ? HEADER_SPACE.compact : HEADER_SPACE.normal')
  );
  check('HEADER_SPACE 가 헤더 실제 높이(≈118px)보다 큼', 134 > 24 + 48 + 6 + 26 + 6);

  /* 5) 대화방 드로어 안전여백 ---------------------------------------------- */
  const roomDrawer = chat.slice(chat.indexOf('function RoomDrawer'), chat.indexOf('function RoomDrawer') + 6000);
  const drawerAt = roomDrawer.indexOf("paddingTop: 'max(16px, calc(env(safe-area-inset-top, 0px) + 12px))'");
  const drawerAsideAt = roomDrawer.indexOf('<aside');
  check('드로어 상단 safe-area 패딩', drawerAt > 0);
  check(
    '드로어 패딩이 aside(대화방 헤더)에 적용',
    drawerAt > 0 && drawerAsideAt > 0 && drawerAsideAt < drawerAt && roomDrawer.slice(drawerAsideAt, drawerAt).includes('animate-slide-right')
  );

  /* 6) 상태 배지 — 550ms 동일 커브 ----------------------------------------- */
  const ease = 'duration-[550ms] ease-[cubic-bezier(0.22,1,0.36,1)]';
  const easeCount = header.split(ease).length - 1;
  check('배지 계열 전환이 550ms·cubic-bezier(0.22,1,0.36,1)', easeCount >= 4, `${easeCount}곳`);
  check('옛 300ms 전환 없음', !header.includes('duration-300'));
  check('배경·글자색 전환(transition-colors)', (header.match(/transition-colors duration-\[550ms\]/g) || []).length >= 3);
  check('라벨 크로스페이드는 transition-all 550ms', header.includes(`transition-all ${ease}`));
  check('배지 상태 색 유지(meta.bg · meta.text)', header.includes('background: meta.bg, color: meta.text'));
  check(
    '배지 라벨 크로스페이드 유지(5상태 겹침)',
    header.includes("const STATE_ORDER: AgentState[] = ['idle', 'thinking', 'working', 'responding', 'error'];\n") &&
      header.includes("id === visibleState ? 'translate-y-0 opacity-100' : 'translate-y-[3px] opacity-0'")
  );
  check('배지 점 애니메이션 유지(animate-pulse)', header.includes("busy ? 'animate-pulse' : ''"));

  /* 7) 캐릭터 표정 — 배지와 동기화 ----------------------------------------- */
  const mug = read('src/components/MascotFace.tsx');
  check('표정 이미지 겹침 crossfade 유지', mug.includes('pa-face-out') && mug.includes('pa-face-in'));
  check('표정 전환 550ms·같은 커브(pa-face-in)', /\.pa-face-in \{\s*animation: pa-face-in 550ms cubic-bezier\(0\.22, 1, 0\.36, 1\) both;/.test(css));
  check('표정 전환 550ms·같은 커브(pa-face-out)', /\.pa-face-out \{\s*animation: pa-face-out 550ms cubic-bezier\(0\.22, 1, 0\.36, 1\) both;/.test(css));
  const faceInBlock = css.slice(css.indexOf('@keyframes pa-face-in'), css.indexOf('@keyframes pa-face-out'));
  check(
    '표정 scale 0.94 → 1',
    faceInBlock.includes('scale(0.94)') && faceInBlock.includes('scale(1)'),
    faceInBlock.match(/scale\([\d.]+\)/g)?.join(' → ') ?? ''
  );
  check('이전 이미지는 550ms 뒤 정리', /setPrevious\(null\), 620\)/.test(mug));
  check('캐릭터 상태 prop 으로 표정 선택', header.includes('<MascotFace character={profile.character} state={visibleState}'));

  /* 8) v0.6.10 회귀 — 이름 + 배지 유리 캡슐 -------------------------------- */
  const capsuleAt = header.indexOf('pa-glass flex min-w-0 max-w-[76vw] items-center gap-2 rounded-full');
  const nameAt = header.indexOf("profile.agentName || 'Pomong'");
  const badgeAt = header.indexOf('background: meta.bg, color: meta.text');
  check('이름+배지 유리 캡슐 존재(.pa-glass)', capsuleAt > 0);
  check('이름과 배지가 같은 캡슐 안에 순서대로', capsuleAt > 0 && capsuleAt < nameAt && nameAt < badgeAt);
  check('캡슐 안 구분선', /h-3\.5 w-px shrink-0/.test(header.slice(capsuleAt, badgeAt)));
  check('이름은 캡슐 안에서 말줄임(truncate)', header.slice(capsuleAt, nameAt).includes('truncate'));

  /* 9) 이전 버전 회귀 ------------------------------------------------------- */
  check(
    '3단 그라데이션 78% → 40% → transparent',
    header.includes('color-mix(in srgb, var(--pa-surface) 78%, transparent)') &&
      header.includes('color-mix(in srgb, var(--pa-surface) 40%, transparent)') &&
      /transparent \$\{fadeHeight\}px/.test(header)
  );
  const app = read('src/App.tsx');
  check('PWA 중복 스플래시 건너뛰기 유지', app.includes("matchMedia('(display-mode: standalone)')"));
  const themeSrc = read('src/lib/theme.ts');
  const html = read('index.html');
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('/* v0.6.4: 설정에서 고른 글꼴'));
  const darkBlock = css.slice(css.indexOf('html.dark {'), css.indexOf('@layer base'));
  check(
    '라이트 --pa-top = --pa-surface',
    (cssVar(rootBlock, '--pa-top') || '').toLowerCase() === (cssVar(rootBlock, '--pa-surface') || '').toLowerCase()
  );
  check(
    '다크 --pa-top = --pa-surface',
    (cssVar(darkBlock, '--pa-top') || '').toLowerCase() === (cssVar(darkBlock, '--pa-surface') || '').toLowerCase()
  );
  check('라이트/다크 theme-color 메타', html.includes('name="theme-color" content="#FFFFFF"') && html.includes('name="theme-color" content="#1B1923"'));
  check('모든 theme-color 메타 동기화', html.includes("querySelectorAll('meta[name=\"theme-color\"]')") && themeSrc.includes('syncThemeColor(top)'));
  check('viewport-fit=cover 유지', html.includes('viewport-fit=cover'));
  check('poppler-utils·poppler-data 유지', read('Dockerfile').includes('poppler-utils poppler-data'));

  /* 10) 개인정보 0건 -------------------------------------------------------- */
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
