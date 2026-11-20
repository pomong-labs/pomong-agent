/**
 * v0.6.10 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0610.ts
 *
 * 이름·상태 배지 유리 박스 묶기 + 하단 탭바 바닥 밀착 + 상단 요소 조금 더 내리기 검증. 외부 네트워크 없이 본다.
 * v0.6.11 이후: 이 파일은 **0.6.10 스모크의 회귀 항목**만 본다. 버전·패딩·페이드·탭바 여백처럼
 * 릴리스마다 값이 따라 움직이는 체크는 다음 버전과 충돌하지 않게 범위/패턴으로 정합화했다.
 *
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset ↔ More/Settings)
 *   2) 이름 + 상태 배지 — 하나의 `.pa-glass` 캡슐 안에 나란히, 상태 색·크로스페이드 전환 유지
 *   3) 상단 여백 — 일반 모드 pt-2 → pt-4, 페이드 48/132px(키보드 34/100), HEADER_SPACE 동반 조정
 *   4) 하단 탭바 — `.pb-safe` = max(2px, safe-bottom - 30px), py-1.5 · pt-0.5
 *   5) v0.6.9 회귀 — 3단 페이드 그라데이션
 *   6) v0.6.8 회귀 — standalone 스플래시 건너뛰기 유지
 *   7) v0.6.7 회귀 — `--pa-top` = `--pa-surface`, 라이트/다크 theme-color 메타, poppler 유지
 *   8) 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0610-'));
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
  check('버전 0.6.x (0.6.10 이상)', /^0\.6\.(1[0-9]|[2-9]\d)$/.test(pkg.version), pkg.version);
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

  /* 2) 이름 + 상태 배지 — 하나의 유리 캡슐 -------------------------------- */
  const header = read('src/components/AppHeader.tsx');
  const capsuleAt = header.indexOf('pa-glass flex min-w-0 max-w-[76vw] items-center gap-2 rounded-full');
  const nameAt = header.indexOf("profile.agentName || 'Pomong'");
  const badgeAt = header.indexOf('background: meta.bg, color: meta.text');
  check('이름+배지 유리 캡슐 존재(.pa-glass)', capsuleAt > 0);
  check('캡슐은 알약형(rounded-full)', capsuleAt > 0 && header.slice(capsuleAt, capsuleAt + 120).includes('rounded-full'));
  check('이름과 배지가 같은 캡슐 안에 순서대로', capsuleAt > 0 && capsuleAt < nameAt && nameAt < badgeAt);
  check('캡슐 안 구분선', /h-3\.5 w-px shrink-0/.test(header.slice(capsuleAt, badgeAt)));
  check('이름은 캡슐 안에서 말줄임(truncate)', header.slice(capsuleAt, nameAt).includes('truncate'));
  check('옛 이름 text-shadow 헤일로 제거', !header.includes('textShadow:'));
  check('옛 배지 단독 그림자 제거', !header.includes("boxShadow: '0 2px 10px color-mix(in srgb, var(--pa-surface) 40%, transparent)'"));
  check('배지 상태 색 유지(meta.bg · meta.text)', badgeAt > 0);
  // v0.6.11: 300ms → 550ms(cubic-bezier(0.22,1,0.36,1)). 전환 자체가 남아 있는지만 본다.
  check(
    '배지 색 전환 애니메이션 유지',
    /transition-colors duration-(300|\[550ms\])/.test(header.slice(badgeAt - 400, badgeAt + 200))
  );
  check(
    '배지 라벨 크로스페이드 유지(5상태 겹침)',
    header.includes("const STATE_ORDER: AgentState[] = ['idle', 'thinking', 'working', 'responding', 'error'];") &&
      header.includes("id === visibleState ? 'translate-y-0 opacity-100' : 'translate-y-[3px] opacity-0'")
  );
  check('배지 점 애니메이션 유지(animate-pulse)', header.includes("busy ? 'animate-pulse' : ''"));
  check('캡슐이 화면 폭을 넘지 않음(max-w-[76vw])', header.includes('max-w-[76vw]'));

  /* 3) 상단 여백 — 조금 더 내리기 ------------------------------------------ */
  // v0.6.11: pt-4 → pt-6(24px), 페이드 56/140, HEADER_SPACE 134 — "pt-2 보다는 내려가 있고, 값들이 함께 움직인다"만 본다.
  const padN = Number((header.match(/pb-1\.5 pt-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const solidN = Number((header.match(/const fadeSolid = compact \? 34 : (\d+);/) || [])[1] || 0);
  const fadeN = Number((header.match(/const fadeHeight = compact \? 100 : (\d+);/) || [])[1] || 0);
  const spaceN = Number((header.match(/HEADER_SPACE = \{ normal: (\d+), compact: 88 \}/) || [])[1] || 0);
  check('일반 모드 상단 패딩 pt-4 이상', padN >= 4, `pt-${padN}`);
  check('옛 상단 패딩 pt-2 없음', !header.includes("'pb-1.5 pt-2'"));
  check('페이드 불투명 ≥ 48px(키보드 34px)', solidN >= 48 && header.includes('compact ? 34 :'), `${solidN}px`);
  check('페이드 전체 ≥ 132px(키보드 100px)', fadeN >= 132 && header.includes('compact ? 100 :'), `${fadeN}px`);
  check('HEADER_SPACE 동반 조정(≥126/88)', spaceN >= 126, `normal: ${spaceN}`);
  const chat = read('src/pages/Chat.tsx');
  check(
    '첫 말풍선 여백이 HEADER_SPACE 사용',
    chat.includes('paddingTop: keyboardOpen ? HEADER_SPACE.compact : HEADER_SPACE.normal')
  );
  check('헤더 아래 끝보다 HEADER_SPACE 가 큼', spaceN > padN * 4 + 48 + 6 + 26 + 6, `HEADER_SPACE ${spaceN}`);

  /* 4) 하단 탭바 — 바닥 밀착 ----------------------------------------------- */
  const css = read('src/index.css');
  const tabbar = read('src/components/MobileTabBar.tsx');
  // v0.6.11: max(8px, safe-bottom - 18px) — "세이프 에어리어에서 빼는 타이트한 max()" 형태만 본다.
  const safeBlock = css.slice(css.indexOf('.pb-safe {'), css.indexOf('.pt-safe {'));
  check(
    'pb-safe 가 타이트한 max() 형태',
    /max\([268]px,\s*calc\(var\(--safe-bottom\)\s*-\s*(18|24|30)px\)\)/.test(safeBlock),
    safeBlock.replace(/\s+/g, ' ').trim()
  );
  check('pb-safe 에 옛 -24px 여백 없음', !/calc\(var\(--safe-bottom\)\s*-\s*24px\)/.test(css));
  check('pb-safe 에 옛 -14px 여백 없음', !/calc\(var\(--safe-bottom\)\s*-\s*14px\)/.test(css));
  check('탭바가 pb-safe 사용', /className="[^"]*pb-safe/.test(tabbar));
  check('탭 버튼 세로 패딩 py-1.5', tabbar.includes('py-1.5') && !tabbar.includes('py-2'));
  check('탭바 안쪽 위 여백 pt-0.5', tabbar.includes('px-3 pt-0.5'));
  check('탭바는 화면 맨 아래 고정', tabbar.includes('pa-tabbar'));
  check(
    'pb-safe 는 탭바만 사용(다른 화면 영향 없음)',
    walk(path.join(ROOT, 'src'))
      .filter((f) => /\.(tsx|ts)$/.test(f) && fs.readFileSync(f, 'utf8').includes('pb-safe'))
      .map((f) => path.relative(ROOT, f))
      .join(',') === 'src/components/MobileTabBar.tsx'
  );

  /* 5) v0.6.9 회귀 — 상단 페이드 3단 --------------------------------------- */
  check(
    '3단 그라데이션 78% → 40% → transparent',
    header.includes('color-mix(in srgb, var(--pa-surface) 78%, transparent)') &&
      header.includes('color-mix(in srgb, var(--pa-surface) 40%, transparent)') &&
      /transparent \$\{fadeHeight\}px/.test(header)
  );
  check('그라데이션 중간 지점 계산', header.includes('fade78') && header.includes('fade40') && header.includes('fadeSpan'));
  check('v0.6.9 이전의 넓은 불투명 구간(112/168) 없음', !header.includes('compact ? 70 : 112') && !header.includes('compact ? 108 : 168'));

  /* 6) v0.6.8 회귀 — iOS PWA 중복 스플래시 -------------------------------- */
  const app = read('src/App.tsx');
  check('standalone media query 사용', app.includes("matchMedia('(display-mode: standalone)')"));
  check('iOS navigator.standalone 사용', app.includes('standalone?: boolean') && app.includes('.standalone'));
  check('PWA 면 초기 상태가 done', /useState<'show' \| 'fading' \| 'done'>\(\(\) => \(standalonePwa\(\) \? 'done' : 'show'\)\)/.test(app));
  check('PWA 면 타이머도 잡지 않음', /if \(standalonePwa\(\)\) return;/.test(app));

  /* 7) v0.6.7 회귀 --------------------------------------------------------- */
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
