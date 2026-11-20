/**
 * v0.6.9 스모크 테스트
 *
 *   npx tsx scripts/smoke-v069.ts
 *
 * 하단 탭바를 바닥까지 더 내리기 + 상단 페이드 투명화 핫픽스 검증. 외부 네트워크 없이 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset)
 *   2) 하단 탭바 — `.pb-safe` 가 max(6px, safe-bottom - 24px) 이고 탭바만 쓴다 / pt-1
 *   3) 상단 페이드 — 불투명 40px·전체 124px(키보드 30·96), 78% → 40% → 투명 3단 그라데이션,
 *      이름 text-shadow·배지 그림자로 가독성 유지
 *   4) v0.6.8 회귀 — standalone 스플래시 건너뛰기 유지
 *   5) v0.6.7 회귀 — `--pa-top` = `--pa-surface`, 라이트/다크 theme-color 메타, poppler 유지
 *   6) 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v069-'));
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
  // v0.6.10 이후로 버전 접미사가 올라간다. 이 스모크는 "버전 표기가 한 값으로 모여 있는지"만 본다.
  check('버전 0.6.x', /^0\.6\.\d+$/.test(pkg.version), pkg.version);
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('docker-compose 이미지 태그', compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`));
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check('에셋 캐시 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check('More·Settings 표시 버전', read('src/pages/More.tsx').includes(`useState('${pkg.version}')`) && read('src/pages/Settings.tsx').includes(`|| '${pkg.version}'`));

  /* 2) 하단 탭바 — 바닥까지 더 내리기 -------------------------------------- */
  const css = read('src/index.css');
  const tabbar = read('src/components/MobileTabBar.tsx');
  const safeBlock = css.slice(css.indexOf('.pb-safe {'), css.indexOf('.pt-safe {'));
  // v0.6.10: -24px → -30px 로 한 번 더 조였다. 이 스모크는 "세이프 에어리어를 빼는 타이트한 max()" 형태만 본다.
  check(
    'pb-safe 가 max(2~6px, safe-bottom - 24~30px)',
    /max\([26]px,\s*calc\(var\(--safe-bottom\)\s*-\s*(24|30)px\)\)/.test(safeBlock),
    safeBlock.replace(/\s+/g, ' ').trim()
  );
  check('pb-safe 에 옛 -14px 여백 없음', !/calc\(var\(--safe-bottom\)\s*-\s*14px\)/.test(css));
  check('pb-safe 에 옛 +8px 여백 없음', !/calc\(var\(--safe-bottom\)\s*\+\s*8px\)/.test(css));
  check('탭바가 pb-safe 사용', /className="[^"]*pb-safe/.test(tabbar));
  // v0.6.10: pt-1 → pt-0.5
  check('탭바 안쪽 위 여백 pt-1 이하', (tabbar.includes('px-3 pt-1') || tabbar.includes('px-3 pt-0.5')) && !tabbar.includes('pt-1.5'));
  check('탭바는 화면 맨 아래 고정', tabbar.includes('pa-tabbar'));
  check(
    'pb-safe 는 탭바만 사용(다른 화면 영향 없음)',
    walk(path.join(ROOT, 'src'))
      .filter((f) => /\.(tsx|ts)$/.test(f) && fs.readFileSync(f, 'utf8').includes('pb-safe'))
      .map((f) => path.relative(ROOT, f))
      .join(',') === 'src/components/MobileTabBar.tsx'
  );

  /* 3) 상단 페이드 — 더 투명하게 ------------------------------------------- */
  const header = read('src/components/AppHeader.tsx');
  // v0.6.10: 값을 48/132 로 함께 내렸다. 이 스모크는 "맨 윗줄만 불투명" 형태만 본다.
  const solid = Number((header.match(/const fadeSolid = compact \? \d+ : (\d+);/) || [])[1] || 0);
  const fadeH = Number((header.match(/const fadeHeight = compact \? \d+ : (\d+);/) || [])[1] || 0);
  check('불투명 구간이 맨 윗줄만(36~56px)', solid >= 36 && solid <= 56, String(solid));
  check('페이드 전체 높이(112~140px)', fadeH >= 112 && fadeH <= 140, String(fadeH));
  check('옛 넓은 불투명 구간(112/168) 없음', !header.includes('compact ? 70 : 112') && !header.includes('compact ? 108 : 168'));
  check(
    '3단 그라데이션 78% → 40% → transparent',
    header.includes('color-mix(in srgb, var(--pa-surface) 78%, transparent)') &&
      header.includes('color-mix(in srgb, var(--pa-surface) 40%, transparent)') &&
      /transparent \$\{fadeHeight\}px/.test(header)
  );
  check('그라데이션 중간 지점 계산', header.includes('fade78') && header.includes('fade40') && header.includes('fadeSpan'));
  // v0.6.10: 이름·배지는 하나의 유리 캡슐로 묶여 가독성을 유지한다(헤일로·개별 그림자 대신).
  check('이름 가독성 — 유리 캡슐', header.includes('pa-glass flex min-w-0 max-w-[76vw]'));
  check('배지 가독성 — 캡슐 안 알약', header.includes('background: meta.bg, color: meta.text'));
  const space = (header.match(/HEADER_SPACE = \{ normal: (\d+), compact: (\d+) \}/) || []).slice(1).map(Number);
  check('HEADER_SPACE 유지(첫 말풍선이 배지에 붙지 않음)', space[0] >= 118 && space[0] <= 140 && space[1] >= 80, space.join('/'));

  /* 4) v0.6.8 회귀 — iOS PWA 중복 스플래시 -------------------------------- */
  const app = read('src/App.tsx');
  check('standalone media query 사용', app.includes("matchMedia('(display-mode: standalone)')"));
  check('iOS navigator.standalone 사용', app.includes('standalone?: boolean') && app.includes('.standalone'));
  check('PWA 면 초기 상태가 done', /useState<'show' \| 'fading' \| 'done'>\(\(\) => \(standalonePwa\(\) \? 'done' : 'show'\)\)/.test(app));
  check('PWA 면 타이머도 잡지 않음', /if \(standalonePwa\(\)\) return;/.test(app));

  /* 5) v0.6.7 회귀 --------------------------------------------------------- */
  const themeSrc = read('src/lib/theme.ts');
  const html = read('index.html');
  const shell = read('src/components/AppShell.tsx');
  check('라이트 theme-color 메타', html.includes('name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)"'));
  check('다크 theme-color 메타', html.includes('name="theme-color" content="#1B1923" media="(prefers-color-scheme: dark)"'));
  check('모든 theme-color 메타 동기화', html.includes("querySelectorAll('meta[name=\"theme-color\"]')") && themeSrc.includes('syncThemeColor(top)'));
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('/* v0.6.4: 설정에서 고른 글꼴'));
  const darkBlock = css.slice(css.indexOf('html.dark {'), css.indexOf('@layer base'));
  check(
    '라이트 --pa-top = --pa-surface',
    (cssVar(rootBlock, '--pa-top') || '').toLowerCase() === (cssVar(rootBlock, '--pa-surface') || '').toLowerCase(),
    `${cssVar(rootBlock, '--pa-top')} / ${cssVar(rootBlock, '--pa-surface')}`
  );
  check(
    '다크 --pa-top = --pa-surface',
    (cssVar(darkBlock, '--pa-top') || '').toLowerCase() === (cssVar(darkBlock, '--pa-surface') || '').toLowerCase(),
    `${cssVar(darkBlock, '--pa-top')} / ${cssVar(darkBlock, '--pa-surface')}`
  );
  check('AppShell 세이프 에어리어 패딩 유지', shell.includes("paddingTop: 'env(safe-area-inset-top)'"));
  check('poppler-utils·poppler-data 유지', read('Dockerfile').includes('poppler-utils poppler-data'));

  /* 6) 개인정보 0건 --------------------------------------------------------- */
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
