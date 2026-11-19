/**
 * v0.6.0 스모크 테스트
 *
 *   npx tsx scripts/smoke-v060.ts
 *
 * 실제 외부 API 없이 검증할 수 있는 핵심 로직만 확인한다.
 *   1) 과거 대화 FTS5 검색(방을 넘어서, 한국어 부분 문자열)
 *   2) 동시 작업 큐: 대화가 예약 작업 뒤에서 기다리지 않는다 + 브라우저 뮤텍스
 *   3) 서버 감시: 정상일 때 무알림, 임계값 판정
 *   4) 로그인 화면 판별(캡차·OTP·비밀번호 오류)과 noVNC 토큰
 *   5) 버전 문자열
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-'));
process.env.DATA_DIR = tmp;
process.env.BROWSER_ENABLED = '0';
process.env.MONITOR_ENABLED = '0';
process.env.HOST_LOG_DIR = path.join(tmp, 'hostlog');
process.env.DOCKER_SOCKET = path.join(tmp, 'no-docker.sock');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const { db } = await import('../server/db');
  const history = await import('../server/history');
  const { runInLane, browserLock, queueSnapshot } = await import('../server/queue');
  const { classifyLoginScreen } = await import('../server/browser');
  const { issueVncToken } = await import('../server/vnc-proxy');
  const monitor = await import('../server/monitor-alert');
  const { APP_VERSION } = await import('../server/config');

  /* 1) 과거 대화 검색 -------------------------------------------------- */
  const insert = db.prepare('INSERT INTO messages(session_id, role, content, created_at) VALUES(?,?,?,?)');
  insert.run('room-a', 'user', '무신사 로그인은 금고 계정으로 해줘', new Date().toISOString());
  insert.run('room-b', 'assistant', '깃허브 로그인은 자동으로 끝냈어요', new Date().toISOString());
  insert.run('room-b', 'user', '내 생일은 3월 26일이야', new Date().toISOString());
  const found = history.searchChatHistory('무신사', { limit: 5 });
  check('FTS5 대화 검색(방 구분)', found.hits.length === 1 && found.hits[0].sessionId === 'room-a', `${found.mode} ${found.hits.length}건`);
  const other = history.searchChatHistory('생일', { excludeSession: 'room-a' });
  check('다른 방 대화까지 검색', other.hits.some((h) => h.sessionId === 'room-b'));
  const short = history.searchChatHistory('무신');
  check('짧은(2글자) 질의 LIKE 폴백', short.hits.length >= 1, short.mode);
  const missing = history.searchChatHistory('존재하지않는단어');
  check('없는 말은 0건', missing.hits.length === 0);
  check('인덱스 통계', history.historyIndexStats().indexed >= 3);

  /* 2) 동시 작업 큐 ---------------------------------------------------- */
  const order: string[] = [];
  let releaseAutomation: () => void = () => undefined;
  const blocked = runInLane('automation', '예약-오래걸림', async () => {
    order.push('automation:start');
    await new Promise<void>((resolve) => {
      releaseAutomation = resolve;
    });
    order.push('automation:end');
  });
  const chat = runInLane('chat', '대화-빠름', async () => {
    order.push('chat');
    return 'ok';
  });
  const chatResult = await chat;
  check('예약 작업이 도는 중에도 대화가 먼저 끝난다', chatResult === 'ok' && order[0] === 'automation:start' && order.includes('chat') && !order.includes('automation:end'), order.join(' > '));
  releaseAutomation();
  await blocked;
  const snap = queueSnapshot();
  check('큐 레인 상태 노출', snap.lanes.length >= 4 && typeof snap.totalRunning === 'number');

  let inside = false;
  let overlap = false;
  const lock1 = browserLock('a', async () => {
    inside = true;
    await new Promise((r) => setTimeout(r, 120));
    inside = false;
  });
  const lock2 = browserLock('b', async () => {
    if (inside) overlap = true;
  });
  await Promise.all([lock1, lock2]);
  check('브라우저 뮤텍스(동시 1)', overlap === false);

  /* 3) 서버 감시 -------------------------------------------------------- */
  fs.mkdirSync(process.env.HOST_LOG_DIR as string, { recursive: true });
  const report = await monitor.runMonitorCheck();
  check('정상 상태에서 점검 통과', report.ok === true && report.findings.length === 0, `findings=${report.findings.length}`);
  check('점검 항목 기록(디스크·SSH·컨테이너)', typeof report.checks.disk.pct === 'number' && Array.isArray(report.checks.containers));

  // fail2ban 로그에 차단이 몰린 상황을 흉내 낸다.
  const now = new Date();
  const stamp = (offsetMin: number) => {
    const d = new Date(now.getTime() - offsetMin * 60_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},000`;
  };
  const lines = Array.from({ length: 40 }, (_, i) => `${stamp(i)} fail2ban.actions [1]: NOTICE  [sshd] Ban 203.0.113.${i}`).join('\n');
  fs.writeFileSync(path.join(process.env.HOST_LOG_DIR as string, 'fail2ban.log'), lines + '\n');
  const report2 = await monitor.runMonitorCheck();
  const hasF2b = report2.findings.some((f) => f.kind === 'fail2ban' || f.kind === 'ssh');
  check('fail2ban 차단 급증 감지', hasF2b, report2.findings.map((f) => f.kind).join(','));
  check('감지 시 알림 기록', monitor.monitorAlertHistory(5).length >= 1);

  /* 4) 로그인 화면 판별 ------------------------------------------------ */
  check('캡차 판별', classifyLoginScreen('로봇이 아닙니다 reCAPTCHA') === 'captcha');
  check('OTP 판별', classifyLoginScreen('인증번호 6자리를 입력해 주세요') === 'otp');
  check('비밀번호 오류 판별', classifyLoginScreen('아이디 또는 비밀번호가 일치하지 않습니다') === 'wrong_password');
  check('정상 화면은 null', classifyLoginScreen('무신사 로그인 아이디 비밀번호') === 'login' || classifyLoginScreen('상품 목록') === null);
  const token = issueVncToken('tester');
  check('noVNC 토큰 발급', Boolean(token.token) && token.expiresInSec === 60);

  /* 5) 버전 ------------------------------------------------------------ */
  check('버전 0.6.x', /^0\.6\./.test(APP_VERSION), APP_VERSION);

  console.log(failures ? `\n❌ 실패 ${failures}건` : '\n🎉 모든 스모크 통과');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

void main().catch((err) => {
  console.error('스모크 실패:', err);
  process.exit(1);
});
