/**
 * v0.5.6 UI 스크린샷 (로컬 임시 인스턴스 — 실사용 데이터 없음)
 *
 * 실행:
 *   node scripts/ui-shots-v056.mjs
 *   CHROME_PATH=/path/to/chrome OUT=/workspace/downloads/pomong-v056 node scripts/ui-shots-v056.mjs
 *
 * 1) 임시 DATA_DIR로 서버를 띄워 계정을 만들고, 데모 대화 2~3개를 DB에 넣는다.
 * 2) 로그인 → 라이트/다크/캐릭터 컬러를 실제로 눌러 바꾸며 촬영한다.
 * 3) 상단바 가운데 정렬을 좌표로 확인한다(가운데 칸 중심 vs 화면 중심).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT || path.join(ROOT, 'downloads', 'pomong-v056');
const PORT = Number(process.env.SHOT_PORT || 3123);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = process.env.SHOT_DATA || path.join(os.tmpdir(), `pa-shots-${Date.now()}`);
const CHROME =
  process.env.CHROME_PATH ||
  fs
    .readdirSync(path.join('/workspace/.cache/puppeteer/chrome'))
    .map((v) => path.join('/workspace/.cache/puppeteer/chrome', v, 'chrome-linux64', 'chrome'))
    .find((p) => fs.existsSync(p));
const USERNAME = 'demo';
const PASSWORD = 'demo-shot-pass';

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

const { chromium } = require('playwright-core');

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server-dist/index.js')], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR: DATA, TZ: 'Asia/Seoul' },
    stdio: 'ignore',
  });
  return child;
}

async function waitHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('서버가 뜨지 않았습니다');
}

async function stop(child) {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function bootstrap() {
  let child = startServer();
  await waitHealth();
  const token = fs.readFileSync(path.join(DATA, 'setup-token.txt'), 'utf8').trim();
  const verify = await fetch(`${BASE}/api/setup/verify-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const setupCookie = (verify.headers.get('set-cookie') || '').split(';')[0];
  await fetch(`${BASE}/api/setup/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: setupCookie },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  await fetch(`${BASE}/api/setup/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: setupCookie },
    body: '{}',
  });
  await stop(child);
}

function seedMessages() {
  const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
  const db = new Database(path.join(DATA, 'pomong-agent.db'));
  const now = Date.now();
  const insert = db.prepare('INSERT INTO messages (session_id, role, content, meta, created_at) VALUES (?,?,?,?,?)');
  insert.run('default', 'user', '오늘 춘천 날씨 어때? 오후에 나가는데 우산 챙겨야 할까?', null, new Date(now - 1000 * 60 * 8).toISOString());
  insert.run(
    'default',
    'assistant',
    '춘천은 지금 3도에 흐린 하늘이에요. 오후 3시쯤부터 비 소식이 있으니 우산을 챙기시는 게 좋겠어요.\n\n- 기온 3° → 7° (체감 1°)\n- 오후 강수 확률 70%\n- 바람 약함',
    null,
    new Date(now - 1000 * 60 * 7).toISOString()
  );
  insert.run('default', 'user', '고마워! 근데 이번 주말은 어때?', null, new Date(now - 1000 * 60 * 2).toISOString());
  insert.run(
    'default',
    'assistant',
    '주말은 토요일 맑음 9도, 일요일 흐림 11도예요. 토요일에 나들이하기 좋겠어요. 제가 토요일 아침에 날씨를 알려 드릴까요?',
    null,
    new Date(now - 1000 * 60 * 1).toISOString()
  );
  db.close();
}

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[placeholder="아이디"]', USERNAME);
  await page.fill('input[placeholder="비밀번호"]', PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(1200);
}

/** 상단바 가운데(캐릭터 wrapper) 중심과 화면 중심의 차이(px) */
/** 상단바 가운데(캐릭터·이름 칸) 중심과 상단바 중심의 차이(px) */
async function headerOffset(page) {
  return page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return { error: 'no header' };
    const center = header.children[1];
    if (!center) return { error: 'no center column' };
    const box = center.getBoundingClientRect();
    const hb = header.getBoundingClientRect();
    return {
      offset: Math.round((box.left + box.width / 2 - (hb.left + hb.width / 2)) * 10) / 10,
      width: Math.round(box.width),
      headerWidth: Math.round(hb.width),
    };
  });
}

/**
 * 다크 테마 대비 점검: 화면에 보이는 글자 요소의 색과 실제 배경을 계산해
 * 대비가 3:1 미만인 곳을 찾는다(아이콘·장식용 제외는 못 하므로 참고 지표).
 */
async function contrastAudit(page) {
  return page.evaluate(() => {
    const parse = (value) => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const luminance = (c) => {
      const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const contrast = (a, b) => {
      const la = luminance(a);
      const lb = luminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const bgOf = (el) => {
      let node = el;
      while (node) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0.5) return bg;
        node = node.parentElement;
      }
      return { r: 16, g: 15, b: 22, a: 1 };
    };
    const results = [];
    for (const el of document.querySelectorAll('body *')) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!own) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.4) continue;
      const fg = parse(style.color);
      if (!fg || fg.a < 0.4) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const ratio = contrast(fg, bgOf(el));
      results.push({
        ratio: Math.round(ratio * 100) / 100,
        text: (el.textContent || '').trim().slice(0, 22),
        color: style.color,
        bg: `rgb(${Object.values(bgOf(el)).slice(0, 3).join(',')})`,
        size: style.fontSize,
      });
    }
    results.sort((a, b) => a.ratio - b.ratio);
    return { total: results.length, low: results.filter((r) => r.ratio < 3).length, worst: results.slice(0, 6) };
  });
}

