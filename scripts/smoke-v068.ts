/**
 * v0.6.8 스모크 테스트
 *
 *   npx tsx scripts/smoke-v068.ts
 *
 * 하단 탭바 여백 축소 + iOS PWA 중복 스플래시 제거 핫픽스 검증. 외부 네트워크 없이 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset)
 *   2) 하단 탭바 — `.pb-safe` 가 타이트한 max(10px, safe-bottom - 14px) 이고 탭바만 쓴다
 *   3) App.tsx — standalone 감지 시 SplashOverlay 를 처음부터 건너뛰고, 일반 브라우저에선 그대로
 *   4) v0.6.7 회귀 — `--pa-top` = `--pa-surface`, 라이트/다크 theme-color 메타, poppler 유지
 *   5) 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v068-'));
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
  check('버전 0.6.8', pkg.version === '0.6.8', pkg.version);
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('docker-compose 이미지 태그', compose.includes('image: pomong-agent:0.6.8') && compose.includes('image: pomong-agent-browser:0.6.8'));
  check('서비스 워커 캐시 버전', read('public/sw.js').includes('pomong-agent-v0.6.8'));
  check('에셋 캐시 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);

  /* 2) 하단 탭바 여백 ------------------------------------------------------- */
  const css = read('src/index.css');
  const tabbar = read('src/components/MobileTabBar.tsx');
  const safeBlock = css.slice(css.indexOf('.pb-safe {'), css.indexOf('.pt-safe {'));
  check('pb-safe 가 타이트한 max() 값', /max\(10px,\s*calc\(var\(--safe-bottom\)\s*-\s*14px\)\)/.test(safeBlock), safeBlock.replace(/\s+/g, ' ').trim());
  check('pb-safe 에 옛 +8px 여백 없음', !/calc\(var\(--safe-bottom\)\s*\+\s*8px\)/.test(css));
  check('탭바가 pb-safe 사용', /className="[^"]*pb-safe/.test(tabbar));
  check('탭바는 화면 맨 아래 고정', tabbar.includes('pa-tabbar'));
  check(
    'pb-safe 는 탭바만 사용(다른 화면 영향 없음)',
    walk(path.join(ROOT, 'src')).filter((f) => /\.(tsx|ts)$/.test(f) && fs.readFileSync(f, 'utf8').includes('pb-safe')).map((f) => path.relative(ROOT, f)).join(',') === 'src/components/MobileTabBar.tsx'
  );

  /* 3) iOS PWA 중복 스플래시 ------------------------------------------------ */
  const app = read('src/App.tsx');
  check('standalone media query 사용', app.includes("matchMedia('(display-mode: standalone)')"));
  check('iOS navigator.standalone 사용', app.includes('standalone?: boolean') && app.includes('.standalone'));
  check('PWA 면 초기 상태가 done', /useState<'show' \| 'fading' \| 'done'>\(\(\) => \(standalonePwa\(\) \? 'done' : 'show'\)\)/.test(app));
  check('PWA 면 타이머도 잡지 않음', /if \(standalonePwa\(\)\) return;/.test(app));
  check('일반 브라우저는 620ms·940ms 그대로', app.includes('SPLASH_FADE_MS = 620') && app.includes('SPLASH_DONE_MS = 940'));
  check('SplashOverlay 렌더 조건 유지', app.includes("{splash !== 'done' ? <SplashOverlay fading={splash === 'fading'} /> : null}"));

  /* 4) v0.6.7 회귀 --------------------------------------------------------- */
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

  /* 5) 개인정보 0건 --------------------------------------------------------- */
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
