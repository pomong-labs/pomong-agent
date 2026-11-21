/**
 * v0.6.17 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0617.ts
 *
 * 1) 이미지 리소스 프리로드 — 마스코트 PNG 목록이 실제 public/mascots 와 일치하는지,
 *    모든 주소에 에셋 버전(?v=)이 붙는지, Image 가 없는 환경에서도 죽지 않는지
 * 2) MascotFace — 상태별 layer 6장(기본+표정5)을 항상 겹쳐 두고 data-on 하나만 켜지는지
 *    (React 서버 렌더로 실제 마크업을 확인), key={src} 재마운트 구조가 사라졌는지
 * 3) 스플래시 — 프리로드가 끝나면 넘어가되 최대 1.6초에서 끊는지, standalone 에서도 프리로드하는지
 * 4) CSS — 550ms · cubic-bezier(0.22,1,0.36,1) transition 과 data-on 규칙
 * 5) 회귀 — 버전 표기 일원화, 도커 소켓 rw, poppler, PWA 메타, 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0617-'));
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
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');
  const preload = await import('../src/lib/preload');
  const MascotFace = (await import('../src/components/MascotFace')).default;

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  check('버전 0.6.x', /^0\.6\.\d+$/.test(pkg.version), pkg.version);
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('에셋 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check(
    'docker-compose 이미지 태그',
    compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`)
  );
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check(
    'More·Settings 표시 버전',
    read('src/pages/More.tsx').includes(`useState('${pkg.version}')`) &&
      read('src/pages/Settings.tsx').includes(`|| '${pkg.version}'`)
  );

  /* 2) 프리로드 목록 ↔ 실제 파일 ------------------------------------------ */
  const baseFiles = fs
    .readdirSync(path.join(ROOT, 'public/mascots'))
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.replace(/\.png$/, ''))
    .sort();
  const faceFiles = fs
    .readdirSync(path.join(ROOT, 'public/mascots/face'))
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.replace(/\.png$/, ''))
    .sort();
  check(
    '기본 마스코트 PNG 목록 일치',
    JSON.stringify([...preload.MASCOT_BASE_NAMES].sort()) === JSON.stringify(baseFiles),
    `${preload.MASCOT_BASE_NAMES.length} / 파일 ${baseFiles.length}`
  );
  check(
    '상태별 표정 PNG 목록 일치',
    JSON.stringify(
      preload.FACE_CHARACTERS.flatMap((c: string) => preload.FACE_STATES.map((s: string) => `${c}-${s}`)).sort()
    ) === JSON.stringify(faceFiles),
    `${preload.FACE_CHARACTERS.length * preload.FACE_STATES.length} / 파일 ${faceFiles.length}`
  );
  check('캐릭터 6종', preload.FACE_CHARACTERS.length === 6, preload.FACE_CHARACTERS.join(','));
  check('표정 5상태', preload.FACE_STATES.length === 5, preload.FACE_STATES.join(','));
  check('기본 PNG 16장', preload.MASCOT_BASE_URLS.length === 16, String(preload.MASCOT_BASE_URLS.length));
  check('표정 PNG 30장', preload.MASCOT_FACE_URLS.length === 30, String(preload.MASCOT_FACE_URLS.length));

  const allUrls: string[] = preload.mascotAssetUrls();
  check('프리로드 전체 46장 + 로고 2장', allUrls.length === 48, String(allUrls.length));
  check('모든 주소에 에셋 버전', allUrls.every((url: string) => url.endsWith(`?v=${ASSET_VERSION}`)), allUrls[0]);
  check('모든 주소가 /mascots 또는 로고', allUrls.every((url: string) => url.startsWith('/mascots/') || url.startsWith('/pomong-labs-logo')), '');
  check('이미지 파일이 실제로 존재', allUrls.every((url: string) => fs.existsSync(path.join(ROOT, 'public', url.split('?')[0]))));
  check('기본 캐릭터 주소', preload.mascotSrc('pimong') === `/mascots/pimong.png?v=${ASSET_VERSION}`, preload.mascotSrc('pimong'));
  check(
    '표정 주소',
    preload.mascotFaceSrc('pongi', 'working') === `/mascots/face/pongi-working.png?v=${ASSET_VERSION}`,
    preload.mascotFaceSrc('pongi', 'working')
  );
  check(
    '캐릭터 하나 = 기본 1 + 표정 5',
    preload.characterAssetUrls('mello').length === 6 && preload.characterAssetUrls('mello').every((u: string) => u.includes('mello')),
    String(preload.characterAssetUrls('mello').length)
  );
  check('중복 주소 없음', new Set(allUrls).size === allUrls.length);

  /* 3) 프리로드 동작 (Node — Image 없음) ----------------------------------- */
  check('처음엔 준비된 그림 없음', !preload.isImageReady(preload.mascotSrc('pimong')));
  check('빈 주소는 즉시 false', (await preload.preloadImage('')) === false);
  check(
    'Image 없는 환경에서도 예외 없이 false',
    (await preload.preloadImage(preload.mascotSrc('pimong'))) === false
  );
  const coreDone = await preload.preloadMascotAssets();
  check('부팅 프리로드가 끝난다(무한 대기 없음)', coreDone === undefined);
  check('같은 주소 재요청도 안전', (await preload.preloadImage(preload.mascotSrc('pimong'))) === false);
  const characterDone = await preload.preloadCharacter('poding');
  check('캐릭터 단위 프리로드', Array.isArray(characterDone) && characterDone.length === 6);

  /* 4) MascotFace — 상태별 layer 6장, 하나만 켜짐 -------------------------- */
  const render = (props: { character?: string; state?: string; size?: number }) =>
    renderToStaticMarkup(React.createElement(MascotFace, props as never));
  const states = ['idle', 'thinking', 'working', 'responding', 'error'] as const;
  for (const state of states) {
    const html = render({ character: 'pongi', state, size: 44 });
    const imgs = html.match(/<img/g)?.length ?? 0;
    const on = html.match(/data-on="true"/g)?.length ?? 0;
    const active = /<img src="([^"]+)"[^>]*data-on="true"/.exec(html)?.[1] ?? '';
    check(`${state}: layer 6장`, imgs === 6, String(imgs));
    check(`${state}: 켜진 그림은 1장`, on === 1, String(on));
    check(`${state}: ${state} 표정이 켜짐`, active.includes(`/mascots/face/pongi-${state}.png`), active);
    check(`${state}: 모든 그림에 ?v=`, (html.match(/\?v=/g)?.length ?? 0) === 6);
  }
  const oneHtml = render({ character: 'pimong', state: 'thinking' });
  check('alt 는 켜진 그림에만 1개', (oneHtml.match(/alt="포몽 에이전트 캐릭터"/g)?.length ?? 0) === 1);
  check('나머지 그림은 aria-hidden', (oneHtml.match(/aria-hidden="true"/g)?.length ?? 0) === 5);
  check('layer 클래스 사용', (oneHtml.match(/class="pa-face-layer"/g)?.length ?? 0) === 6);
  check('기본 캐릭터 그림도 layer 에 있음', oneHtml.includes(`/mascots/pimong.png?v=${ASSET_VERSION}`));

  const faceSrc = read('src/components/MascotFace.tsx');
  check('key={src} 재마운트 제거', !faceSrc.includes('key={src}'));
  check('이전 그림 타이머(setPrevious) 제거', !faceSrc.includes('setPrevious'));
  check('keyframe 클래스 미사용', !faceSrc.includes('pa-face-in') && !faceSrc.includes('pa-face-out'));
  check('다섯 상태를 고정 layer 로', faceSrc.includes('LAYER_STATES') && faceSrc.includes('data-on'));
  check('준비 안 된 새 표정은 이전 표정 유지', faceSrc.includes('shownState') && faceSrc.includes('ready(targetSrc)'));
  check('프리로드 레지스트리 확인', faceSrc.includes('isImageReady'));
  check('캐릭터 변경 시 그 캐릭터 프리로드', faceSrc.includes('preloadCharacter(character)'));
  check('상태 배지와 같은 표정 매핑', read('src/components/MascotFace.tsx').includes("responding: 'responding'"));

  /* 5) 스플래시 ------------------------------------------------------------ */
  const app = read('src/App.tsx');
  check('App 이 부팅 프리로드를 시작', app.includes('preloadMascotAssets()'));
  check('프리로드는 standalone 여부와 무관하게 실행', /const assets = preloadMascotAssets\(\);[\s\S]{0,120}if \(standalonePwa\(\)\) return;/.test(app));
  check('최소 표시 620ms', app.includes('const SPLASH_MIN_MS = 620;'));
  check('최대 대기 1600ms', app.includes('const SPLASH_MAX_WAIT_MS = 1600;'));
  check('페이드 300ms', app.includes('const SPLASH_FADE_MS = 300;'));
  check('프리로드 완료 후 페이드', app.includes('void assets.then(() =>') && app.includes('beginFade'));
  check('네트워크 지연 시 최대 대기에서 끊음', app.includes('window.setTimeout(beginFade, SPLASH_MAX_WAIT_MS)'));
  check('스플래시 로고도 에셋 버전', app.includes('brandLogoUrl()'));
  check('스플래시 마스코트는 Mascot 사용', app.includes('<Mascot name="pimong" hero size={112} />'));

  /* 6) CSS ----------------------------------------------------------------- */
  const css = read('src/index.css');
  check('.pa-face-layer 정의', css.includes('.pa-face-layer {'));
  check('opacity·scale transition 550ms', /transition:\s*\n?\s*opacity 550ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/.test(css));
  check('같은 커브 유지', css.includes('transform 550ms cubic-bezier(0.22, 1, 0.36, 1)'));
  check("data-on='true' 만 불투명", /\.pa-face-layer\[data-on='true'\]\s*\{[^}]*opacity: 1;/.test(css));
  check('예전 keyframe 클래스 제거', !css.includes('.pa-face-in') && !css.includes('.pa-face-out'));
  check('겹치기 위한 절대 배치', /\.pa-face-layer\s*\{[^}]*position: absolute;/.test(css));

  /* 7) Mascot 컴포넌트 ------------------------------------------------------ */
  const mascot = read('src/components/Mascot.tsx');
  check('Mascot 도 에셋 버전 사용', mascot.includes('mascotSrc(file)'));
  check('로고 주소 공통화', mascot.includes('brandLogoUrl'));

  /* 8) 회귀 ---------------------------------------------------------------- */
  const html = read('index.html');
  check('viewport-fit=cover 유지', html.includes('viewport-fit=cover'));
  check('poppler-utils·poppler-data 유지', read('Dockerfile').includes('poppler-utils poppler-data'));
  check(
    '도커 소켓 쓰기 마운트 유지',
    compose.includes('/var/run/docker.sock:/var/run/docker.sock') && !compose.includes('/var/run/docker.sock:/var/run/docker.sock:ro')
  );
  check('MascotFace 사용처 유지', ['AppHeader', 'Settings', 'Automation', 'Tasks', 'Setup'].every((f) => read(`src/${f === 'AppHeader' ? 'components' : 'pages'}/${f}.tsx`).includes('MascotFace')));

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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
