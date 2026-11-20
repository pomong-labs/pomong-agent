/**
 * v0.6.2 실제 브라우저 검증 (임시 DATA_DIR · 실제 Chromium)
 *
 *   node /app/e2e-062.js
 *
 * 확인 항목
 *   1) AI 없이 브라우저 바로 열기 — 세션이 열리고 제어권이 사용자에게 온다
 *   2) 바로 열면서 주소까지 지정하면 그 주소로 이동한다
 *   3) 주소창 이동(navigateUser) — https 자동 보정·형식 오류 안내
 *   4) 이미 로그인된 화면이면 browser_open 결과에 로그인 상태 안내가 실린다
 *   5) 로그인 버튼이 보이는 화면에는 그 안내가 실리지 않는다
 */
const http = require('node:http');

const PORT = 8899;
// 도커 네트워크 별칭(pomong-e2e.test)으로 접근한다 — 주소 정규화가 점(.) 있는 호스트만 허용한다.

const inboxPage = `<!doctype html><html><head><title>내 메시지함</title></head><body>
<header>
  <a href="/mypage">마이페이지</a>
  <a href="/messages" id="messages">메시지함</a>
  <a href="/logout" id="logout">로그아웃</a>
</header>
<h1>내 메시지함</h1>
<ul><li>문의: 옷 사이즈 문의드립니다</li></ul>
</body></html>`;

const fakeLoginPage = `<!doctype html><html><head><title>메인</title></head><body>
<header><a href="/mypage">마이페이지</a><a href="/login" id="loginBtn">로그인</a></header>
<h1>메인</h1>
</body></html>`;

const plainPage = `<!doctype html><html><head><title>일반 화면</title></head><body><h1>일반 화면</h1><a href="/">홈</a></body></html>`;

const routes = {
  '/inbox': inboxPage,
  '/fake-login': fakeLoginPage,
  '/plain': plainPage,
};

async function main() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(routes[url] || plainPage);
  });
  await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));

  const browser = require('/app/server-dist/browser.js');
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const base = `http://pomong-e2e.test:${PORT}`;

  try {
    // 1) AI 없이 바로 열기 + 주소 지정 -----------------------------------
    const opened = await browser.openForUser({ url: `${base}/inbox` });
    check('AI 없이 열면 세션이 열린다', Boolean(opened.session && opened.session.id), opened.session && opened.session.id);
    check('제어권이 사용자에게 온다(내가 조작)', opened.session.controlOwner === 'user', opened.session.controlOwner);
    check('바로 열면서 지정한 주소로 이동한다', String(opened.url || '').includes('/inbox'), String(opened.url));

    // 2) 주소창 이동 ------------------------------------------------------
    const moved = await browser.navigateUser(opened.session.id, `${base}/plain`);
    check('주소창 이동이 실제 페이지를 바꾼다', moved.url.includes('/plain') && moved.title === '일반 화면', `${moved.url} · ${moved.title}`);
    let badAddress = '';
    try {
      await browser.navigateUser(opened.session.id, '날씨 알려줘');
    } catch (err) {
      badAddress = err instanceof Error ? err.message : String(err);
    }
    check('주소가 아닌 입력은 안내 문구로 거절한다', /주소 형식/.test(badAddress), badAddress);
    check('https 자동 보정(도메인만 입력)', browser.normalizeAddress('naver.com').url === 'https://naver.com/', browser.normalizeAddress('naver.com').url);

    // 3) 에이전트로 넘긴 뒤 '이미 로그인' 안내 ---------------------------
    await browser.resumeFromHandover(opened.session.id);
    const logged = await browser.openUrl(`${base}/inbox`);
    check(
      '이미 로그인된 화면이면 open 결과에 로그인 상태 안내가 실린다',
      logged.snapshot.includes('[로그인 상태: 이미 로그인되어 있습니다'),
      (logged.snapshot.match(/\[로그인 상태[^\]]*\]/g) || [''])[0]
    );
    check('안내 문구가 로그인 버튼을 누르지 말라고 말한다', logged.snapshot.includes('로그인 버튼을 누르지 말고'));

    const notLogged = await browser.openUrl(`${base}/fake-login`);
    check(
      '로그인 버튼이 보이는 화면에는 그 안내가 없다',
      !notLogged.snapshot.includes('[로그인 상태: 이미 로그인되어 있습니다')
    );
  } finally {
    await browser.closeSession().catch(() => undefined);
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? `❌ 실패 ${failed.length}건` : '✅ 전부 통과'}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E 오류:', err && err.message ? err.message : err);
  process.exit(1);
});
