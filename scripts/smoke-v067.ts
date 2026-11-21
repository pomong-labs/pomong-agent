/**
 * v0.6.7 스모크 테스트
 *
 *   npx tsx scripts/smoke-v067.ts
 *
 * 아이폰 상태바 띠·흰 띠 제거 핫픽스 검증. 외부 네트워크 없이 확인할 수 있는 것만 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset)
 *   2) `--pa-top` = `--pa-surface` (라이트·다크 모두 정확히 같은 HEX)
 *   3) index.html — 라이트/다크 theme-color 2개, 첫 페인트 배경, 모든 메타 동기화
 *   4) AppShell — 세이프 에어리어 단일 색, 평상시 transform 없음(키보드일 때만)
 *   5) AppHeader — 페이드 시작색이 본문 표면색
 *   6) poppler 유지 · 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v067-'));
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

/** CSS 블록 안에서 변수 하나의 값을 뽑는다. */
function cssVar(block: string, name: string): string | null {
  const m = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

async function main(): Promise<void> {
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');
  const theme = await import('../src/lib/theme');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('package.json 버전', /^0\.6\.\d+$/.test(pkg.version), pkg.version);
  check(
    'docker-compose 이미지 태그',
    compose.includes(`pomong-agent:${pkg.version}`) && compose.includes(`pomong-agent-browser:${pkg.version}`)
  );
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check('에셋 캐시 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);

  /* 2) 상태바 색 = 표면색 --------------------------------------------------- */
  const css = read('src/index.css');
  const themeSrc = read('src/lib/theme.ts');
  const shell = read('src/components/AppShell.tsx');
  const header = read('src/components/AppHeader.tsx');
  const html = read('index.html');

  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('/* v0.6.4: 설정에서 고른 글꼴'));
  const darkBlock = css.slice(css.indexOf('html.dark {'), css.indexOf('@layer base'));
  const lightSurface = cssVar(rootBlock, '--pa-surface');
  const lightTop = cssVar(rootBlock, '--pa-top');
  const darkSurface = cssVar(darkBlock, '--pa-surface');
  const darkTop = cssVar(darkBlock, '--pa-top');
  check('index.css 라이트 --pa-top = --pa-surface', !!lightTop && lightTop.toLowerCase() === lightSurface?.toLowerCase(), `${lightTop} / ${lightSurface}`);
  check('index.css 다크 --pa-top = --pa-surface', !!darkTop && darkTop.toLowerCase() === darkSurface?.toLowerCase(), `${darkTop} / ${darkSurface}`);

  const topLight = theme.topSurfaceColor('#E96C99', 'light').toLowerCase();
  const topDark = theme.topSurfaceColor('#E96C99', 'dark').toLowerCase();
  check('topSurfaceColor(라이트) = LIGHT_SURFACE', topLight === theme.LIGHT_SURFACE.toLowerCase(), topLight);
  check('topSurfaceColor(다크) = DARK_SURFACE', topDark === theme.DARK_SURFACE.toLowerCase(), topDark);
  check('포인트 컬러와 무관', theme.topSurfaceColor('#35B98A', 'light') === theme.topSurfaceColor('#8B72F8', 'light'));
  check('theme.ts 라이트 값 = index.css 라이트 표면', theme.LIGHT_SURFACE.toLowerCase() === lightSurface?.toLowerCase(), theme.LIGHT_SURFACE);
  check('theme.ts 다크 값 = index.css 다크 표면', theme.DARK_SURFACE.toLowerCase() === darkSurface?.toLowerCase(), theme.DARK_SURFACE);
  check('틴트 계산 제거', !themeSrc.includes('mix(DARK_SURFACE') && !themeSrc.includes('mix(LIGHT_SURFACE'));

  /* 3) index.html --------------------------------------------------------- */
  check('라이트 theme-color 메타', html.includes('name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)"'));
  check('다크 theme-color 메타', html.includes('name="theme-color" content="#1B1923" media="(prefers-color-scheme: dark)"'));
  check('media 없는 정적 메타 없음', !/<meta name="theme-color" content="[^"]+" \/>/.test(html));
  check('첫 페인트 배경(라이트)', /html,\s*body\s*\{\s*background-color:\s*#ffffff;/i.test(html));
  check('첫 페인트 배경(다크)', /@media \(prefers-color-scheme: dark\)[\s\S]{0,200}background-color:\s*#1b1923;/i.test(html));
  check('첫 페인트 스크립트가 모든 메타 동기화', html.includes("querySelectorAll('meta[name=\"theme-color\"]')"));
  check('첫 페인트 기본값이 표면색', html.includes("'#1B1923'") && html.includes("'#FFFFFF'"));
  check(
    '옛 저장값(--pa-top 틴트)에 기대지 않음',
    !html.includes("s.vars['--pa-top']") && html.includes("root.style.setProperty('--pa-top', top)")
  );
  check('theme.ts도 모든 메타 동기화', themeSrc.includes('export function syncThemeColor') && themeSrc.includes('syncThemeColor(top)'));

  /* 4) AppShell — 세이프 에어리어 단일 색 · 평상시 transform 없음 ------------ */
  // v0.6.11: className 이 template literal 로 바뀌어(bottom-0 분기) 여는 따옴표 모양이 달라진다.
  const shellTag = shell.slice(shell.indexOf('pa-app-shell'), shell.indexOf('<main'));
  check('셸에 pa-app-shell 클래스', /className=\{?[`"]pa-app-shell fixed inset-x-0 top-0/.test(shell));
  check('셸 인라인 transform 제거', !shellTag.includes('transform:'));
  check('본문 배경 단일 색', shell.includes("background: 'var(--pa-surface)'"));
  check('세이프 에어리어 그라데이션 제거', !shell.includes('linear-gradient(to bottom, var(--pa-top)') && !shell.includes('env(safe-area-inset-top, 0px) + 60px'));
  check('세이프 에어리어 패딩 유지', shell.includes("paddingTop: 'env(safe-area-inset-top)'"));

  const store = read('src/lib/store.tsx');
  check('오프셋이 있을 때만 pa-shifted', store.includes("root.classList.toggle('pa-shifted'"));
  check('CSS는 pa-shifted에서만 transform', css.includes('html.pa-shifted .pa-app-shell {') && css.includes('transform: translate3d(var(--app-offset-x, 0px), var(--app-offset, 0px), 0);'));

  /* 5) AppHeader — 페이드 시작색 = 표면색 ----------------------------------- */
  check('페이드 시작색이 표면색', header.includes('linear-gradient(to bottom, var(--pa-surface) 0px, var(--pa-surface)'));
  check('상태 점 링도 표면색', header.includes("boxShadow: '0 0 0 2.5px var(--pa-surface)'"));

  /* 6) poppler 유지 --------------------------------------------------------- */
  const dockerfile = read('Dockerfile');
  check('poppler-utils·poppler-data 유지', dockerfile.includes('poppler-utils poppler-data'));

  /* 7) 개인정보 0건 --------------------------------------------------------- */
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
    .concat(walk(path.join(ROOT, 'public')))
    .concat([path.join(ROOT, 'index.html'), path.join(ROOT, 'README.md'), path.join(ROOT, 'SECURITY.md')])
    .filter((file) => /\.(ts|tsx|js|jsx|css|html|md|json|sh|py)$/.test(file));
  for (const [label, re] of patterns) {
    const hits: string[] = [];
    for (const file of targets) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('scripts/smoke-')) continue; // 검사 패턴 자체는 제외
      if (rel.startsWith('public/sw.js')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (piiHit(re, text)) hits.push(rel);
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
