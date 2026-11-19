#!/usr/bin/env node
/**
 * 무신사 로그인 진입 경로 탐색 (v0.6.0 개발용)
 *   docker cp docker/login-probe3.mjs pomong-browser:/app/login-probe3.mjs
 *   docker exec -w /app pomong-browser node login-probe3.mjs
 *
 * "로그인"을 누르는 여러 전략을 차례로 시도해, 실제로 아이디/비밀번호 칸이
 * 나타나는 경로를 찾는다. 결과는 서버의 openLoginModal 보강에 쓴다.
 */
import { chromium } from 'playwright';

const connection = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = connection.contexts()[0];
const page = context.pages()[0] || (await context.newPage());

const countPassword = async () => page.locator('input[type=password]').count().catch(() => 0);

async function reset() {
  await page.goto('https://www.musinsa.com/main/musinsa/recommend?gf=A', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
}

const strategies = [
  {
    name: 'getByText exact',
    run: async () => {
      await page.getByText('로그인', { exact: true }).first().click({ timeout: 6000 });
    },
  },
  {
    name: 'evaluate exact text click',
    run: async () => {
      await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('a,button,[role=button],span,div'));
        const target = nodes.find((el) => {
          const text = (el.textContent || '').trim();
          if (text !== '로그인') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) return false;
          // 가장 안쪽(자식에 같은 글자가 없는) 요소
          return !Array.from(el.children).some((c) => (c.textContent || '').trim() === '로그인');
        });
        if (target) target.click();
      });
    },
  },
  {
    name: 'href contains login',
    run: async () => {
      const link = page.locator('a[href*="login"], a[href*="member"]').first();
      if (await link.count()) await link.click({ timeout: 6000 });
    },
  },
  {
    name: 'getByRole button /로그인/',
    run: async () => {
      await page.getByRole('button', { name: /로그인/ }).first().click({ timeout: 6000 });
    },
  },
];

const results = [];
for (const strategy of strategies) {
  await reset();
  const before = await countPassword();
  let error = null;
  try {
    await strategy.run();
  } catch (err) {
    error = String(err.message || err).slice(0, 160);
  }
  await page.waitForTimeout(2500);
  const after = await countPassword();
  const detail = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter((el) => el.type !== 'hidden')
      .slice(0, 8)
      .map((el) => ({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder }));
    const iframes = Array.from(document.querySelectorAll('iframe')).map((el) => el.src || '(no src)').slice(0, 4);
    return { url: location.href, title: document.title, inputs, iframes };
  });
  results.push({ strategy: strategy.name, before, after, error, detail });
  // 실패하면 다음 전략을 위해 원래 화면으로 돌아간다(위 reset).
}

// iframe 안에 로그인 폼이 있는지도 확인
const frames = page.frames().map((f) => f.url()).filter(Boolean).slice(0, 8);
console.log(JSON.stringify({ results, frames }, null, 2));
await connection.close().catch(() => undefined);
