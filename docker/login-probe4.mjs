#!/usr/bin/env node
/**
 * 서비스별 로그인 흐름 재점검 (v0.6.0 개발용 · 개선판 로직)
 *   SITE="kmong|google|naver|musinsa" docker exec -w /app -e SITE=... pomong-browser node login-probe4.mjs
 *
 * 개선 내용을 그대로 흉내 낸다.
 *   ① 로그인 화면이 없으면 "로그인" 글자를 정확히 가진 요소를 눌러 연다(역할 기반 → 텍스트 기반)
 *   ② 아이디/비밀번호 칸을 찾고, 비밀번호 칸이 없으면 아이디 칸이 있는 폼 안에서만 버튼을 고른다
 *   ③ 입력 → input/change/blur → 버튼 disabled 해제 대기 → 클릭(실패 시 폼 제출 → Enter)
 * 더미 값만 쓰고, 결과 화면에 실제로 무엇이 떴는지(오류·캡차·OTP)를 남긴다.
 */
import { chromium } from 'playwright';

const DUMMY_ID = 'pomongprobe01';
const DUMMY_PW = 'PomongProbe!2026';

const SITES = {
  musinsa: { url: 'https://www.musinsa.com/', openLogin: true },
  kmong: { url: 'https://kmong.com/', openLogin: true },
  google: { url: 'https://accounts.google.com/signin' },
  naver: { url: 'https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fwww.naver.com' },
  github: { url: 'https://github.com/login' },
};

const site = SITES[process.env.SITE || 'kmong'] || SITES.kmong;

function detect() {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const all = Array.from(document.querySelectorAll('input'));
  const usable = all.filter(
    (el) => visible(el) && !el.disabled && el.type !== 'hidden' && !['checkbox', 'radio', 'submit', 'button'].includes(el.type)
  );
  const password = usable.find((el) => el.type === 'password') || null;
  let username = null;
  if (password) {
    const index = all.indexOf(password);
    for (let i = index - 1; i >= 0; i -= 1) {
      const el = all[i];
      if (!visible(el) || el.disabled) continue;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['text', 'email', 'tel', 'search', 'number', ''].includes(type)) {
        username = el;
        break;
      }
    }
  }
  if (!username) {
    username =
      usable.find((el) => /아이디|이메일|id|email|login|username|account/i.test(`${el.name} ${el.id} ${el.placeholder}`)) || null;
  }
  const anchor = password || username;
  const formScope = anchor?.closest('form, [role=dialog], [class*=modal], [class*=Modal], [class*=layer], [class*=Layer]') || null;
  let submit = null;
  let submitText = null;
  if (anchor) {
    const scope = formScope || document;
    const candidates = Array.from(scope.querySelectorAll('button, input[type=submit], [role=button], a')).filter(visible);
    const label = (el) => `${(el.textContent || '').trim()} ${el.getAttribute('aria-label') || ''} ${el.value || ''}`.replace(/\s+/g, ' ').trim();
    const score = (el) => {
      const text = label(el);
      if (!text || text.length > 24) return -99;
      let s = 0;
      if (el.type === 'submit' || el.tagName === 'INPUT') s += 5;
      if (/^(로그인|로그 인|login|log in|sign in|signin|continue|계속|다음|next)$/i.test(text)) s += 6;
      else if (/(로그인|login|log in|sign in)/i.test(text)) s += 3;
      if (/회원가입|가입|sign ?up|찾기|카카오|네이버|애플|구글|페이스북|비회원|kakao|naver|apple|google|facebook/i.test(text)) s -= 8;
      if (anchor.closest('form') && el.closest('form') === anchor.closest('form')) s += 4;
      return s;
    };
    const ranked = candidates.map((el) => ({ el, s: score(el) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    submit = ranked[0]?.el || null;
    submitText = submit ? label(submit).slice(0, 20) : null;
  }
  const mark = (el, name) => {
    if (!el) return null;
    el.setAttribute('data-probe', name);
    return `[data-probe="${name}"]`;
  };
  return {
    username: mark(username, 'id'),
    password: mark(password, 'pw'),
    submit: mark(submit, 'submit'),
    submitText,
    submitDisabled: submit ? Boolean(submit.disabled) || submit.getAttribute('aria-disabled') === 'true' : null,
    formScoped: Boolean(formScope),
  };
}

async function openLoginModal(page) {
  if ((await page.locator('input[type=password]').count().catch(() => 0)) > 0) return 'already';
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
      if ((await page.locator('input[type=password]').count().catch(() => 0)) > 0) return `opened:${role}`;
    }
  }
  // v0.6.0: 역할 정보가 없는 사이트(무신사·크몽) — 글자가 정확히 "로그인"인 요소를 직접 누른다.
  for (const name of ['로그인', '로그 인', 'Login', 'Sign in']) {
    const locator = page.getByText(name, { exact: true });
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i += 1) {
      const el = locator.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1800);
      if ((await page.locator('input[type=password]').count().catch(() => 0)) > 0) return `opened:text:${name}`;
    }
  }
  return 'not-found';
}

async function fillLikeServer(page, selector, value) {
  const handle = page.locator(selector).first();
  if (!(await handle.count())) return false;
  await handle.click({ timeout: 5000 }).catch(() => undefined);
  await handle.fill('').catch(() => undefined);
  await handle.pressSequentially(value, { delay: 12 }).catch(() => undefined);
  await handle
    .evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    })
    .catch(() => undefined);
  await handle.blur().catch(() => undefined);
  return true;
}

async function waitEnabled(page, selector, timeoutMs = 6000) {
  const button = page.locator(selector).first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await button.isEnabled().catch(() => false)) return true;
    await page.waitForTimeout(200);
  }
  return button.isEnabled().catch(() => false);
}

const connection = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = connection.contexts()[0];
const page = context.pages()[0] || (await context.newPage());
const out = { site: process.env.SITE || 'kmong', steps: [] };

try {
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  out.landed = page.url();
  if (site.openLogin) {
    out.modal = await openLoginModal(page);
    await page.waitForTimeout(1200);
  }
  out.beforeUrl = page.url();
  out.refs = await page.evaluate(detect);
  if (out.refs.username) out.steps.push('아이디 입력: ' + (await fillLikeServer(page, out.refs.username, DUMMY_ID)));
  if (out.refs.password) out.steps.push('비밀번호 입력: ' + (await fillLikeServer(page, out.refs.password, DUMMY_PW)));
  await page.waitForTimeout(1200);
  out.refsAfter = await page.evaluate(detect);
  out.enabled = out.refsAfter.submit ? await waitEnabled(page, out.refsAfter.submit, 6000) : null;
  if (out.refsAfter.submit && out.enabled) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined),
      page.locator(out.refsAfter.submit).first().click({ timeout: 8000 }).catch((e) => (out.clickError = String(e.message).slice(0, 120))),
    ]);
    out.steps.push('로그인 버튼 클릭');
    await page.waitForTimeout(3000);
  }
  out.afterUrl = page.url();
  out.after = await page.evaluate(() => ({
    title: document.title,
    passwordFields: document.querySelectorAll('input[type=password]').length,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
  }));
} catch (err) {
  out.error = String(err.message || err).slice(0, 250);
}

console.log(JSON.stringify(out, null, 2));
await connection.close().catch(() => undefined);
