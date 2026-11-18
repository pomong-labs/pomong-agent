/* 브라우저 워커 연결 테스트 (임시 컨테이너 안에서 실행) */
const { chromium } = require('/app/node_modules/playwright-core');

(async () => {
  const url = process.env.BROWSER_WS_URL || 'ws://browser:9222/';
  console.log('connecting', url);
  const t0 = Date.now();
  const browser = await chromium.connect(url, { timeout: 30000 });
  console.log('connected in', Date.now() - t0, 'ms');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('https://example.com', { timeout: 30000 });
  console.log('title', await page.title());
  const shot = await page.screenshot({ type: 'jpeg', quality: 60 });
  console.log('screenshot bytes', shot.length, 'magic', shot.slice(0, 2).toString('hex'));
  await page.goto('https://www.wikipedia.org', { timeout: 40000 });
  console.log('wiki title', await page.title());
  const shot2 = await page.screenshot({ type: 'jpeg', quality: 60 });
  console.log('wiki screenshot bytes', shot2.length);
  await ctx.close();
  await browser.close();
  console.log('OK');
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
