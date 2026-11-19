/**
 * v0.6.1 핫픽스 스모크 테스트
 *
 *   npx tsx scripts/smoke-v061.ts
 *
 * 실제 외부 사이트 없이 검증할 수 있는 핵심 로직만 확인한다.
 *   1) 알림창(alert/confirm) 내용 포착 — alert는 확인, confirm은 취소
 *   2) '이미 로그인' 판단 — 마이페이지·메시지함은 로그인됨, 로그인 버튼이 있으면 아님
 *   3) 답장·전송을 직접 부탁했는지 판단 + 게시 버튼 허용/차단
 *   4) 금고에 계정이 있는데 잠긴 상태 → 로그인 카드 대신 PIN 카드 1장만
 *   5) 로그인 카드 자동 생성이 PIN 카드 안내 문구에 걸리지 않는지
 *   6) 버전 문자열
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
  const { handleDialogEvent, judgeLoginState } = await import('../server/browser');
  const { userRequestedPublish, evaluateBrowserAction } = await import('../server/policy');
  const { APP_VERSION } = await import('../server/config');

  /* 1) 알림창 포착 ------------------------------------------------------ */
  const accepted: string[] = [];
  const dismissed: string[] = [];
  const fakePage = { on: () => undefined } as unknown as Parameters<typeof handleDialogEvent>[0];
  const alertRecord = handleDialogEvent(fakePage, {
    type: () => 'alert',
    message: () => '아이디 또는 비밀번호가 일치하지 않습니다.',
    accept: async () => {
      accepted.push('alert');
    },
    dismiss: async () => {
      dismissed.push('alert');
    },
  });
  check(
    'alert 내용이 기록된다',
    alertRecord.message.includes('비밀번호가 일치하지'),
    alertRecord.message
  );
  check('alert는 서버가 확인(accept)을 누른다', accepted.includes('alert') && !dismissed.includes('alert'));

  const confirmRecord = handleDialogEvent(fakePage, {
    type: () => 'confirm',
    message: () => '정말 삭제하시겠습니까?',
    accept: async () => {
      accepted.push('confirm');
    },
    dismiss: async () => {
      dismissed.push('confirm');
    },
  });
  check('confirm은 누르지 않고 닫는다(dismiss)', dismissed.includes('confirm') && !accepted.includes('confirm'), confirmRecord.autoAction);

  /* 2) 이미 로그인 판단 -------------------------------------------------- */
  check(
    '크몽 로그인 화면(마이페이지·메시지함, 로그인 버튼 없음)은 이미 로그인',
    judgeLoginState({ passwordField: false, loginEntryVisible: false, hints: ['마이페이지', '메시지함', '로그아웃'] })
  );
  check(
    '로그인 버튼이 보이면 로그인된 상태가 아니다',
    !judgeLoginState({ passwordField: false, loginEntryVisible: true, hints: ['마이페이지'] })
  );
  check(
    '비밀번호 칸이 있으면 로그인 화면이다',
    !judgeLoginState({ passwordField: true, loginEntryVisible: false, hints: ['로그아웃'] })
  );

  /* 3) 답장·전송 의도 ---------------------------------------------------- */
  const publishCases: [string, boolean][] = [
    ['크몽 문의에 답장 보내줘', true],
    ['메시지 확인해줘', false],
    ['그 사람한테 전송해줘', false],
    ['이 게시글에 댓글 달아줘', true],
    ['장바구니에 담아놔줘', false],
  ];
  for (const [text, expected] of publishCases) {
    check(`의도 판단: "${text}" → ${expected}`, userRequestedPublish(text) === expected);
  }
  check(
    '사용자가 부탁하지 않으면 게시·댓글 버튼은 차단',
    evaluateBrowserAction('browser_click', { text: '댓글 등록' }).confirm === true
  );
  check(
    '사용자가 부탁했으면 게시·댓글 버튼을 누를 수 있다',
    evaluateBrowserAction('browser_click', { text: '댓글 등록' }, { allowPublish: true }).confirm === false
  );
  check(
    '결제 버튼은 부탁해도 차단',
    evaluateBrowserAction('browser_click', { text: '결제하기' }, { allowPublish: true }).confirm === true
  );
  check(
    '전송 버튼은 막지 않는다',
    evaluateBrowserAction('browser_click', { text: '전송' }).confirm === false
  );
  const navigationLabels = ['게시판', '게시물 보기', '리뷰 탭', '등록증 보기', '마이페이지'];
  check(
    '단순 이동 버튼(게시판·게시물·리뷰 탭)은 막지 않는다',
    navigationLabels.every((text) => evaluateBrowserAction('browser_click', { text }).confirm === false),
    navigationLabels.join(', ')
  );

  /* 4) 금고 잠금 + 계정 있음 → PIN 카드 1장만 --------------------------- */
  const vault = await import('../server/vault');
  const tools = await import('../server/tools');
  vault.initVault('1234');
  vault.createItem({ title: '크몽', type: 'login', username: 'hyunjun5216@naver.com', secret: 'dummy-pass', notes: 'kmong.com' });
  vault.lockVault();
  const loginCardsBefore = (db.prepare('SELECT COUNT(*) AS n FROM login_requests').get() as { n: number }).n;
  const result = await tools.runTool(
    'vault_request_login',
    { service: '크몽', login_url: 'https://kmong.com/', site_host: 'kmong.com' },
    { session: 'smoke', userRequest: '크몽 메시지 확인해줘' }
  );
  const loginCardsAfter = (db.prepare('SELECT COUNT(*) AS n FROM login_requests').get() as { n: number }).n;
  const unlockCards = (db.prepare('SELECT COUNT(*) AS n FROM vault_unlock_requests').get() as { n: number }).n;
  check('금고에 계정이 있으면 로그인 카드를 만들지 않는다', loginCardsAfter === loginCardsBefore, `카드 ${loginCardsBefore}→${loginCardsAfter}`);
  check('금고 PIN 해제 카드 1장이 뜬다', unlockCards === 1, `PIN 카드 ${unlockCards}장`);
  check(
    'PIN 카드만 안내한다',
    /PIN/.test(result.content) && result.flags?.vaultLockedCardCreated === true,
    result.content.slice(0, 80)
  );

  /* 새 계정 추가를 직접 부탁하면 로그인 카드를 만든다 */
  const added = await tools.runTool(
    'vault_request_login',
    { service: '크몽', login_url: 'https://kmong.com/', site_host: 'kmong.com' },
    { session: 'smoke', userRequest: '크몽 새 계정 추가 등록해줘' }
  );
  const loginCardsAfterAdd = (db.prepare('SELECT COUNT(*) AS n FROM login_requests').get() as { n: number }).n;
  check('새 계정 추가를 부탁하면 로그인 카드를 만든다', loginCardsAfterAdd === loginCardsBefore + 1, added.content.slice(0, 60));

  /* 5) 로그인 카드 자동 생성이 PIN 카드 문구에 걸리지 않는다 ------------ */
  const loginRequests = await import('../server/login-requests');
  const pinWording = loginRequests.ensureLoginCard({
    sessionId: 'smoke2',
    prompt: '크몽 메시지 확인해줘',
    reply: '금고가 잠겨 있어요. 아래 카드에 금고 PIN을 입력해 주시면 바로 이어서 로그인할게요!',
    vaultEmptyTerm: null,
    cardCreatedThisTurn: false,
  });
  check('"카드에 금고 PIN 입력" 문구로 로그인 카드가 생기지 않는다', pinWording.card === null);
  const lockedTurn = loginRequests.ensureLoginCard({
    sessionId: 'smoke3',
    prompt: '크몽 메시지 확인해줘',
    reply: '아래 로그인 카드에 계정 정보를 입력해 주세요.',
    vaultEmptyTerm: '크몽',
    cardCreatedThisTurn: false,
    lockedCardThisTurn: true,
  });
  check('PIN 카드가 나간 턴에는 로그인 카드를 만들지 않는다', lockedTurn.card === null);

  /* 6) 버전 -------------------------------------------------------------- */
  check('버전 0.6.1', APP_VERSION === '0.6.1', APP_VERSION);

  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
