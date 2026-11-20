/**
 * v0.6.2 스모크 테스트
 *
 *   npx tsx scripts/smoke-v062.ts
 *
 * 외부 사이트·실제 API 없이 검증할 수 있는 것만 확인한다.
 *   1) 브라우저 작업 중 빈 응답·잘못된 함수 호출 → 재시도/상위 모델 승격 판단
 *   2) Gemini finishReason 파싱(빈 MALFORMED_FUNCTION_CALL 응답)
 *   3) EXAONE(OpenAI 호환) 요청 페이로드·응답 파싱·추론 강도 매핑·사진 안내
 *   4) browser_open 결과의 '이미 로그인' 안내 문구
 *   5) 주소창 직접 입력(https 자동 보정·차단·형식 오류)
 *   6) AI 없이 브라우저 바로 열기(브라우저 꺼짐 안내)
 *   7) 버전
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

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> | null };
const realFetch = globalThis.fetch;

/** fetch를 가로채 정해진 응답을 돌려준다(요청 본문도 기록). */
function stubFetch(handler: (call: FetchCall) => { status?: number; body: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const call: FetchCall = { url, init: init || {}, body };
    calls.push(call);
    const result = handler(call);
    return new Response(JSON.stringify(result.body), {
      status: result.status || 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

async function main(): Promise<void> {
  const { planEmptyRecovery, isEmptyOrMalformedReply, EMPTY_RETRY_NUDGE, MAX_EMPTY_RETRIES } = await import('../server/agent-loop');
  const { higherTierModel, exaoneApiEffort, runAgentStep, testProvider } = await import('../server/providers');
  const { normalizeAddress, loginStateNote, openForUser } = await import('../server/browser');
  const { APP_VERSION } = await import('../server/config');

  /* 1) 빈 응답/잘못된 함수 호출 판단 ------------------------------------- */
  check(
    '빈 응답(toolCalls 0 + 빈 텍스트)을 알아챈다',
    isEmptyOrMalformedReply({ text: '   ', toolCalls: [], finishReason: 'STOP' }).empty
  );
  check(
    '텍스트가 있으면 빈 응답이 아니다',
    !isEmptyOrMalformedReply({ text: '다 했어요', toolCalls: [], finishReason: 'STOP' }).empty
  );
  check(
    'MALFORMED_FUNCTION_CALL 을 알아챈다',
    isEmptyOrMalformedReply({ text: '', toolCalls: [], finishReason: 'MALFORMED_FUNCTION_CALL' }).malformed
  );
  check(
    '브라우저 작업 중 빈 응답이면 재시도한다',
    planEmptyRecovery({ empty: true, malformed: false, browserUsed: true, retriesUsed: 0, handover: false, stopped: false }).retry
  );
  check(
    '브라우저를 안 쓴 대화의 빈 응답은 재시도하지 않는다(기존 동작 유지)',
    !planEmptyRecovery({ empty: true, malformed: false, browserUsed: false, retriesUsed: 0, handover: false, stopped: false }).retry
  );
  check(
    '재시도 한도를 넘으면 멈춘다',
    !planEmptyRecovery({ empty: true, malformed: false, browserUsed: true, retriesUsed: MAX_EMPTY_RETRIES, handover: false, stopped: false }).retry
  );
  check(
    '이미 화면을 넘겼으면 재시도하지 않는다',
    !planEmptyRecovery({ empty: true, malformed: false, browserUsed: true, retriesUsed: 0, handover: true, stopped: false }).retry
  );
  check(
    '사용자가 중지했으면 재시도하지 않는다',
    !planEmptyRecovery({ empty: true, malformed: false, browserUsed: true, retriesUsed: 0, handover: false, stopped: true }).retry
  );
  check(
    '문제 지시문에 스냅샷·입력·전송까지 요구하는 문장이 들어 있다',
    ['[서버 점검]', 'browser_snapshot', 'browser_type', 'browser_click'].every((word) => EMPTY_RETRY_NUDGE.includes(word))
  );
  check(
    '잘못된 함수 호출도 재시도 대상',
    planEmptyRecovery({ empty: false, malformed: true, browserUsed: true, retriesUsed: 0, handover: false, stopped: false }).reason === 'malformed'
  );

  /* 2) Gemini finishReason 파싱 ----------------------------------------- */
  stubFetch(() => ({ body: { candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] } }));
  const malformed = await runAgentStep('gemini', 'key', 'gemini-3.1-flash-lite', [{ role: 'user', content: '크몽 메시지 확인해줘' }]);
  check('Gemini 빈 응답에 finishReason 이 실린다', malformed.finishReason === 'MALFORMED_FUNCTION_CALL', String(malformed.finishReason));
  check('Gemini 빈 응답은 텍스트·도구 호출이 비어 있다', malformed.text === '' && malformed.toolCalls.length === 0);

  /* 3) 상위 모델 승격 ---------------------------------------------------- */
  check('경량 모델 → 상위 플래시 모델로 승격', higherTierModel('gemini', 'gemini-3.1-flash-lite') === 'gemini-3.8-flash');
  check('이미 상위 모델이면 승격하지 않는다', higherTierModel('gemini', 'gemini-3.8-flash') === null);
  check('다른 프로바이더는 승격하지 않는다', higherTierModel('exaone', 'k-exaone_v2.5') === null);
  check('추론 강도 매핑: low→low', exaoneApiEffort('low') === 'low');
  check('추론 강도 매핑: medium→high', exaoneApiEffort('medium') === 'high');
  check('추론 강도 매핑: high→max', exaoneApiEffort('high') === 'max');

  /* 4) EXAONE 요청/응답 -------------------------------------------------- */
  const exaoneCalls = stubFetch(() => ({
    body: {
      id: 'x',
      model: 'k-exaone_v2.5',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '\n\n메시지함을 열었어요.',
            reasoning_content: '사용자는 메시지함을 열어 달라고 했다. 먼저 e3을 눌러야 한다.',
            tool_calls: [{ id: 'call_1', function: { name: 'browser_click', arguments: '{"ref":"e3"}' } }],
          },
        },
      ],
    },
  }));
  const exaone = await runAgentStep(
    'exaone',
    'exaone-key',
    'k-exaone_v2.5',
    [
      { role: 'system', content: '시스템 지시' },
      { role: 'user', content: '크몽 메시지함 열어줘' },
    ],
    [{ name: 'browser_click', description: '클릭', parameters: { type: 'object', properties: {} } }],
    false,
    undefined,
    { reasoningEffort: 'high' }
  );
  const sent = exaoneCalls[0];
  check('EXAONE은 공식 엔드포인트로 보낸다', sent.url === 'https://api.exaone.ai/v1/chat/completions', sent.url);
  check('EXAONE 모델 ID', sent.body?.model === 'k-exaone_v2.5', String(sent.body?.model));
  check('EXAONE 권장 temperature=1.0', sent.body?.temperature === 1.0);
  check('EXAONE 권장 top_p=0.95', sent.body?.top_p === 0.95);
  check(
    'EXAONE preserve_thinking=true (에이전트 권장값)',
    (sent.body?.chat_template_kwargs as { preserve_thinking?: boolean } | undefined)?.preserve_thinking === true
  );
  check('추론 강도 high → max 로 보낸다', sent.body?.reasoning_effort === 'max', String(sent.body?.reasoning_effort));
  check('stream=false (한 번에 받기)', sent.body?.stream === false);
  check('시스템 메시지가 맨 앞에 온다', (sent.body?.messages as { role: string }[] | undefined)?.[0]?.role === 'system');
  check(
    '도구는 OpenAI function 규격으로 보낸다',
    (sent.body?.tools as { type?: string; function?: { name?: string } }[] | undefined)?.[0]?.type === 'function' &&
      (sent.body?.tools as { function?: { name?: string } }[] | undefined)?.[0]?.function?.name === 'browser_click'
  );
  check('Authorization: Bearer 키', (sent.init.headers as Record<string, string>).Authorization === 'Bearer exaone-key');
  check('최종 답변(content)만 사용자에게 쓴다', exaone.text === '메시지함을 열었어요.', exaone.text);
  check('reasoning_content 는 답변에 섞이지 않는다', !/reasoning|메시지함을 열어 달라고/.test(exaone.text));
  check('tool_calls 를 실행할 수 있게 파싱한다', exaone.toolCalls[0]?.name === 'browser_click' && exaone.toolCalls[0]?.args?.ref === 'e3');
  check('EXAONE finishReason 도 읽는다', exaone.finishReason === 'tool_calls', String(exaone.finishReason));

  // 기본값은 low(빠른 응답)
  const defaultEffort = stubFetch(() => ({ body: { choices: [{ message: { content: 'ok' } }] } }));
  await runAgentStep('exaone', 'exaone-key', 'k-exaone_v2.5', [{ role: 'user', content: '안녕' }]);
  check('추론 강도 기본값은 low', defaultEffort[0].body?.reasoning_effort === 'low', String(defaultEffort[0].body?.reasoning_effort));

  // 사진은 볼 수 없다 → 안내 문구로 바꿔 보낸다
  const imageCall = stubFetch(() => ({ body: { choices: [{ message: { content: '사진은 못 봐요' } }] } }));
  await runAgentStep('exaone', 'exaone-key', 'k-exaone_v2.5', [
    {
      role: 'user',
      content: '이 사진 뭐야?',
      parts: [
        { type: 'text', text: '이 사진 뭐야?' },
        { type: 'image', mime: 'image/png', dataBase64: 'AAAA' },
      ],
    },
  ]);
  const imageMessages = (imageCall[0].body?.messages || []) as { role: string; content: unknown }[];
  const imageContent = String(imageMessages[imageMessages.length - 1]?.content || '');
  check('EXAONE에 사진을 보내지 않고 안내로 바꾼다', !imageContent.includes('data:image') && imageContent.includes('[첨부 사진]'), imageContent.slice(0, 60));

  // 키 확인
  stubFetch(() => ({ status: 401, body: { error: { message: 'invalid api key' } } }));
  const badKey = await testProvider('exaone', 'wrong-key');
  check('EXAONE 잘못된 키는 실패로 알린다', !badKey.ok && /invalid api key/i.test(badKey.message), badKey.message);
  stubFetch(() => ({ body: { data: [{ id: 'k-exaone_v2.5' }] } }));
  const goodKey = await testProvider('exaone', 'good-key');
  check('EXAONE 유효한 키는 성공으로 알린다', goodKey.ok && (goodKey.models || []).includes('k-exaone_v2.5'), goodKey.message);

  /* 5) '이미 로그인' 안내 ------------------------------------------------ */
  const loggedInNote = loginStateNote({ hints: ['마이페이지', '메시지함', '로그아웃'], loginEntryVisible: false, passwordField: false });
  check(
    '이미 로그인된 화면에는 로그인 버튼을 누르지 말라고 알린다',
    Boolean(loggedInNote && loggedInNote.includes('[로그인 상태: 이미 로그인되어 있습니다')),
    loggedInNote || 'null'
  );
  check(
    '로그인 버튼이 보이면 안내하지 않는다',
    loginStateNote({ hints: ['마이페이지'], loginEntryVisible: true, passwordField: false }) === null
  );
  check(
    '비밀번호 칸이 있으면 안내하지 않는다',
    loginStateNote({ hints: ['로그아웃'], loginEntryVisible: false, passwordField: true }) === null
  );
  check(
    '장바구니 같은 약한 근거만으로는 안내하지 않는다',
    loginStateNote({ hints: ['주문/장바구니'], loginEntryVisible: false, passwordField: false }) === null
  );

  /* 6) 주소창 직접 입력 -------------------------------------------------- */
  check('도메인만 입력하면 https 를 붙인다', normalizeAddress('naver.com').url === 'https://naver.com/', normalizeAddress('naver.com').url);
  check(
    'http 주소는 그대로 둔다',
    normalizeAddress('http://example.com/a?b=1').url === 'http://example.com/a?b=1',
    normalizeAddress('http://example.com/a?b=1').url
  );
  check(
    '크몽 /login 은 메인으로 보정한다',
    normalizeAddress('https://kmong.com/login').url === 'https://kmong.com/',
    normalizeAddress('https://kmong.com/login').url
  );
  check('앞뒤 공백을 지운다', normalizeAddress('  www.musinsa.com  ').url.startsWith('https://www.musinsa.com'), normalizeAddress('  www.musinsa.com  ').url);
  let badAddress = '';
  try {
    normalizeAddress('날씨 알려줘');
  } catch (err) {
    badAddress = err instanceof Error ? err.message : String(err);
  }
  check('주소가 아닌 입력은 안내 문구로 거절한다', /주소 형식/.test(badAddress), badAddress);
  let blockedAddress = '';
  try {
    normalizeAddress('javascript:alert(1)');
  } catch (err) {
    blockedAddress = err instanceof Error ? err.message : String(err);
  }
  check('javascript: 같은 주소는 막는다', /열 수 없습니다/.test(blockedAddress), blockedAddress);

  /* 7) AI 없이 브라우저 바로 열기 ---------------------------------------- */
  let openError = '';
  try {
    await openForUser({ url: 'naver.com' });
  } catch (err) {
    openError = err instanceof Error ? err.message : String(err);
  }
  check('브라우저가 꺼진 서버에서는 이유를 알려 준다', /BROWSER_ENABLED|꺼져/.test(openError), openError);

  /* 8) 버전 -------------------------------------------------------------- */
  check('버전 0.6.2', APP_VERSION === '0.6.2', APP_VERSION);

  globalThis.fetch = realFetch;
  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});
