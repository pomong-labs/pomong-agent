/**
 * v0.6.3 스모크 테스트
 *
 *   npx tsx scripts/smoke-v063.ts
 *
 * 외부 네트워크(IMAP/SMTP·LLM) 없이 검증할 수 있는 핵심 로직만 확인한다.
 *   1) 작업별 모델 자동 라우팅(의도 감지 · 지정 모델이 없을 때 폴백 · 사진 폴백)
 *   2) 동적 도구 필터링(그룹 선택 · 넓게/전체 폴백)
 *   3) 한 턴 최대 단계(MAX_STEPS=20) · 예약 최대 단계 12 기본
 *   4) EXAONE 무료 키 만료 D-day 계산(중복 알림 방지 기준)
 *   5) 답장(인용) — DB 컬럼 마이그레이션과 인용 문맥 문자열
 *   6) 메일 유틸(RFC 2047 · quoted-printable · MIME 멀티파트 · HTML→텍스트 · 초안 확인 카드)
 *   7) 버전 0.6.3
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
  const { APP_VERSION } = await import('../server/config');
  const routing = await import('../server/routing');
  const filter = await import('../server/tool-filter');
  const mail = await import('../server/mail');
  const { db } = await import('../server/db');

  /* 1) 작업별 모델 자동 라우팅 -------------------------------------------- */
  check('일반 대화 의도', routing.detectTaskKind('오늘 기분 어때?') === 'chat');
  check('브라우저 의도', routing.detectTaskKind('쿠팡에서 이 상품 재고 확인해줘') === 'browser');
  check('로그인 의도도 브라우저', routing.detectTaskKind('깃허브에 로그인해줘') === 'browser');
  check('사진이 붙으면 vision', routing.detectTaskKind('이거 뭐야?', { hasImage: true }) === 'vision');
  check('메일 요청은 writing', routing.detectTaskKind('새로 온 메일 요약해줘') === 'writing');
  check('요약 요청은 writing', routing.detectTaskKind('이 글 세 줄로 요약해줘') === 'writing');

  const baseRouting = routing.normalizeRouting({ chat: 'inherit', browser: 'openai', vision: 'nope', writing: 'claude' });
  check('라우팅 정규화(잘못된 값은 inherit)', baseRouting.vision === 'inherit' && baseRouting.browser === 'openai');

  const routed = routing.resolveRoute({
    taskKind: 'browser',
    routing: baseRouting,
    active: { provider: 'gemini', model: 'gemini-3.8-flash' },
    connected: { gemini: true, openai: true },
  });
  check('브라우저 작업은 지정한 OpenAI로', routed.provider === 'openai' && routed.reason === 'task_route', `${routed.provider}/${routed.model}`);

  const notConnected = routing.resolveRoute({
    taskKind: 'browser',
    routing: baseRouting,
    active: { provider: 'gemini', model: 'gemini-3.8-flash' },
    connected: { gemini: true, openai: false },
  });
  check('지정 모델 미연결이면 채팅 모델 유지', notConnected.provider === 'gemini' && notConnected.reason === 'inherit');

  const visionFallback = routing.resolveRoute({
    taskKind: 'vision',
    routing: baseRouting,
    active: { provider: 'exaone', model: 'k-exaone_v2.5' },
    connected: { exaone: true, claude: true },
  });
  check('EXAONE에 사진을 붙이면 볼 수 있는 AI로', visionFallback.provider === 'claude' && visionFallback.reason === 'vision_fallback');

  /* 2) 동적 도구 필터링 --------------------------------------------------- */
  const mailOnly = filter.selectToolNames({ userRequest: '안 읽은 메일 확인해줘' });
  check('메일 요청 → 메일 도구 포함', Boolean(mailOnly.tools?.includes('mail_list')) && !mailOnly.tools?.includes('browser_click'));
  check('항상 필요한 도구는 유지', Boolean(mailOnly.tools?.includes('chat_notify')));
  const browserReq = filter.selectToolNames({ userRequest: '쿠팡에서 장바구니에 담아줘' });
  check('브라우저 요청 → 브라우저 도구 포함', Boolean(browserReq.tools?.includes('browser_open')));
  const plain = filter.selectToolNames({ userRequest: '고마워' });
  check('잡담은 전체 허용(안전)', plain.tools === null && plain.reason === 'all');
  const mixed = filter.selectToolNames({ userRequest: '메일 확인하고 날씨도 알려주고 서버 상태, 검색까지, 사진도' , hasImage: true });
  check('복합 요청은 전체 허용', mixed.tools === null);
  const imageTurn = filter.selectToolNames({ userRequest: '이 사진에서 글자만 뽑아줘', hasImage: true });
  check('사진 턴 → 파일 도구 포함', Boolean(imageTurn.tools?.includes('attachment_read')));

  /* 3) 최대 단계 ---------------------------------------------------------- */
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
  check('한 턴 MAX_STEPS = 20', /const MAX_STEPS = 20;/.test(indexSrc), 'server/index.ts');
  check('예약 만들기 기본 12단계', /useState\(job\?\.maxSteps \|\| 12\)/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'Automation.tsx'), 'utf8')));
  const automationSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'Automation.tsx'), 'utf8');
  check('예약 단계 선택지에 20단계', /\[6, 8, 10, 12, 15, 20\]/.test(automationSrc));
  const jobs = await import('../server/jobs');
  const job = jobs.createJob({ name: '스모크', cron: '0 8 * * *', prompt: '요약', maxSteps: 20 });
  check('예약 maxSteps 20 저장', job.maxSteps === 20, String(job.maxSteps));
  jobs.deleteJob(job.id);

  /* 4) EXAONE 키 만료 ----------------------------------------------------- */
  const now = new Date('2026-11-20T12:00:00Z');
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const fresh = routing.exaoneKeyStatus(at(1), now);
  check('1일 전 키는 여유(D-29)', fresh.daysLeft === 29 && !fresh.warn, fresh.label);
  const warn = routing.exaoneKeyStatus(at(27), now);
  check('27일 지나면 D-3 경고', warn.daysLeft === 3 && warn.warn && !warn.expired, warn.label);
  const expired = routing.exaoneKeyStatus(at(31), now);
  check('31일 지나면 만료', expired.expired && expired.label === '만료됨');
  check('등록 시각이 없으면 계산 안 함', routing.exaoneKeyStatus(null).daysLeft === null);

  /* 5) 답장(인용) --------------------------------------------------------- */
  const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  check('messages.reply_to_id 컬럼', cols.some((c) => c.name === 'reply_to_id'));
  const historySrc = indexSrc.slice(indexSrc.indexOf('function buildModelHistory'), indexSrc.indexOf('function buildModelHistory') + 4000);
  check('답장 문맥을 모델에 전달', historySrc.includes('[답장 대상 메시지'));

  /* 6) 메일 유틸 ---------------------------------------------------------- */
  check('RFC2047 base64 제목', mail.decodeMimeWords('=?UTF-8?B?7JWE7J207JWE?=') === '아이아');
  check('RFC2047 Q 인코딩', mail.decodeMimeWords('=?UTF-8?Q?=ED=95=9C=EA=B8=80?=') === '한글');
  check('quoted-printable', mail.decodeCharset(Buffer.from(mail.decodeQuotedPrintable('=ED=95=9C=EA=B8=80'), 'latin1'), 'utf-8') === '한글');
  check('EUC-KR 본문 디코딩', mail.decodeCharset(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), 'euc-kr') === '한글');
  check('HTML→텍스트', mail.htmlToText('<p>안녕<br>하세요</p><script>x()</script>').includes('안녕\n하세요'));
  const raw = Buffer.from(
    [
      'From: "홍길동" <hong@example.com>',
      'To: me@example.com',
      'Subject: =?UTF-8?B?7JWE7J207JWE?= 테스트',
      'Date: Thu, 20 Nov 2026 09:00:00 +0900',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="BND"',
      '',
      '--BND',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('본문 내용입니다', 'utf8').toString('base64'),
      '--BND',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>본문 내용입니다</p>',
      '--BND--',
      '',
    ].join('\r\n'),
    'utf8'
  );
  const parsed = mail.parseRawMessage(raw);
  check('MIME 본문 파싱', parsed.text.trim() === '본문 내용입니다', JSON.stringify(parsed.text));
  check('보낸사람 이름 파싱', parsed.fromName === '홍길동' && parsed.from === 'hong@example.com', `${parsed.fromName} <${parsed.from}>`);
  check('제목 디코딩', parsed.subject.includes('아이아'), parsed.subject);

  const conn = await import('../server/mail');
  check('메일 미연결 상태', conn.listAccounts().length === 0);
  let draftError = '';
  try {
    conn.createDraft({ to: 'someone@example.com', subject: '테스트', text: '본문' });
  } catch (err) {
    draftError = err instanceof Error ? err.message : String(err);
  }
  check('계정 없이 초안을 만들면 안내', /메일 계정/.test(draftError), draftError);

  /* 7) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
  check('버전이 package.json 과 같다', APP_VERSION === pkg.version, APP_VERSION);
  check('package.json 버전 형식', /^0\.\d+\.\d+$/.test(pkg.version), pkg.version);

  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
