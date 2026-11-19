#!/usr/bin/env node
/**
 * 로그인 폼 구조 점검기 (v0.6.0 개발용)
 *
 * 브라우저 워커 컨테이너 **안에서** 실행한다(같은 화면·같은 환경).
 *   docker cp docker/login-probe.mjs pomong-browser:/tmp/login-probe.mjs
 *   docker exec pomong-browser node /tmp/login-probe.mjs [url ...]
 *
 * 실제 계정 정보는 쓰지 않는다. 아무 의미 없는 더미 아이디/비밀번호로
 *   ① 입력칸·버튼 구조 ② 로그인 버튼의 disabled 상태(입력 전/후)
 *   ③ 클릭 후 화면 변화(오류 문구·캡차·OTP·2단계)
 * 만 확인해, `browser_login_with_vault`가 어디서 막히는지 근거를 남긴다.
 */
import { chromium } from 'playwright';

const DEFAULT_SITES = [
  { name: '무신사', url: 'https://member.one.musinsa.com/login' },
  { name: '크몽', url: 'https://kmong.com/', openLogin: true },
  { name: '구글', url: 'https://accounts.google.com/signin/v2/identifier?hl=ko&flowName=GlifWebSignIn&flowEntry=ServiceLogin' },
  { name: '깃허브', url: 'https://github.com/login' },
  { name: '네이버', url: 'https://nid.naver.com/nidlogin.login' },
];

const DUMMY_ID = 'pomongprobe01';
const DUMMY_PW = 'PomongProbe!2026';

function analyze() {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const inputs = Array.from(document.querySelectorAll('input'))
    .filter((el) => el.type !== 'hidden' && visible(el))
    .slice(0, 14)
    .map((el, i) => ({
      i,
      type: el.type,
      name: el.name || '',
      id: el.id || '',
      placeholder: el.placeholder || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      disabled: Boolean(el.disabled),
      value: el.type === 'password' ? (el.value ? '***' : '') : el.value.slice(0, 24),
    }));
  const buttons = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a'))
    .filter((el) => visible(el))
    .slice(0, 24)
    .map((el) => ({
      text: ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim().slice(0, 30),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      id: el.id || '',
      cls: (el.className || '').toString().slice(0, 40),
    }))
    .filter((b) => b.text || b.type === 'submit');
  return {
    url: location.href,
    title: document.title,
    forms: document.querySelectorAll('form').length,
    iframes: document.querySelectorAll('iframe').length,
    inputs,
    buttons,
    bodyHint: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
  };
}

/** 우리 서버의 detectLoginRefs와 같은 규칙으로 아이디/비밀번호/버튼을 고른다. */
function pickRefs() {
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
      usable.find((el) =>
        /아이디|이메일|id|email|login|username|account/i.test(`${el.name} ${el.id} ${el.placeholder}`)
      ) || null;
  }
  const scope = password?.closest('form, [role=dialog], [class*=modal], [class*=Modal], [class*=layer], [class*=Layer]') || document;
  const candidates = Array.from(scope.querySelectorAll('button, input[type=submit], [role=button], a')).filter(visible);
  const label = (el) => `${(el.textContent || '').trim()} ${el.getAttribute('aria-label') || ''} ${el.value || ''}`.replace(/\s+/g, ' ').trim();
  const score = (el) => {
    const text = label(el);
    if (!text || text.length > 24) return -99;
    let s = 0;
    if (el.type === 'submit' || el.tagName === 'INPUT') s += 5;
    if (/^(로그인|로그 인|login|log in|sign in|signin|continue|계속|다음)$/i.test(text)) s += 6;
    else if (/(로그인|login|log in|sign in)/i.test(text)) s += 3;
    if (/회원가입|가입|sign ?up|찾기|카카오|네이버|애플|구글|페이스북|비회원|kakao|naver|apple|google|facebook/i.test(text)) s -= 8;
    if (password && el.closest('form') === password.closest('form')) s += 4;
    return s;
  };
  const ranked = candidates.map((el) => ({ el, s: score(el) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const submit = ranked[0]?.el || password?.closest('form')?.querySelector('button[type=submit]') || null;
  const mark = (el, name) => {
    if (!el) return null;
    el.setAttribute('data-probe', name);
    return `[data-probe="${name}"]`;
  };
  return {
    username: mark(username, 'id'),
    password: mark(password, 'pw'),
    submit: mark(submit, 'submit'),
    submitText: submit ? (submit.textContent || submit.value || '').trim().slice(0, 20) : null,
    submitDisabled: submit ? Boolean(submit.disabled) || submit.getAttribute('aria-disabled') === 'true' : null,
  };
}

async function fillLikeServer(page, selector, value) {
  const handle = page.locator(selector).first();
  if (!(await handle.count())) return false;
  await handle.scrollIntoViewIfNeeded().catch(() => undefined);
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

const connection = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = connection.contexts()[0];
const page = context.pages()[0] || (await context.newPage());

const sites = process.argv.slice(2).length
  ? process.argv.slice(2).map((url) => ({ name: url, url }))
  : DEFAULT_SITES;

const results = [];
for (const site of sites) {
  const result = { site: site.name, url: site.url, steps: [] };
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1800);
    if (site.openLogin) {
      const loginButton = page.getByRole('button', { name: /^(로그인|로그 인|login)$/i }).first();
      if (await loginButton.count().catch(() => 0)) {
        await loginButton.click({ timeout: 6000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
      }
    }
    result.before = await page.evaluate(analyze);
    result.refsBefore = await page.evaluate(pickRefs);

    if (result.refsBefore.username) {
      await fillLikeServer(page, result.refsBefore.username, DUMMY_ID);
      result.steps.push('아이디 입력');
    }
    if (result.refsBefore.password) {
      await fillLikeServer(page, result.refsBefore.password, DUMMY_PW);
      result.steps.push('비밀번호 입력');
    }
    await page.waitForTimeout(1200);
    result.refsAfterFill = await page.evaluate(pickRefs);
    result.afterFill = await page.evaluate(analyze);

    if (result.refsAfterFill.submit) {
      const submit = page.locator(result.refsAfterFill.submit).first();
      const enabled = await submit.isEnabled().catch(() => false);
      result.submitEnabledAfterFill = enabled;
      if (enabled) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined),
          submit.click({ timeout: 8000 }).catch((err) => {
            result.clickError = String(err.message || err).slice(0, 200);
          }),
        ]);
        result.steps.push('로그인 버튼 클릭');
        await page.waitForTimeout(2500);
      } else {
        // 잠겨 있으면 폼으로 직접 제출해 본다(우리 서버의 폴백과 같은 경로)
        const sent = await page
          .locator(result.refsAfterFill.password || result.refsAfterFill.username || 'form')
          .first()
          .evaluate((el) => {
            const form = el.closest('form');
            if (!form) return false;
            form.requestSubmit();
            return true;
          })
          .catch(() => false);
        result.formSubmitFallback = sent;
        result.steps.push(sent ? '버튼 잠김 → 폼 제출 폴백' : '버튼 잠김 · 폼 없음');
        await page.waitForTimeout(2500);
      }
    }
    result.after = await page.evaluate(analyze);
  } catch (err) {
    result.error = String(err.message || err).slice(0, 300);
  }
  results.push(result);
  // 사이트 사이에는 빈 페이지로 돌아간다.
  await page.goto('about:blank').catch(() => undefined);
}

console.log(JSON.stringify(results, null, 2));
await connection.close().catch(() => undefined);
