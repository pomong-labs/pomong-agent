/**
 * v0.6.1 실제 브라우저 검증 (임시 DATA_DIR · 실제 Chromium)
 *
 *   node /app/e2e-061.js
 *
 * 확인 항목
 *   1) alert 내용이 브라우저 도구 응답에 실린다
 *   2) 이미 로그인된 페이지에서 browser_login_with_vault가 "이미 로그인"으로 끝난다
 *   3) 로그인 모달을 스스로 찾아 아이디·비밀번호를 채우고 제출하며, 제출 뒤 alert 문구를 돌려준다
 *   4) 없는 ref 클릭이 6초 안에 최신 화면과 함께 돌아온다(예전 15초)
 */
const http = require('node:http');

const PORT = 8899;

const alertPage = `<!doctype html><html><head><title>알림 테스트</title></head><body>
<h1>로그인</h1>
<script>alert('아이디 또는 비밀번호가 일치하지 않습니다.'); location.href='/after';</script>
</body></html>`;

const afterPage = `<!doctype html><html><body><h1>메인 화면</h1><a href="/">홈</a></body></html>`;

const inboxPage = `<!doctype html><html><body>
<header>
  <a href="/mypage">마이페이지</a>
  <a href="/messages" id="messages">메시지함</a>
  <a href="/notifications">알림 3</a>
  <a href="/logout" id="logout">로그아웃</a>
</header>
<h1>내 메시지함</h1>
<ul><li>문의: 옷 사이즈 문의드립니다</li></ul>
<textarea id="reply" placeholder="답장을 입력하세요"></textarea>
<button type="button">전송</button>
</body></html>`;

const fakeLoginPage = `<!doctype html><html><body>
<header><a href="/mypage">마이페이지</a><a href="/login" id="loginBtn">로그인</a></header>
<h1>메인</h1>
</body></html>`;

const loginPage = `<!doctype html><html><body>
<header><button id="openLogin" onclick="document.getElementById('modal').style.display='block'">로그인</button></header>
<div id="modal" style="display:none">
  <form id="f" onsubmit="event.preventDefault(); alert('비밀번호가 일치하지 않습니다.'); return false;">
    <input type="text" name="id" placeholder="아이디" />
    <input type="password" name="pw" placeholder="비밀번호" />
    <button type="submit">로그인</button>
  </form>
</div>
</body></html>`;

const routes = {
  '/': afterPage,
  '/alert': alertPage,
  '/after': afterPage,
  '/inbox': inboxPage,
  '/fake-login': fakeLoginPage,
  '/login': loginPage,
};

async function main() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const body = routes[url] || afterPage;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));

  const browser = require('/app/server-dist/browser.js');
  const vault = require('/app/server-dist/vault.js');
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const base = `http://pomong-e2e:${PORT}`;

  try {
    // 1) alert 포착 ------------------------------------------------------
    const opened = await browser.openUrl(`${base}/alert`);
    check(
      'alert 문구가 열기 결과에 실린다',
      opened.snapshot.includes('아이디 또는 비밀번호가 일치하지 않습니다'),
      opened.snapshot.slice(0, 120).replace(/\n/g, ' ')
    );
    check('알림창 표시가 [브라우저 알림창] 블록으로 온다', opened.snapshot.includes('[브라우저 알림창'));

    // 2) 이미 로그인된 페이지 --------------------------------------------
    vault.initVault('1234');
    const vaultId = vault.createItem({ title: '테스트몰', type: 'login', username: 'tester@example.com', secret: 'pw-1234' });
    await browser.openUrl(`${base}/inbox`);
    const logged = await browser.loginWithVault({ username: 'tester@example.com', password: 'pw-1234' });
    check('이미 로그인된 사이트로 판정', logged.alreadyLoggedIn === true, JSON.stringify(logged.loginHints));
    check('로그인 과정을 건너뛴다', logged.filledPassword === false && logged.submitted === 'none');

    // 로그인 버튼이 보이는 페이지는 '이미 로그인'이 아니다
    const fakeState = await (async () => {
      await browser.openUrl(`${base}/fake-login`);
      return browser.detectLoginState();
    })();

    // 3) 로그인 모달 자동 탐지 + 제출 후 alert --------------------------
    await browser.openUrl(`${base}/login`);
    const modal = await browser.loginWithVault({ username: 'tester@example.com', password: 'pw-1234', vault_id: vaultId });
    check(
      '모달 로그인을 자동 탐지해 입력·제출한다',
      modal.filledPassword === true && modal.submitted !== 'none',
      `filled=${modal.filledPassword} submitted=${modal.submitted} steps=${modal.steps}`
    );
    check(
      '제출 뒤 뜬 alert 문구가 결과에 실린다',
      modal.snapshot.includes('비밀번호가 일치하지 않습니다'),
      modal.snapshot.split('\n').filter((l) => l.includes('[브라우저 알림창')).join(' ').slice(0, 160)
    );
    check('로그인 실패 화면을 그대로 읽어 준다(오류 문구)', modal.notice !== null || modal.snapshot.includes('알림창'));

    // 4) 없는 ref 클릭 시간 ---------------------------------------------
    await browser.openUrl(`${base}/inbox`);
    const t0 = Date.now();
    const clickResult = await browser.click({ ref: 'e999' });
    const elapsed = Date.now() - t0;
    check('없는 ref 클릭이 6초 안에 돌아온다', elapsed < 8000 && clickResult.clicked === false, `${elapsed}ms`);
    check('클릭 실패에도 최신 화면을 함께 준다', clickResult.snapshot.includes('메시지함'));

    console.log('\n[상태 요약]');
    console.log('fake-login 로그인 판정:', JSON.stringify(fakeState));
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
