/**
 * v0.7.0 스모크 테스트 — 상용급 에이전트 하네스 6대 기능
 *
 *   npx tsx scripts/smoke-v070.ts
 *
 * 1) 버전 0.7.0 일원화
 * 2) 컨텍스트 자동 압축 & 토큰 예산 — 추정·축약·압축(도구 호출 짝 유지)·예산 보고
 * 3) 무한 루프 감지 — 같은 호출 반복(거의 같은 인자 포함)·연속 실패·에스컬레이션·중단
 * 4) 병렬 실행 + 재시도 — 읽기 전용 분류·동시성·순서 보존·일시 오류만 재시도
 * 5) 스텝 체크포인트 — 저장·갱신·복구 목록·부팅 시 interrupted·사진 원본 제외
 * 6) 실행 트레이스 — 토큰·비용·합계·모델별 통계
 * 7) 서버·클라이언트 연결 — 스트리밍 SSE·재개 API·관제실 카드
 * 8) 회귀 — v0.6.18 승인/마스킹/가드레일, v0.6.19 지침/read_skill
 * 9) 개인정보 비노출
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v070-'));
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
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'server-dist') continue;
    if (entry.name === 'data' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  /* 1) 버전 ---------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');
  const compose = read('docker-compose.yml');
  check('버전 0.7.0', pkg.version === '0.7.0', pkg.version);
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('에셋 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check(
    'docker-compose 이미지 태그',
    compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`)
  );
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check('화면 버전 표기', read('src/pages/More.tsx').includes(`useState('${pkg.version}')`));

  /* 2) 컨텍스트 예산 ------------------------------------------------------- */
  const budget = await import('../server/context-budget');
  check('한글 토큰 추정(글자당 ~1)', budget.estimateTokens('안녕하세요') >= 5);
  check('영문 토큰 추정(4글자 ~1토큰)', budget.estimateTokens('abcdefgh') <= 4);
  check('빈 문자열 0토큰', budget.estimateTokens('') === 0);

  type Msg = import('../server/providers').AgentMessage;
  const big = '가'.repeat(9000);
  const conversation: Msg[] = [
    { role: 'system', content: '시스템 프롬프트' },
    { role: 'user', content: '첫 요청' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'browser_snapshot', args: { page: 1 } }] },
    { role: 'tool', toolCallId: 'a1', name: 'browser_snapshot', content: big },
    { role: 'user', content: '두 번째 요청' },
    { role: 'assistant', content: '두 번째 답' },
    { role: 'user', content: '세 번째 요청' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a2', name: 'web_search', args: {} }] },
    { role: 'tool', toolCallId: 'a2', name: 'web_search', content: '검색 결과' },
    { role: 'user', content: '네 번째 요청' },
  ];
  const squeezed = budget.squeezeConversation(conversation, { keepRecent: 1, limit: 500 });
  check('오래된 도구 결과 축약', squeezed.trimmed >= 1 && squeezed.savedTokens > 0, `${squeezed.trimmed}건`);
  const squeezedResult = squeezed.messages.find((m) => m.role === 'tool' && m.toolCallId === 'a1') as { content: string };
  check(
    '축약 표식 남김',
    squeezedResult.content.length < 1200 && squeezedResult.content.includes('컨텍스트 축약'),
    `${squeezedResult.content.length}자`
  );
  const keptRecent = budget.squeezeConversation(conversation, { keepRecent: 1, limit: 500 }).messages.find(
    (m) => m.role === 'tool' && m.toolCallId === 'a2'
  ) as { content: string };
  check('최근 도구 결과는 그대로', keptRecent.content === '검색 결과');

  const manyMessages: Msg[] = [{ role: 'system', content: '시스템' }];
  for (let i = 0; i < 12; i += 1) {
    manyMessages.push({ role: 'user', content: `요청 ${i} ${'가'.repeat(400)}` });
    manyMessages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'web_search', args: { q: i } }] });
    manyMessages.push({ role: 'tool', toolCallId: `c${i}`, name: 'web_search', content: `결과 ${i} ${'나'.repeat(400)}` });
  }
  const compacted = budget.compactConversation(manyMessages, { keepTail: 6 });
  check('압축 수행', compacted.compacted && compacted.folded > 0, `${compacted.folded}개 접음`);
  check('시스템 프롬프트 유지', (compacted.messages[0] as { content: string }).content === '시스템');
  check('압축 요약 삽입', compacted.messages.some((m) => m.role === 'system' && m.content.includes('자동 압축')));
  check(
    '잘린 뒤 첫 메시지는 사용자 턴',
    compacted.messages[1]?.role === 'system' ? compacted.messages[2]?.role === 'user' : compacted.messages[1]?.role === 'user'
  );
  {
    // 도구 호출과 결과의 짝이 깨지는지 확인(프로바이더 400의 원인)
    const ids = new Set<string>();
    let broken = false;
    for (const m of compacted.messages) {
      if (m.role === 'assistant') for (const call of m.toolCalls || []) ids.add(call.id);
      if (m.role === 'tool' && !ids.has(m.toolCallId)) broken = true;
    }
    check('압축 후 도구 호출/결과 짝 유지', !broken);
  }
  const managed = budget.manageContext(manyMessages, { budget: 2000 });
  check('예산 초과 시 압축', managed.report.compacted && managed.report.after < managed.report.before);
  check('예산 보고 값', managed.report.budget === 2000 && managed.report.ratio > 0);
  const small = budget.manageContext([{ role: 'system', content: '짧음' }, { role: 'user', content: '안녕' }], { budget: 50000 });
  check('예산 안이면 압축 안 함', !small.report.compacted && small.report.trimmed === 0);

  /* 3) 무한 루프 감지 ----------------------------------------------------- */
  const doom = await import('../server/doom-loop');
  check(
    '거의 같은 인자는 같은 지문',
    doom.callSignature('browser_click', { selector: '#a',  text: 'x  y' }) ===
      doom.callSignature('browser_click', { selector: '#a', text: 'x y' })
  );
  check(
    '다른 도구는 다른 지문',
    doom.callSignature('browser_click', { selector: '#a' }) !== doom.callSignature('browser_type', { selector: '#a' })
  );
  check(
    '긴 인자는 앞부분만 비교',
    doom.callSignature('browser_type', { text: '가'.repeat(500) }) === doom.callSignature('browser_type', { text: '가'.repeat(500) + '나' })
  );

  const guard = new doom.DoomLoopGuard();
  const args = { selector: '#login' };
  check('첫 호출 허용', guard.inspect('browser_click', args).action === 'allow');
  guard.record('browser_click', args, true);
  check('두 번째 허용', guard.inspect('browser_click', args).action === 'allow');
  guard.record('browser_click', args, true);
  const third = guard.inspect('browser_click', args);
  check('세 번째에서 개입(nudge)', third.action === 'nudge', third.action);
  check('전략 전환 안내 문구', third.message.includes('루프 감지') && third.message.includes('전략'));
  guard.record('browser_click', args, true);
  const fourth = guard.inspect('browser_click', args);
  check('네 번째는 상위 모델 에스컬레이션', fourth.action === 'escalate', fourth.action);
  guard.record('browser_click', args, true);
  const fifth = guard.inspect('browser_click', args);
  check('다섯 번째는 중단', fifth.action === 'stop', fifth.action);
  check('중단 이유 문구', /멈춥니다/.test(fifth.message));

  const failing = new doom.DoomLoopGuard();
  const actions: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const decision = failing.inspect(`tool_${i}`, { i });
    actions.push(decision.action);
    failing.record(`tool_${i}`, { i }, false);
  }
  check('연속 실패 3회에서 안내', actions[2] === 'nudge', actions.join(','));
  check('연속 실패 5회에서 중단', actions.includes('stop'), actions.join(','));
  check('연속 실패 안내 문구', doom.buildFailureNudge(3).includes('연속 실패'));
  check('반복 안내에 대안 제시', doom.buildRepeatNudge('web_search', 3).includes('다른 도구'));

  /* 4) 병렬 실행 + 재시도 -------------------------------------------------- */
  const exec = await import('../server/tool-exec');
  check('읽기 도구는 병렬', exec.isParallelSafe('web_search') && exec.isParallelSafe('browser_snapshot') && exec.isParallelSafe('mail_read'));
  check(
    '쓰기·조작 도구는 병렬 아님',
    !exec.isParallelSafe('mail_send') &&
      !exec.isParallelSafe('browser_click') &&
      !exec.isParallelSafe('browser_type') &&
      !exec.isParallelSafe('manage_docker') &&
      !exec.isParallelSafe('memory_save') &&
      !exec.isParallelSafe('chat_notify')
  );
  check('일시 오류 판별(503)', exec.isTransientError(new Error('503: high demand')));
  check('일시 오류 판별(타임아웃)', exec.isTransientError(new Error('request timeout')));
  check('일시 오류 아님(잘못된 인자)', !exec.isTransientError(new Error('invalid argument: selector')));
  check('부작용 도구는 연결 실패만 재시도', exec.isRetryableForSideEffect(new Error('connect ECONNREFUSED')) && !exec.isRetryableForSideEffect(new Error('timeout')));
  check('백오프 증가', exec.backoffDelay(1) > exec.backoffDelay(0) * 2);

  let attempts = 0;
  const retried = await exec.runWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('503: busy');
      return 'ok';
    },
    { attempts: 3, sleep: async () => undefined }
  );
  check('일시 오류는 재시도 후 성공', retried === 'ok' && attempts === 3, `${attempts}회`);
  let permanent = 0;
  let threw = false;
  try {
    await exec.runWithRetry(
      async () => {
        permanent += 1;
        throw new Error('invalid selector');
      },
      { attempts: 3, sleep: async () => undefined }
    );
  } catch {
    threw = true;
  }
  check('영구 오류는 재시도 안 함', threw && permanent === 1, `${permanent}회`);

  const order: number[] = [];
  const mapped = await exec.mapWithConcurrency([3, 1, 2], 2, async (item) => {
    order.push(item);
    await new Promise((resolve) => setTimeout(resolve, item * 10));
    return item * 10;
  });
  check('병렬 결과는 입력 순서 유지', mapped.join(',') === '30,10,20', mapped.join(','));
  check('동시 실행 제한', order.length === 3);

  /* 5) 체크포인트 --------------------------------------------------------- */
  const checkpoints = await import('../server/checkpoints');
  const { db } = await import('../server/db');
  check(
    'agent_checkpoints 테이블',
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_checkpoints'").get())
  );
  check(
    'agent_traces 테이블',
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_traces'").get())
  );
  check(
    'agent_trace_steps 테이블',
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_trace_steps'").get())
  );

  const slim = checkpoints.slimConversation([
    {
      role: 'user',
      content: '사진 봐줘',
      parts: [
        { type: 'text', text: '사진 봐줘' },
        { type: 'image', mime: 'image/png', dataBase64: 'A'.repeat(4000) },
      ],
    },
  ])[0] as { parts?: { type: string; text?: string }[] };
  check(
    '체크포인트는 사진 원본을 저장하지 않음',
    !JSON.stringify(slim).includes('A'.repeat(100)) && JSON.stringify(slim).includes('원본을 저장하지 않음')
  );

  const cpId = checkpoints.startCheckpoint({
    sessionId: 'smoke-s1',
    turnId: 'turn-1',
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    userPrompt: '택배 조회해줘',
    step: 1,
    status: 'running',
    conversation: conversation.slice(0, 4),
    toolsUsed: ['browser_snapshot'],
    doneTools: { a1: { name: 'browser_snapshot', content: 'snap' } },
    reply: '',
  });
  check('체크포인트 생성', Boolean(checkpoints.getCheckpoint(cpId)));
  checkpoints.updateCheckpoint(cpId, { step: 2, status: 'running' });
  const cp = checkpoints.getCheckpoint(cpId);
  check('체크포인트 갱신', cp?.step === 2, `step ${cp?.step}`);
  check('실행한 도구 결과 저장', Boolean(cp?.doneTools?.a1));

  check('부팅 시 중단 표시', checkpoints.markInterruptedOnBoot() >= 1);
  const resumable = checkpoints.resumableForSession('smoke-s1');
  check('복구 목록에 노출', Boolean(resumable) && resumable?.status === 'interrupted');
  check('복구 후보에 요청 문장', resumable?.userPrompt === '택배 조회해줘');
  check('복구 목록(전체)', checkpoints.listResumable(5).length >= 1);
  checkpoints.updateCheckpoint(cpId, { status: 'done' });
  check('완료 턴은 복구 목록에서 빠짐', checkpoints.resumableForSession('smoke-s1') === null);

  /* 6) 실행 트레이스 ------------------------------------------------------ */
  const traces = await import('../server/traces');
  const traceId = traces.startTrace({
    sessionId: 'smoke-s1',
    turnId: 'turn-1',
    userPrompt: '택배 조회해줘',
    provider: 'gemini',
    model: 'gemini-3.8-flash',
  });
  traces.recordTraceStep({ traceId, seq: 1, provider: 'gemini', model: 'gemini-3.8-flash', inputTokens: 1000, outputTokens: 500, durationMs: 1234, tools: ['browser_snapshot'] });
  traces.recordTraceStep({ traceId, seq: 2, provider: 'gemini', model: 'gemini-3.8-flash', inputTokens: 2000, outputTokens: 300, durationMs: 800, tools: ['browser_snapshot', 'chat_notify'] });
  traces.finishTrace(traceId, { status: 'done', durationMs: 3200, loopBreaks: 1, compacted: 2 });
  const trace = traces.traceById(traceId);
  check('트레이스 기록', Boolean(trace));
  check('스텝 수 누적', trace?.steps === 2, String(trace?.steps));
  check('토큰 합산', trace?.inputTokens === 3000 && trace?.outputTokens === 800, `${trace?.inputTokens}/${trace?.outputTokens}`);
  check('비용 계산', Boolean(trace && trace.costUsd > 0) && trace?.costKrw >= trace?.costUsd);
  check('도구 목록 합집합', (trace?.tools || []).includes('browser_snapshot') && (trace?.tools || []).includes('chat_notify'));
  check('루프 감지 횟수 기록', trace?.loopBreaks === 1 && trace?.compacted === 2);
  check('상태 마무리', trace?.status === 'done' && Boolean(trace?.endedAt));
  check('스텝 조회', traces.traceSteps(traceId).length === 2);
  check('최근 트레이스 조회', traces.recentTraces(5, 'smoke-s1').length === 1);
  const summary = traces.traceSummary(7);
  check('요약 합계', summary.turns >= 1 && summary.inputTokens >= 3000);
  check('모델별 합계', summary.byModel.some((row) => row.model === 'gemini-3.8-flash'));
  check('일별 합계', summary.byDay.length >= 1);
  check('단가 추정 제공', Object.keys(traces.DEFAULT_PRICES).length >= 8);
  check('원화 환율 설정', traces.usdKrwRate() > 500);
  const zero = traces.estimateCost('k-exaone_v2.5', 1_000_000, 1_000_000);
  check('무료 모델 비용 0', zero.usd === 0);

  /* 7) 서버·클라이언트 연결 ------------------------------------------------ */
  const index = read('server/index.ts');
  const loop = read('server/agent-loop.ts');
  const providersSrc = read('server/providers.ts');
  const store = read('src/lib/store.tsx');
  const chatPage = read('src/pages/Chat.tsx');
  const monitorPage = read('src/pages/Monitor.tsx');
  const events = read('server/events.ts');

  check('1) 스트리밍: SSE 조각 통로', events.includes('publishDelta') && events.includes('chat_delta'));
  check('1) 스트리밍: 루프가 스트리밍 호출', loop.includes('runAgentStepStreaming') && loop.includes('onDelta'));
  check('1) 스트리밍: 4개 프로바이더 어댑터', providersSrc.includes('geminiStreamAttempt') && providersSrc.includes('openAiStreamAttempt') && providersSrc.includes('claudeStreamAttempt') && providersSrc.includes('EXAONE_ENDPOINT'));
  check('1) 스트리밍: 비스트리밍 폴백', providersSrc.includes('fallbackToBuffered') && providersSrc.includes('runAgentStepRaw('));
  check('1) 스트리밍: 마스킹 조각 복원', providersSrc.includes('자리표시자') && providersSrc.includes('flush(true)'));
  check('1) 스트리밍: 화면 말풍선', chatPage.includes('streamText') && store.includes("event.type === 'chat_delta'"));

  check('2) 컨텍스트: 매 스텝 관리', loop.includes('manageContext(conversation'));
  check('2) 컨텍스트: 예산 기본값', loop.includes('DEFAULT_CONTEXT_BUDGET'));

  check('3) 루프 감지: 루프에 연결', loop.includes('DoomLoopGuard') && loop.includes('guard.inspect'));
  check('3) 루프 감지: 상위 모델 에스컬레이션', loop.includes("decision.action === 'escalate'") && loop.includes('higherTierModel'));
  check('3) 루프 감지: 결과 전달', loop.includes('loopStopped') && loop.includes('loopBreaks'));

  check('4) 병렬: 루프에 연결', loop.includes('mapWithConcurrency') && loop.includes('isParallelSafe'));
  check('4) 재시도: 루프에 연결', loop.includes('runWithRetry'));

  check('5) 체크포인트: 루프 콜백', loop.includes('onCheckpoint') && index.includes('checkpoints.startCheckpoint'));
  check('5) 체크포인트: 재개 경로', index.includes("app.post('/api/chat/resume'") && index.includes('resumeConversation') && index.includes('replayResults'));
  check('5) 체크포인트: 부팅 시 interrupted', index.includes('markInterruptedOnBoot'));
  check('5) 체크포인트: 화면 이어서 하기', chatPage.includes('이어서 하기') && store.includes('resumeTurn'));

  check('6) 트레이스: 루프 사용량 콜백', loop.includes('onStepUsage') && index.includes('traces.recordTraceStep'));
  check(
    '6) 트레이스: 조회 API',
    index.includes("'/api/observability/traces'") && index.includes("'/api/observability/summary'")
  );
  check('6) 트레이스: 관제실 카드', monitorPage.includes('ObservabilityCard') && monitorPage.includes('AI 실행 트레이스'));
  check('6) 트레이스: 턴 응답에 비용 포함', index.includes('observability: result.observability') || index.includes('observability,'));

  /*
   * 7b) 스트리밍 파서 실제 동작(가짜 HTTP 응답으로 검증, 네트워크·비용 없음)
   *   프로바이더를 실제로 부르지 않고 SSE 본문만 돌려주는 fetch 스텁을 꽂아
   *   "조각이 제대로 모이는지 · 도구 호출이 살아 있는지 · 실패하면 폴백하는지"를 본다.
   */
  {
    const { runAgentStepStreaming } = await import('../server/providers');
    const realFetch = globalThis.fetch;
    const sse = (events: string[]) => events.map((e) => `data: ${e}\n\n`).join('');
    try {
      // (a) OpenAI 형식: 텍스트 조각 + 도구 호출 조립 + usage
      const openAiBody = sse([
        JSON.stringify({ choices: [{ delta: { content: '지금 ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '확인할게요.' } }] }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'browser_snapshot', arguments: '{"pa' } }] } }],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ge":1}' } }] }, finish_reason: 'tool_calls' }],
        }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } }),
      ]);
      globalThis.fetch = (async () => new Response(openAiBody, { status: 200 })) as typeof fetch;
      const deltas: string[] = [];
      const streamed = await runAgentStepStreaming(
        'openai',
        'test-key',
        'gpt-4o-mini',
        [{ role: 'user', content: '상태 확인해줘' }],
        [],
        { onDelta: (text) => deltas.push(text) }
      );
      check('스트리밍: 조각이 순서대로 도착', deltas.join('') === '지금 확인할게요.', deltas.join('|'));
      check('스트리밍: 최종 텍스트', streamed.text === '지금 확인할게요.', streamed.text);
      check('스트리밍: 도구 호출 조립', streamed.toolCalls[0]?.name === 'browser_snapshot' && streamed.toolCalls[0]?.args.page === 1);
      check('스트리밍: 토큰 사용량', streamed.usage?.inputTokens === 120 && streamed.usage?.outputTokens === 30);
      check('스트리밍: 표시', streamed.streamed === true);

      // (b) Gemini 형식: 사고 서명이 붙은 functionCall + finishReason
      const geminiBody = sse([
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '시작' }] } }] }),
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: '합니다' }, { functionCall: { name: 'web_search', args: { q: '날씨' } }, thoughtSignature: 'sig' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12 },
        }),
      ]);
      globalThis.fetch = (async () => new Response(geminiBody, { status: 200 })) as typeof fetch;
      const geminiDeltas: string[] = [];
      const geminiRes = await runAgentStepStreaming(
        'gemini',
        'test-key',
        'gemini-3.8-flash',
        [{ role: 'user', content: '검색해줘' }],
        [],
        { onDelta: (text) => geminiDeltas.push(text) }
      );
      check('스트리밍(Gemini): 텍스트', geminiRes.text === '시작합니다', geminiRes.text);
      check('스트리밍(Gemini): 함수 호출 + 서명', geminiRes.toolCalls[0]?.signature === 'sig');
      check('스트리밍(Gemini): finishReason', geminiRes.finishReason === 'STOP');

      // (c) 스트림이 죽으면 비스트리밍으로 폴백(답변을 잃지 않는다)
      let call = 0;
      globalThis.fetch = (async () => {
        call += 1;
        if (call <= 2) return new Response('boom', { status: 500 });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '폴백 답변' }, finish_reason: 'stop' }] }),
          { status: 200 }
        );
      }) as typeof fetch;
      const fallbackDeltas: string[] = [];
      const fallback = await runAgentStepStreaming(
        'openai',
        'test-key',
        'gpt-4o-mini',
        [{ role: 'user', content: '안녕' }],
        [],
        { onDelta: (text) => fallbackDeltas.push(text) }
      );
      check('스트리밍 실패 → 비스트리밍 폴백', fallback.text === '폴백 답변' && fallback.streamed === false, `calls ${call}`);
      check('폴백 답변도 화면에 전달', fallbackDeltas.join('') === '폴백 답변');

      // (d) 개인정보 자리표시자가 조각 경계에서 잘려도 복원된다
      const phone = '010-9876-5432';
      const maskedBody = sse([
        JSON.stringify({ choices: [{ delta: { content: '연락처는 [전' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '화번호 1]' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '입니다.' }, finish_reason: 'stop' }] }),
      ]);
      globalThis.fetch = (async () => new Response(maskedBody, { status: 200 })) as typeof fetch;
      const restored = await runAgentStepStreaming(
        'openai',
        'test-key',
        'gpt-4o-mini',
        [{ role: 'user', content: `내 번호 ${phone} 기억해` }],
        [],
        {}
      );
      check('스트리밍: 마스킹된 번호 복원', restored.text.includes(phone), restored.text);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /*
   * 7c) 에이전트 루프 통합 — 가짜 모델 응답으로 "스트리밍 → 병렬 도구 → 체크포인트 → 트레이스"를 끝까지 돌려 본다.
   *   실제 모델을 부르지 않고(비용·대기 없음) 읽기 전용 도구(time_now·tasks_list)만 실행한다.
   */
  {
    const { runAgentLoop } = await import('../server/agent-loop');
    const realFetch = globalThis.fetch;
    const sse = (events: string[]) => events.map((e) => `data: ${e}\n\n`).join('');
    const toolCallDelta = (index: number, id: string, name: string, args: Record<string, unknown>) =>
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }] } }],
      });
    let turn = 0;
    try {
      globalThis.fetch = (async () => {
        turn += 1;
        if (turn === 1) {
          // 1스텝: 읽기 도구 두 개를 한번에 달라고 한다(병렬 실행 대상)
          return new Response(
            sse([
              JSON.stringify({ choices: [{ delta: { content: '지금 확인할게요.' } }] }),
              toolCallDelta(0, 't1', 'time_now', {}),
              toolCallDelta(1, 't2', 'tasks_list', {}),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
            ]),
            { status: 200 }
          );
        }
        // 2스텝: 최종 답변
        return new Response(
          sse([
            JSON.stringify({ choices: [{ delta: { content: '시각과 할 일을 확인했어요.' } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 20 } }),
          ]),
          { status: 200 }
        );
      }) as typeof fetch;

      const deltas: string[] = [];
      const checkpointSteps: number[] = [];
      const usages: number[] = [];
      const loop = await runAgentLoop({
        provider: 'openai',
        apiKey: 'test-key',
        model: 'gpt-4o-mini',
        system: '테스트',
        history: [{ role: 'user', content: '지금 몇 시고 할 일 뭐 있어?' }],
        tools: [],
        maxSteps: 4,
        userRequest: '지금 몇 시고 할 일 뭐 있어?',
        onDelta: (text) => deltas.push(text),
        onCheckpoint: (snapshot) => checkpointSteps.push(snapshot.step),
        onStepUsage: (info) => usages.push(info.usage?.inputTokens ?? info.estimatedInputTokens),
      });
      check('루프: 두 스텝 실행', loop.steps === 2, `${loop.steps}스텝`);
      check('루프: 읽기 도구 두 개 실행', loop.tools.includes('time_now') && loop.tools.includes('tasks_list'), loop.tools.join(','));
      check('루프: 최종 답변', loop.text === '시각과 할 일을 확인했어요.', loop.text);
      check('루프: 스트리밍 조각 도착', deltas.join('').includes('확인할게요'), deltas.join('|'));
      check('루프: 체크포인트 콜백', checkpointSteps.length >= 2, checkpointSteps.join(','));
      check('루프: 스텝별 사용량 기록', usages.length === 2 && usages[1] === 200, usages.join(','));
      check('루프: 토큰 합산', loop.usage.outputTokens >= 20 && loop.usage.inputTokens >= 200, `${loop.usage.inputTokens}/${loop.usage.outputTokens}`);
      check('루프: 도구 오류 없음', loop.lastError === null);
      check('루프: 완료 시 중단 아님', !loop.cancelled && !loop.loopStopped);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* 8) 회귀 — v0.6.18 / v0.6.19 -------------------------------------------- */
  check('승인 카드(HITL) 유지', loop.includes('requestApproval') && loop.includes('sensitiveToolCall'));
  check('개인정보 마스킹 유지', providersSrc.includes('createMaskerIfEnabled') && providersSrc.includes('restoreChatResult'));
  check('가드레일 유지', loop.includes('guardExternalText(output.content') && loop.includes('EXTERNAL_TOOLS'));
  check('빈 응답 복구 유지', loop.includes('planEmptyRecovery') && loop.includes('MAX_EMPTY_RETRIES'));
  check('재로그인 방지·로그인 카드 유지', index.includes('ensureLoginCard') && index.includes('cancelPendingSince'));
  const skillsSrc = read('server/skills.ts');
  check('지침(read_skill) 유지', skillsSrc.includes('readSkillForTool') && read('server/tool-filter.ts').includes("'read_skill'"));
  const toolFilter = read('server/tool-filter.ts');
  check(
    '도구 필터 시그니처 유지',
    toolFilter.includes('selectToolNames') && toolFilter.includes('skillText') && toolFilter.includes('filterToolsByPrefs')
  );

  /* 9) 개인정보 비노출 ---------------------------------------------------- */
  // 개인 식별 문자열은 공개 저장소에 두지 않는다(오픈소스 배포 조건).
  // 그래서 저장소에서는 개인정보의 '형태'를 검사하고, 유지보수자는 저장소 밖 패턴 파일을
  // 지정해 실명·계정까지 함께 검사한다.
  //   PII_PATTERNS_FILE=/절대/경로/pii-patterns.json   → [["라벨", "정규식"], ...]
  const allow = /(?:you@naver\.com|pomong\.labs@gmail\.com|010-1234-5678|test-user@example\.com|홍길동)/;
  const localFile = process.env.PII_PATTERNS_FILE;
  const localPatterns: [string, RegExp][] =
    localFile && fs.existsSync(localFile)
      ? (JSON.parse(fs.readFileSync(localFile, 'utf8')) as [string, string][]).map(
          ([label, src]) => [label, new RegExp(src)] as [string, RegExp]
        )
      : [];
  const patterns: [string, RegExp][] = [
    ['개인 메일 계정', /[A-Za-z0-9._%+-]+@(?:gmail|naver|daum|hanmail|nate|kakao)\.[A-Za-z.]{2,}/],
    ['전화번호', /\b0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}\b/],
    ['주민등록번호', /\b\d{6}[-.\s]?[1-4]\d{6}\b/],
    ['생년월일', /\b(?:199|200)\d[-./]?(?:0[1-9]|1[0-2])[-./]?(?:0[1-9]|[12]\d|3[01])\b/],
    ...localPatterns,
  ];
  // 문서·데모용으로 일부러 둔 더미 값만 허용한다.
  const piiHit = (re: RegExp, body: string): boolean =>
    (body.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).some(
      (m) => !allow.test(m)
    );
  const targets = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'server')))
    .concat(walk(path.join(ROOT, 'scripts')))
    .concat(walk(path.join(ROOT, 'tools')))
    .concat(walk(path.join(ROOT, 'public')))
    .concat([path.join(ROOT, 'index.html'), path.join(ROOT, 'README.md'), path.join(ROOT, 'SECURITY.md')])
    .filter((file) => /\.(ts|tsx|js|jsx|css|html|md|json|sh|py|txt)$/.test(file));
  for (const [label, re] of patterns) {
    const hits: string[] = [];
    for (const file of targets) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('scripts/smoke-')) continue;
      if (rel.startsWith('public/sw.js')) continue;
      if (piiHit(re, fs.readFileSync(file, 'utf8'))) hits.push(rel);
    }
    check(`개인정보(${label}) 0건`, hits.length === 0, hits.join(', '));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
