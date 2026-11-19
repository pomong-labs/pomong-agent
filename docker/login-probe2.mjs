#!/usr/bin/env node
/**
 * 로그인 URL·모달 탐색 점검 (v0.6.0 개발용)
 *   docker cp docker/login-probe2.mjs pomong-browser:/app/login-probe2.mjs
 *   docker exec -w /app pomong-browser node login-probe2.mjs
 *
 * - 서비스별 후보 주소를 열어 실제로 로그인 폼이 있는 곳을 찾는다.
 * - "로그인" 버튼을 눌러 모달이 열리는지(openLoginModal 로직) 확인한다.
 */
import { chromium } from 'playwright';

const TARGETS = [
  { name: 'musinsa:/login', url: 'https://www.musinsa.com/login' },
  { name: 'musinsa:main', url: 'https://www.musinsa.com/', openLogin: true },
  { name: 'musinsa:member', url: 'https://member.musinsa.com/login' },
  { name: 'kmong:main', url: 'https://kmong.com/', openLogin: true },
  { name: 'google:signin', url: 'https://accounts.google.com/signin' },
  { name: 'naver:nidlogin', url: 'https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fwww.naver.com' },
];

function inspect() {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const inputs = Array.from(document.querySelectorAll('input'))
    .filter((el) => el.type !== 'hidden' && visible(el))
    .slice(0, 10)
    .map((el) => ({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder }));
  const loginCandidates = Array.from(document.querySelectorAll('a,button,[role=button]'))
    .filter((el) => visible(el))
    .map((el) => ((el.innerText || el.getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim())
    .filter((t) => /^(로그인|로그 인|login|sign in|signin|로그인\/회원가입|로그인 · 회원가입)$/i.test(t))
    .slice(0, 6);
  return { url: location.href, title: document.title, inputs, loginCandidates, forms: document.querySelectorAll('form').length };
}

async function openLoginModal(page) {
  const hasPassword = async () => (await page.locator('input[type=password]').count().catch(() => 0)) > 0;
  if (await hasPassword()) return 'already';
  const exact = /^(로그인|로그 인|로그인하기|login|log in|sign in|signin)$/i;
  for (const role of ['button', 'link', 'tab']) {
    const locator = page.getByRole(role, { name: exact });
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 6); i += 1) {
      const el = locator.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const label = `${(await el.innerText().catch(() => '')) || ''} ${(await el.getAttribute('aria-label').catch(() => '')) || ''}`.trim();
      if (/회원가입|가입|sign ?up|찾기/i.test(label)) continue;
      await el.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      if (await hasPassword()) return `opened:${role}:${label.slice(0, 20)}`;
    }
  }
  return 'not-found';
}

const connection = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = connection.contexts()[0];
const page = context.pages()[0] || (await context.newPage());
const results = [];

for (const target of TARGETS) {
  const row = { name: target.name };
  try {
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    row.status = response?.status() ?? null;
    row.redirectedTo = page.url();
    if (target.openLogin) row.modal = await openLoginModal(page);
    row.after = await page.evaluate(inspect);
  } catch (err) {
    row.error = String(err.message || err).slice(0, 200);
  }
  results.push(row);
  await page.goto('about:blank').catch(() => undefined);
}

console.log(JSON.stringify(results, null, 2));
await connection.close().catch(() => undefined);
