/**
 * v0.6.14 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0614.ts
 *
 * 하단 플로팅 알약 **뒤·아래 사각 배경 띠 제거** 핫픽스 검증.
 * 외부 네트워크 없이 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset ↔ More/Settings)
 *   2) 탭바 래퍼 — 완전 투명(bg-transparent + CSS `.pa-tabbar` 무배경/무경계/무그림자)
 *   3) 알약 — blur(backdrop-filter) 없음, 알약에 바짝 붙는 그림자, 유리 테두리·색은 유지
 *   4) 레이아웃 회귀 — `pa-glass`·rounded-full·max-w-[460px]·px-3·pb-safe·shrink-0·키보드 숨김
 *   5) 본문 배경 연속 — 하단 영역에 배경/그라데이션을 칠하는 요소가 탭바·셸에 없음
 *   6) 회귀 — PWA 메타·poppler, 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0614-'));
process.env.DATA_DIR = tmp;
process.env.BROWSER_ENABLED = '0';
process.env.MONITOR_ENABLED = '0';
process.env.HOST_LOG_DIR = path.join(tmp, 'hostlog');
process.env.DOCKER_SOCKET = path.join(tmp, 'no-docker.sock');

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

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

/** CSS 규칙 하나의 본문을 꺼낸다(같은 선택자가 여러 번 나오면 마지막 것) */
function rule(css: string, selector: string): string {
  // 선택자는 줄 머리에서 시작해야 한다 — `html.dark .pa-glass` 같은 하위 규칙과 섞이지 않게.
  const re = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'g');
  let body = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const start = m.index + m[0].length;
    body = css.slice(start, css.indexOf('}', start));
  }
  return body;
}

async function main(): Promise<void> {
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  check('버전 0.6.14 이상', /^0\.6\.(1[4-9]|[2-9]\d)$/.test(pkg.version), pkg.version);
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
  check('옛 0.6.13 표기 없음(화면·설정)', !read('src/pages/More.tsx').includes("useState('0.6.13')") && !read('src/pages/Settings.tsx').includes("|| '0.6.13'"));

  /* 2) 탭바 래퍼 — 완전 투명 ------------------------------------------------ */
  const css = read('src/index.css');
  const tabbar = read('src/components/MobileTabBar.tsx');
  const tabbarMarkup = strip(tabbar.slice(tabbar.indexOf('return (')));
  const navTag = (tabbarMarkup.match(/<nav[^>]*>/) || [''])[0];
  check('nav 래퍼에 bg-transparent', navTag.includes('bg-transparent'), navTag.trim());
  check('nav 래퍼에 배경 유틸리티 없음(bg-white 등)', !/\bbg-(white|\[|pomong)/.test(navTag), navTag.trim());
  check('nav 래퍼에 경계·그림자 없음(border/shadow)', !/\b(border-t|border-b|border-x|shadow)\b/.test(navTag));
  const navRule = rule(css, '.pa-tabbar');
  check('.pa-tabbar 규칙 = 완전 투명', /background:\s*transparent/.test(navRule), navRule.replace(/\s+/g, ' ').trim());
  check('.pa-tabbar 규칙 = 무경계', /border:\s*0/.test(navRule));
  check('.pa-tabbar 규칙 = 무그림자', /box-shadow:\s*none/.test(navRule));
  check('.pa-tabbar 규칙 = backdrop-filter 없음', /backdrop-filter:\s*none/.test(navRule));

  /* 3) 알약 — blur 제거 + 알약에 붙는 그림자 -------------------------------- */
  const pillLight = rule(css, '.pa-tabbar-pill');
  const pillDark = rule(css, 'html.dark .pa-tabbar-pill');
  check('알약 backdrop-filter 없음(사각 레이어 제거)', /backdrop-filter:\s*none/.test(pillLight) && /-webkit-backdrop-filter:\s*none/.test(pillLight));
  check('알약 그림자 유지(떠 있는 느낌)', /box-shadow:/.test(pillLight));
  const blurOf = (body: string) => {
    const m = body.match(/box-shadow:\s*0\s+(\d+)px\s+(\d+)px\s+(-?\d+)px/);
    return m ? { y: Number(m[1]), blur: Number(m[2]), spread: Number(m[3]) } : null;
  };
  const lightShadow = blurOf(pillLight);
  const darkShadow = blurOf(pillDark);
  check('라이트 그림자가 바짝 붙음(blur 16px 이하)', !!lightShadow && lightShadow.blur <= 16, JSON.stringify(lightShadow));
  check('다크 그림자가 바짝 붙음(blur 16px 이하)', !!darkShadow && darkShadow.blur <= 16, JSON.stringify(darkShadow));
  check(
    '그림자가 알약 좌우 여백(12px)을 넘지 않음(spread ≤ -4px)',
    !!lightShadow && !!darkShadow && lightShadow.spread <= -4 && darkShadow.spread <= -4
  );
  check('옛 넓은 그림자(blur 30~32px) 알약에 없음', !/0\s+1[02]px\s+3[02]px/.test(strip(pillLight) + strip(pillDark)));
  check('알약은 여전히 pa-glass(유리 테두리·색)', tabbarMarkup.includes('pa-glass'));
  check('알약 유리 규칙에 blur 외 색·테두리 유지', /background:\s*color-mix/.test(rule(css, '.pa-glass')) && /border:\s*1px solid/.test(rule(css, '.pa-glass')));

  /* 4) 레이아웃 회귀 -------------------------------------------------------- */
  check('알약 rounded-full 캡슐', tabbarMarkup.includes('rounded-full'));
  check('알약 최대 폭 max-w-[460px]', tabbarMarkup.includes('max-w-[460px]'));
  check('좌우 여백 px-3', /className="pa-tabbar[^"]*px-3/.test(tabbar));
  check('pb-safe 유지(홈 인디케이터 위 16px)', /className="pa-tabbar[^"]*pb-safe/.test(tabbar));
  const safeBlock = css.slice(css.indexOf('.pb-safe {'), css.indexOf('.pt-safe {'));
  check('pb-safe = max(8px, safe-bottom - 18px)', /max\(8px,\s*calc\(var\(--safe-bottom\)\s*-\s*18px\)\)/.test(safeBlock));
  check('셸 flex 흐름 유지(shrink-0 → 본문이 가려지지 않음)', /className="pa-tabbar[^"]*shrink-0/.test(tabbar));
  check('탭 5개 유지', (tabbar.match(/icon: /g) || []).length === 5);
  check('키보드 열리면 탭바 숨김(html.kb-open .pa-tabbar)', /html\.kb-open \.pa-tabbar\s*\{\s*display:\s*none/.test(css));
  check('전체화면(immersive)에서 탭바 숨김 유지', read('src/components/AppShell.tsx').includes('immersive ? null : <MobileTabBar />'));

  /* 5) 본문 배경 연속 ------------------------------------------------------- */
  const shell = read('src/components/AppShell.tsx');
  check('main 배경 = --pa-surface 단색', /background:\s*'var\(--pa-surface\)'/.test(shell));
  check('셸에 하단 그라데이션·경계 없음', !/linear-gradient|border-b/.test(strip(shell)));
  check(
    '탭바 밖 하단 배경을 칠하는 클래스 없음(bg-white/bg-[#…] 없음)',
    !/\bbg-(white|\[#)/.test(navTag) && !tabbarMarkup.includes('bg-white')
  );

  /* 6) 회귀 ----------------------------------------------------------------- */
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
