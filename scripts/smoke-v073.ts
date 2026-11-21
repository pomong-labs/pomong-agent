/**
 * v0.7.3 스모크 테스트 — 에이전트 명함 7대 개선 + 빈 화면 복구
 *
 *   npx tsx scripts/smoke-v073.ts          (빌드된 server-dist 가 필요: npm run build)
 *
 * 1) 버전 0.7.3 일원화(패키지·서버·에셋·SW·도커)
 * 2) 무손실 스키마 — delivery_mode / once_per_visitor / retention_days 가 기존 행에도 기본값으로 더해짐
 * 3) 채팅 자동 완료 — AI 완료 블록 파싱·손님 화면에서 제거·필수 항목 검사·요약 저장·submitted
 * 4) 완료 뒤 대화 잠금 — 추가 채팅은 completed 로 거절(새로고침해도 status 유지)
 * 5) qna_only — 전달·푸시 없음, 완료 블록도 무시, 제출 API 거절, 주인 화면에 대화 비노출
 * 6) 1인 1회 — 같은 방문자(IP 해시)는 다시 시작 불가, 다른 방문자는 가능
 * 7) 보관 기간 — 지난 대화·본문을 DB 에서 실제 삭제, 0(영구)은 유지
 * 8) 모델 목록 — 연결된 프로바이더만, 인증 필요
 * 9) 보안 격리 — 게스트 대화에 도구 0개·기억/금고 import 없음
 * 10) 빈 화면 복구 — 없는 /assets/*.js 는 404, /·/sw.js 는 재검증 헤더, SPA 경로는 index
 * 11) 개인정보 비노출 — 새 코드·예시에 개인 식별 정보 없음
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v073-'));
process.env.DATA_DIR = tmp;
process.env.BROWSER_ENABLED = '0';
process.env.MONITOR_ENABLED = '0';
process.env.HOST_LOG_DIR = path.join(tmp, 'hostlog');
process.env.DOCKER_SOCKET = path.join(tmp, 'no-docker.sock');

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'server-dist', 'data', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function httpGet(base: string, pathname: string, host: string): Promise<{ status: number; location: string; body: string; headers: http.IncomingHttpHeaders }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: pathname, method: 'GET', headers: { Host: host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, location: String(res.headers.location || ''), body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  /* 1) 버전 --------------------------------------------------------------- */
  console.log('\n[1] 버전 0.7.3');
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');
  const compose = read('docker-compose.yml');
  check('package.json', pkg.version === '0.7.3', pkg.version);
  check('server/config APP_VERSION', APP_VERSION === pkg.version, APP_VERSION);
  check('에셋 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check('서비스워커 VERSION', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check(
    'docker-compose 이미지 태그',
    compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`)
  );

  /* 2) 스키마 ------------------------------------------------------------- */
  console.log('\n[2] 무손실 스키마');
  const { db } = await import('../server/db');
  const cols = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
  const cardCols = cols('agent_cards');
  check(
    '새 열 3종',
    ['delivery_mode', 'once_per_visitor', 'retention_days'].every((name) => cardCols.has(name)),
    ['delivery_mode', 'once_per_visitor', 'retention_days'].map((n) => (cardCols.has(n) ? n : `✗${n}`)).join(' ')
  );
  const colInfo = (name: string) =>
    (db.prepare('PRAGMA table_info(agent_cards)').all() as { name: string; dflt_value: string | null; notnull: number }[]).find(
      (row) => row.name === name
    );
  check('delivery_mode 기본 collect', (colInfo('delivery_mode')?.dflt_value || '').includes('collect'));
  check('once_per_visitor 기본 0', String(colInfo('once_per_visitor')?.dflt_value || '').includes('0'));
  check('retention_days 기본 30', String(colInfo('retention_days')?.dflt_value || '').includes('30'));
  check('기존 테이블 보존', cols('users').has('username') && cols('messages').has('content'));

  const cards = await import('../server/agent-cards');
  const brand = { agentName: '포몽', character: 'pimong' };

  /* 3) 채팅 자동 완료 ----------------------------------------------------- */
  console.log('\n[3] 채팅 자동 완료·요약');
  const completionBlock = (values: Record<string, string>) =>
    `\n[[COLLECT_DONE]]${JSON.stringify(values)}[[/COLLECT_DONE]]`;
  let replyQueue: string[] = [];
  let seenSystem = '';
  cards.setGuestLlmRunner(async (request) => {
    seenSystem = request.system;
    return { text: replyQueue.shift() || '네, 알겠습니다.', provider: 'test', model: 'test-model' };
  });

  const made = cards.createCard({
    title: '자동 완료 명함',
    purpose: 'meeting',
    bioText: '미팅을 조율합니다.',
    systemGuide: '평일 저녁만 안내한다.',
    collectFields: [
      { key: 'name', label: '이름', kind: 'text', required: true },
      { key: 'contact', label: '연락처', kind: 'text', required: true },
      { key: 'schedule', label: '희망 일시', kind: 'text', required: false },
    ],
  });
  const card = 'card' in made ? made.card : null;
  check('collect 명함 생성', Boolean(card && card.deliveryMode === 'collect' && card.retentionDays === 30), card?.deliveryMode);

  if (card) {
    replyQueue = ['성함과 연락처를 알려 주실 수 있을까요?'];
    const first = await cards.guestChat({ card, brand, message: '미팅하고 싶어요', ipHash: 'ip-auto' });
    check('완료 전에는 일반 답변', Boolean(first.ok && !first.completed && first.status === 'active'), first.status);

    // 필수(연락처)가 빠진 블록은 완료로 치지 않는다.
    replyQueue = [`말씀 감사합니다.${completionBlock({ name: '테스트 방문자' })}`];
    const partial = await cards.guestChat({
      card,
      brand,
      sessionId: first.sessionId,
      message: '테스트 방문자입니다',
      ipHash: 'ip-auto',
    });
    const partialView = partial.sessionId ? cards.getSession(partial.sessionId) : null;
    check('필수 항목 누락 블록은 완료 아님', Boolean(partial.ok && !partial.completed && partialView?.status === 'active'));
    check('완료 블록은 손님 답변에서 제거', Boolean(partial.reply && !partial.reply.includes('COLLECT_DONE')));

    replyQueue = [`확인했습니다.${completionBlock({ 이름: '테스트 방문자', 연락처: 'visitor@example.com', 희망일시: '화요일 오후 3시' })}`];
    const done = await cards.guestChat({
      card,
      brand,
      sessionId: first.sessionId,
      message: '방문자입니다. visitor@example.com, 화요일 오후 3시요',
      ipHash: 'ip-auto',
    });
    const view = done.sessionId ? cards.getSession(done.sessionId) : null;
    check('대화로 자동 완료', Boolean(done.ok && done.completed && done.status === 'submitted'), done.status);
    check('AI 마무리 인사 그대로 사용(서버 문구 미덧붙임)', done.reply === '확인했습니다.', done.reply);
    check('완료 블록 미노출', Boolean(done.reply && !done.reply.includes('COLLECT_DONE')));
    check('세션 status submitted', view?.status === 'submitted', view?.status);
    check(
      '수집 항목 구조화 저장',
      view?.structured?.name === '테스트 방문자' &&
        view?.structured?.contact === 'visitor@example.com' &&
        view?.structured?.schedule === '화요일 오후 3시',
      JSON.stringify(view?.structured || {})
    );
    check('요약 저장', Boolean(view?.summary && view.summary.includes('연락처: visitor@example.com')), view?.summary?.slice(0, 60));
    check('주인 목록 집계', cards.listCards().some((item) => item.id === card.id && item.sessions >= 1));
    check(
      '시스템 프롬프트에 완료 규칙',
      seenSystem.includes('COLLECT_DONE') && seenSystem.includes('필수') && seenSystem.includes('희망 일시')
    );

    /* 4) 완료 뒤 잠금 ------------------------------------------------------ */
    const after = await cards.guestChat({ card, brand, sessionId: done.sessionId, message: '한 가지만 더 물어볼게요', ipHash: 'ip-auto' });
    check('완료 뒤 추가 채팅 거부', !after.ok && after.code === 'completed', after.code);
    const reload = done.sessionId ? cards.publicSessionView(card, done.sessionId) : null;
    check('새로고침(조회)해도 submitted 유지', reload?.status === 'submitted');

    // AI 가 마무리 문장을 쓰지 않고 블록만 보냈을 때만 서버 fallback 한 줄
    const bareMade = cards.createCard({
      title: '빈 마무리 명함',
      purpose: 'intro',
      collectFields: [{ key: 'answer1', label: '하고 싶은 말', kind: 'text', required: false }],
    });
    const bareCard = 'card' in bareMade ? bareMade.card : null;
    if (bareCard) {
      replyQueue = [completionBlock({ answer1: '잘 쓰고 있어요' })];
      const bare = await cards.guestChat({ card: bareCard, brand, message: '하고 싶은 말은 잘 쓰고 있어요', ipHash: 'ip-bare' });
      check(
        '마무리가 비었을 때만 서버 한 줄',
        bare.completed === true && bare.reply === '말씀해 주신 내용은 정리해서 주인에게 전달했어요. 참여해 주셔서 감사합니다.',
        bare.reply
      );
    }

    // 목록에 이름·연락처가 없으면 묻지 말라는 규칙이 프롬프트에 들어 있는지
    check(
      '수집 항목 외 질문 금지 규칙',
      seenSystem.includes('오직 [받을 항목] 목록에 있는 항목만 질문') &&
        seenSystem.includes('목록에 이름·연락처가 없다면')
    );
  }

  /* 5) qna_only ----------------------------------------------------------- */
  console.log('\n[5] qna_only — 전달 없이 답변만');
  const qnaMade = cards.createCard({
    title: '자유 Q&A 명함',
    purpose: 'intro',
    bioText: '소개와 하는 일을 안내합니다.',
    deliveryMode: 'qna_only',
    retentionDays: 7,
  });
  const qnaCard = 'card' in qnaMade ? qnaMade.card : null;
  check('qna_only 생성', Boolean(qnaCard && qnaCard.deliveryMode === 'qna_only' && qnaCard.retentionDays === 7));
  if (qnaCard) {
    replyQueue = [`안내드릴게요.${completionBlock({ name: '무시', contact: 'x@example.com' })}`];
    const chat = await cards.guestChat({ card: qnaCard, brand, message: '무슨 일 하세요?', ipHash: 'ip-qna' });
    const view = chat.sessionId ? cards.getSession(chat.sessionId) : null;
    check('qna_only 답변', Boolean(chat.ok && chat.reply && chat.reply.includes('안내드릴게요')));
    check('qna_only 는 완료 블록 무시', Boolean(!chat.completed && view?.status === 'active'));
    check('qna_only 답변에도 블록 미노출', Boolean(chat.reply && !chat.reply.includes('COLLECT_DONE')));
    check('qna_only 시스템 프롬프트에 완료 규칙 없음', !seenSystem.includes('COLLECT_DONE') && seenSystem.includes('전달하지 않습니다'));
    check('공개 카드에 받을 항목 비노출', cards.publicCard(qnaCard, brand).collectFields.length === 0);
    const submit = await cards.submitGuestSession(qnaCard, brand, { sessionId: chat.sessionId, name: 'x', ipHash: 'ip-qna' });
    check('qna_only 제출 거부', !submit.ok && submit.code === 'qna_only', submit.code);
  }

  /* 6) 1인 1회 ----------------------------------------------------------- */
  console.log('\n[6] 1인 1회 참여');
  const onceMade = cards.createCard({
    title: '1회 설문',
    purpose: 'survey',
    oncePerVisitor: true,
    collectFields: [{ key: 'name', label: '이름', kind: 'text', required: false }],
  });
  const onceCard = 'card' in onceMade ? onceMade.card : null;
  check('1인 1회 설정', Boolean(onceCard?.oncePerVisitor));
  if (onceCard) {
    replyQueue = [`감사합니다.${completionBlock({ name: '한 번 방문자' })}`];
    const chat = await cards.guestChat({ card: onceCard, brand, message: '설문 참여할게요', ipHash: 'ip-once' });
    const view = chat.sessionId ? cards.getSession(chat.sessionId) : null;
    check('1회 응답 완료', Boolean(chat.completed && view?.status === 'submitted'));
    check('이 방문자는 참여 완료 표시', cards.hasVisitorCompleted(onceCard, 'ip-once'));
    const again = await cards.guestChat({ card: onceCard, brand, message: '또 할게요', ipHash: 'ip-once' });
    check('같은 방문자 새 세션 차단', !again.ok && again.code === 'already_participated', again.code);
    check('공개 카드가 참여 여부 전달', cards.publicCard(onceCard, brand, true).participated === true);
    const other = await cards.guestChat({ card: onceCard, brand, message: '처음 왔어요', ipHash: 'ip-once-2' });
    check('다른 방문자는 참여 가능', Boolean(other.ok && !other.blocked));
    check('1인 1회 꺼진 명함은 재참여 가능', card ? !cards.hasVisitorCompleted(card, 'ip-auto') : false);
  }

  /* 7) 보관 기간 정리 ----------------------------------------------------- */
  console.log('\n[7] 보관 기간 자동 영구 삭제');
  const purgeMade = cards.createCard({
    title: '7일 보관 명함',
    purpose: 'intro',
    retentionDays: 7,
    oncePerVisitor: false,
  });
  const purgeCard = 'card' in purgeMade ? purgeMade.card : null;
  const keepMade = cards.createCard({ title: '영구 보관 명함', purpose: 'intro', retentionDays: 0 });
  const keepCard = 'card' in keepMade ? keepMade.card : null;
  if (purgeCard && keepCard) {
    replyQueue = ['안녕하세요', '안녕하세요'];
    const oldChat = await cards.guestChat({ card: purgeCard, brand, message: '오래된 대화', ipHash: 'ip-purge' });
    const keepChat = await cards.guestChat({ card: keepCard, brand, message: '영구 대화', ipHash: 'ip-keep' });
    const longAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    if (oldChat.sessionId) db.prepare('UPDATE guest_sessions SET created_at = ? WHERE id = ?').run(longAgo, oldChat.sessionId);
    if (keepChat.sessionId) db.prepare('UPDATE guest_sessions SET created_at = ? WHERE id = ?').run(longAgo, keepChat.sessionId);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM guest_messages').get() as { n: number }).n;
    const result = cards.cleanupExpiredGuestData();
    const gone = oldChat.sessionId ? cards.getSession(oldChat.sessionId) : null;
    const kept = keepChat.sessionId ? cards.getSession(keepChat.sessionId) : null;
    const after = (db.prepare('SELECT COUNT(*) AS n FROM guest_messages').get() as { n: number }).n;
    check('7일 지난 대화 삭제', gone === null && result.sessions >= 1, `${result.sessions}건`);
    check('본문도 함께 삭제', after < before, `${before} → ${after}`);
    check('IP 해시 포함 세션 행 삭제', !db.prepare('SELECT id FROM guest_sessions WHERE id = ?').get(oldChat.sessionId || '') );
    check('영구 보관(0)은 유지', kept !== null);
  }

  /* 8) 모델 목록 --------------------------------------------------------- */
  console.log('\n[8] 모델 목록 API');
  const indexSrc = read('server/index.ts');
  check('모델 목록 라우트', indexSrc.includes("app.get('/api/agent-cards/models'"));
  check('연결된 프로바이더만', indexSrc.includes('state.accounts[id]?.apiKeyEnc'));

  /* 9) 보안 격리 --------------------------------------------------------- */
  console.log('\n[9] 보안 격리');
  const src = read('server/agent-cards.ts');
  check('명함 모듈은 기억·도구·금고를 import 하지 않음', !/from '\.\/(tools|memory|vault|mail|browser|skills)'/.test(src));
  check('게스트 LLM 호출에 도구 없음(tools undefined)', indexSrc.includes('runAgentStep(provider, apiKey, model, messages, undefined, true)'));
  check('완료 블록 파서는 export', src.includes('export function parseCollectBlock'));

  /* 10) 빈 화면 복구 · 실서버 -------------------------------------------- */
  console.log('\n[10] 빈 화면 복구 (실서버)');
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v073-live-'));
  const port = 3600 + Math.floor(Math.random() * 120);
  const serverEntry = path.join(ROOT, 'server-dist', 'index.js');
  if (!fs.existsSync(serverEntry)) {
    check('server-dist 빌드 존재', false, 'npm run build 먼저 실행해 주세요');
  } else {
    const child: ChildProcess = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        DATA_DIR: liveDir,
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        BROWSER_ENABLED: '0',
        MONITOR_ENABLED: '0',
        MAIN_HOSTS: 'main.example.com',
      },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const waitFor = async (): Promise<boolean> => {
      for (let i = 0; i < 60; i += 1) {
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) return true;
        } catch {
          /* 아직 부팅 중 */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    };
    try {
      const up = await waitFor();
      check('임시 서버 기동', up, `port ${port}`);
      if (up) {
        const token = fs.readFileSync(path.join(liveDir, 'setup-token.txt'), 'utf8').trim();
        const jar: string[] = [];
        const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
          const res = await fetch(`${base}${url}`, {
            method,
            headers: {
              ...(body ? { 'Content-Type': 'application/json' } : {}),
              ...(jar.length ? { cookie: jar.join('; ') } : {}),
              ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: 'manual',
          });
          for (const cookie of res.headers.getSetCookie?.() || []) {
            const pair = cookie.split(';')[0];
            const name = pair.split('=')[0];
            const index = jar.findIndex((item) => item.startsWith(`${name}=`));
            if (index >= 0) jar.splice(index, 1);
            jar.push(pair);
          }
          let data: unknown = null;
          const text = await res.text();
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = text.slice(0, 80);
          }
          return { status: res.status, data, headers: res.headers };
        };
        await call('POST', '/api/setup/verify-token', { token });
        await call('POST', '/api/setup/account', { username: 'smoke', password: 'smoke-test-pass' });
        await call('POST', '/api/setup/preferences', { nickname: '방문자', agentName: '포몽', character: 'pimong', tone: 'polite' });
        await call('POST', '/api/setup/complete', {});

        // 없는 자산은 index.html 이 아니라 404
        const missing = await httpGet(base, '/assets/nonexistent.js', 'main.example.com');
        check('/assets/nonexistent.js 404', missing.status === 404, `HTTP ${missing.status}`);
        check('404 가 HTML 이 아님', !missing.body.includes('<div id="root">'), String(missing.headers['content-type'] || ''));
        const missingCss = await httpGet(base, '/assets/nonexistent.css', 'main.example.com');
        check('/assets/nonexistent.css 404', missingCss.status === 404, `HTTP ${missingCss.status}`);
        const missingIcon = await httpGet(base, '/icons/none.png', 'main.example.com');
        check('없는 이미지도 404', missingIcon.status === 404, `HTTP ${missingIcon.status}`);

        const index = await httpGet(base, '/', 'main.example.com');
        const cache = String(index.headers['cache-control'] || '').toLowerCase();
        check('/ 응답 200', index.status === 200 && index.body.includes('<div id="root">'), `HTTP ${index.status}`);
        check('/ Cache-Control no-store', cache.includes('no-store') && cache.includes('no-cache'), cache);
        const sw = await httpGet(base, '/sw.js', 'main.example.com');
        const swCache = String(sw.headers['cache-control'] || '').toLowerCase();
        check('/sw.js 재검증 헤더', sw.status === 200 && swCache.includes('no-cache') && swCache.includes('no-store'), swCache);
        check('sw.js 는 skipWaiting·clients.claim', sw.body.includes('skipWaiting') && sw.body.includes('clients.claim'));
        const spa = await httpGet(base, '/agent-cards', 'main.example.com');
        check('SPA 경로는 index.html', spa.status === 200 && spa.body.includes('<div id="root">'), `HTTP ${spa.status}`);
  check('index.html 에 자동 복구 가드', index.body.includes('pomong.recoverReloadAt') && index.body.includes('vite:preloadError'));
  const guestSrc = read('src/pages/GuestCard.tsx');
  const ownerSrc = read('src/pages/AgentCards.tsx');
  check(
    '수집·처리 안내 모달 세이프 에어리어',
    guestSrc.includes('calc(100dvh - env(safe-area-inset-top))') && guestSrc.includes('paddingBottom: \'calc(env(safe-area-inset-bottom) + 16px)\'')
  );
  check(
    'QR 모달 세이프 에어리어',
    ownerSrc.includes("paddingTop: 'calc(env(safe-area-inset-top) + 16px)'")
  );
  check(
    'IP 처리 고시 문구',
    guestSrc.includes('접속 기록 (IP)') &&
      guestSrc.includes('단방향 해시값') &&
      guestSrc.includes('원본 IP는 저장하지 않고')
  );

        // 모델 목록 — 인증 필요(쿠키 없는 새 요청으로 확인)
        const unauthorized = await fetch(`${base}/api/agent-cards/models`).then((res) => res.status).catch(() => 0);
        check('모델 목록 인증 필요', unauthorized === 401, `HTTP ${unauthorized}`);
        const models = await call('GET', '/api/agent-cards/models');
        const modelData = models.data as { ok?: boolean; groups?: unknown[]; active?: { label?: string } };
        check('모델 목록 응답', models.status === 200 && modelData.ok === true && Array.isArray(modelData.groups), `HTTP ${models.status}`);
        check('기본 모델 표기', typeof modelData.active?.label === 'string' && modelData.active.label.length > 0, modelData.active?.label);

        // 명함 생성 → 응답 방식·보관 기간·1인 1회 그대로 저장
        const created = await call('POST', '/api/agent-cards', {
          title: '설정 명함',
          slug: 'settings-card',
          purpose: 'survey',
          deliveryMode: 'qna_only',
          oncePerVisitor: true,
          retentionDays: 7,
        });
        type LiveCard = {
          id: string;
          slug: string;
          deliveryMode: string;
          oncePerVisitor: boolean;
          retentionDays: number;
          links?: { url?: string; domain?: string };
        };
        const liveCard = (created.data as { card?: LiveCard })?.card;
        check(
          '명함 생성(새 필드)',
          created.status === 200 && liveCard?.deliveryMode === 'qna_only' && liveCard?.oncePerVisitor === true && liveCard?.retentionDays === 7,
          JSON.stringify(liveCard || {})
        );
        const pub = await call('GET', '/api/public/card/settings-card');
        const pubCard = (pub.data as { card?: { deliveryMode?: string; retentionDays?: number; collectFields?: unknown[] } })?.card;
        check(
          '공개 카드가 설정 반영',
          pub.status === 200 && pubCard?.deliveryMode === 'qna_only' && pubCard?.retentionDays === 7 && pubCard?.collectFields?.length === 0
        );
        const sessions = await call('GET', `/api/agent-cards/${liveCard?.id}/sessions`);
        check('qna_only 주인 화면 비노출', Array.isArray((sessions.data as { sessions?: unknown[] })?.sessions) && (sessions.data as { sessions: unknown[] }).sessions.length === 0);
        const list = await call('GET', '/api/agent-cards');
        const listData = list.data as { deliveryModes?: { id: string }[]; retentionChoices?: number[] };
        check('응답 방식·보관 선택 목록', Boolean(listData.deliveryModes?.some((item) => item.id === 'qna_only')) && Array.isArray(listData.retentionChoices));

        // v0.7.3: 커스텀 도메인이 있으면 링크 복사·QR 도 그 도메인으로
        const domainMade = await call('POST', '/api/agent-cards', {
          title: '도메인 명함',
          slug: 'domain-card',
          purpose: 'intro',
          customDomain: 'card.example.com',
        });
        const domainCard = (domainMade.data as { card?: LiveCard })?.card;
        check(
          '커스텀 도메인 링크 우선',
          domainCard?.links?.url === 'https://card.example.com/c/domain-card' &&
            domainCard?.links?.domain === 'https://card.example.com/c/domain-card',
          JSON.stringify(domainCard?.links || {})
        );
        const qr = await call('POST', `/api/agent-cards/${domainCard?.id}/qr`);
        check(
          'QR 도 커스텀 도메인',
          (qr.data as { url?: string })?.url === 'https://card.example.com/c/domain-card',
          String((qr.data as { url?: string })?.url || '')
        );
        await call('DELETE', `/api/agent-cards/${domainCard?.id}`);
        await call('DELETE', `/api/agent-cards/${liveCard?.id}`);
      }
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        child.kill('SIGKILL');
      } catch {
        /* 이미 종료 */
      }
    }
  }

  /* 11) 개인정보 비노출 --------------------------------------------------- */
  console.log('\n[11] 개인정보 비노출');
  const scanTargets = [
    ...walk(path.join(ROOT, 'server')),
    ...walk(path.join(ROOT, 'src')),
    path.join(ROOT, 'scripts', 'smoke-v073.ts'),
    ...walk(path.join(ROOT, 'public')),
    path.join(ROOT, 'README.md'),
    path.join(ROOT, '.env.example'),
  ].filter((file) => fs.existsSync(file) && /\.(?:ts|tsx|js|jsx|json|md|html|css|cjs|yml|yaml|conf|sh|txt|example)$/.test(file));
  const patterns: { label: string; re: RegExp }[] = [
    { label: '휴대전화 번호', re: /\b01[016789][\s-]?\d{3,4}[\s-]?\d{4}\b/g },
    { label: '도로명 주소', re: /[가-힣]{2,8}(?:시|군|구)\s+[가-힣]{2,8}(?:로|길)\s*\d{1,4}/g },
    { label: '개인 메일 주소', re: /[\w.+-]+@(?:naver|gmail|kakao)\.com/gi },
  ];
  const ALLOWED_MAIL = /^(?:you|user|example|test|sample|visitor|me|hong|pomong\.labs|push)@/i;
  const DUMMY_PHONE = /010[\s-]?1234[\s-]?5678/g;
  const leaks: string[] = [];
  for (const file of scanTargets) {
    const text = fs.readFileSync(file, 'utf8').replace(DUMMY_PHONE, '010-XXXX-XXXX');
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      for (const match of text.matchAll(pattern.re)) {
        if (pattern.label === '개인 메일 주소' && ALLOWED_MAIL.test(match[0])) continue;
        leaks.push(`${path.relative(ROOT, file)} · ${pattern.label}`);
      }
    }
  }
  check('새 코드·예시에 개인정보 형태 없음', leaks.length === 0, [...new Set(leaks)].slice(0, 5).join(' / '));

  console.log(`\n${failures === 0 ? '✅ 모든 검사 통과' : `❌ 실패 ${failures}건`}`);
  db.close();
  if (failures > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error('스모크 실행 실패:', err);
  process.exitCode = 1;
});
