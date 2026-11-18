// 앱 UI 스크린샷 (임시 컨테이너 pa-e2e:3100 에 로그인해서 찍는다)
const { chromium } = require('/app/node_modules/playwright');

const BASE = process.env.APP_BASE || 'http://pa-e2e:3100';
const OUT = process.env.OUT || '/out';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder="아이디"]', 'e2e');
  await page.fill('input[placeholder="비밀번호"]', 'e2e-test-pass');
  await Promise.all([page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 }), page.click('button[type="submit"]')]);
  await page.waitForTimeout(1500);

  await page.goto(`${BASE}/automation`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/automation-pc.png`, fullPage: false });

  await page.goto(`${BASE}/browser`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/browser-pc.png`, fullPage: false });

  // 모바일 뷰
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' });
  const mp = await mobile.newPage();
  await mp.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await mp.fill('input[placeholder="아이디"]', 'e2e');
  await mp.fill('input[placeholder="비밀번호"]', 'e2e-test-pass');
  await Promise.all([mp.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 }), mp.click('button[type="submit"]')]);
  await mp.waitForTimeout(1200);
  await mp.goto(`${BASE}/automation`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(1200);
  await mp.screenshot({ path: `${OUT}/automation-mobile.png` });
  await mp.goto(`${BASE}/browser`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(3000);
  await mp.screenshot({ path: `${OUT}/browser-mobile.png` });

  console.log('shots done');
  await browser.close();
})().catch((err) => {
  console.error('SHOT FAILED', err.message);
  process.exit(1);
});