async function main() {
  if (!CHROME) throw new Error('Chrome을 찾지 못했습니다(CHROME_PATH).');
  await bootstrap();
  seedMessages();
  const child = startServer();
  await waitHealth();

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  const report = [];
  try {
    const pc = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
    const page = await pc.newPage();
    await signIn(page);

    // 1) 라이트 채팅
    await page.screenshot({ path: path.join(OUT, '01-chat-light-pc.png') });
    report.push(`PC 라이트 상단바 중심 오프셋: ${JSON.stringify(await headerOffset(page))}`);

    // 2) 설정 — 성격 프리셋
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '02-settings-profile-light-pc.png') });
    const personaCard = page.getByRole('button', { name: /유쾌하고 재치 있는 동료/ });
    await personaCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '03-settings-persona-light-pc.png') });

    // 3) 설정 — 테마 섹션 (다크로 실제 클릭)
    const themeHeading = page.getByRole('heading', { name: '화면 테마' });
    await themeHeading.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '04-settings-theme-light-pc.png') });
    await page.getByRole('button', { name: /^다크/ }).click();
    await page.waitForTimeout(900);
    report.push(
      `다크 클릭 후 html class: ${await page.evaluate(() => document.documentElement.className || '(없음)')}`
    );
    await page.screenshot({ path: path.join(OUT, '05-settings-theme-dark-pc.png') });

    // 4) 캐릭터 컬러 — 멜로(피치 오렌지) + 캐릭터 맞춤
    await page.getByRole('button', { name: /캐릭터 맞춤/ }).click();
    await page.waitForTimeout(500);
    const mello = page.getByRole('button', { name: /멜로/ }).first();
    await mello.click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /^저장/ }).first().click();
    await page.waitForTimeout(900);
    report.push(
      `멜로 + 캐릭터 맞춤 accent 변수: ${await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      )}`
    );
    await page.screenshot({ path: path.join(OUT, '06-settings-accent-mello-dark-pc.png') });
    report.push(`PC 다크 설정 대비 점검: ${JSON.stringify(await contrastAudit(page))}`);

    // 5) 다크 채팅 (말풍선·입력창·상단바)
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '07-chat-dark-pc.png') });
    report.push(`PC 다크 상단바 중심 오프셋: ${JSON.stringify(await headerOffset(page))}`);
    report.push(`PC 다크 채팅 대비 점검: ${JSON.stringify(await contrastAudit(page))}`);

    // 6) PC 라이트 + 피몽 컬러
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /^라이트/ }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /피몽/ }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^저장/ }).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, '08-settings-accent-pimong-light-pc.png') });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '09-chat-light-pimong-pc.png') });

    // 7) 기기 설정 따름 + 새로고침 유지
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /기기 설정/ }).click();
    await page.waitForTimeout(700);
    const mode = await page.evaluate(() => document.documentElement.dataset.themeMode);
    report.push(`기기 설정 따름 선택 후 data-theme-mode=${mode}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    report.push(
      `새로고침 뒤 localStorage 테마: ${await page.evaluate(() => localStorage.getItem('pomong.theme')?.slice(0, 90))}`
    );

    // 8) 모바일
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'ko-KR',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    });
    const mp = await mobile.newPage();
    await signIn(mp);
    await mp.screenshot({ path: path.join(OUT, '10-chat-light-mobile.png') });
    report.push(`모바일 상단바 중심 오프셋: ${JSON.stringify(await headerOffset(mp))}`);
    // 입력창에 긴 글을 넣어 상단바가 흔들리지 않는지
    await mp.fill('textarea', '주말에 춘천 날씨 알려줘');
    await mp.waitForTimeout(500);
    await mp.screenshot({ path: path.join(OUT, '11-chat-light-mobile-typing.png') });
    report.push(`입력 중 상단바 중심 오프셋: ${JSON.stringify(await headerOffset(mp))}`);

    await mp.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await mp.waitForTimeout(900);
    await mp.getByRole('button', { name: /^다크/ }).click();
    await mp.waitForTimeout(700);
    await mp.getByRole('heading', { name: '화면 테마' }).scrollIntoViewIfNeeded();
    await mp.waitForTimeout(300);
    await mp.screenshot({ path: path.join(OUT, '12-settings-theme-dark-mobile.png') });
    await mp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await mp.waitForTimeout(1200);
    await mp.screenshot({ path: path.join(OUT, '13-chat-dark-mobile.png') });
    report.push(`모바일 다크 채팅 대비 점검: ${JSON.stringify(await contrastAudit(mp))}`);
    await mp.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' });
    await mp.waitForTimeout(900);
    await mp.screenshot({ path: path.join(OUT, '14-more-dark-mobile.png') });
    await mp.goto(`${BASE}/monitor`, { waitUntil: 'domcontentloaded' });
    await mp.waitForTimeout(1400);
    await mp.screenshot({ path: path.join(OUT, '15-monitor-dark-mobile.png') });

    // 9) 다크 유지 확인 스크린샷 한 장 더 (재접속)
    await mp.reload({ waitUntil: 'domcontentloaded' });
    await mp.waitForTimeout(1200);
    await mp.screenshot({ path: path.join(OUT, '16-monitor-dark-mobile-reload.png') });
  } finally {
    await browser.close();
    await stop(child);
  }
  console.log(report.join('\n'));
  console.log(`\n스크린샷: ${OUT}`);
  fs.writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n', 'utf8');
}

main().catch((err) => {
  console.error('FAILED', err);
  process.exit(1);
});
