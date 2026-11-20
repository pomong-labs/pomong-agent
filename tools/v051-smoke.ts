/**
 * v0.5.1 로컬 스모크 테스트 (실제 LLM 호출 없음)
 *
 * 실제 서버를 임시 DATA_DIR로 띄우고, global.fetch만 가짜로 바꿔 OpenAI 응답을
 * 흉내 낸다. 확인하는 것:
 *  1) 일반 대화·chat_notify만 있는 턴 → 작업 카드(task_run)가 만들어지지 않는다
 *  2) 실제 도구가 돈 턴 → 카드가 만들어지고 단계가 쌓인다
 *  3) 금고에 계정이 없을 때 vault_request_login → 채팅 로그인 카드 생성
 *  4) 카드 저장 → 금고에 암호화 저장 + AI 후속 턴 트리거 + 답변 저장
 *  5) 뒤로가기: /api/version, 화면 빌드 확인은 별도
 *
 * 실행: DATA_DIR=/tmp/pa051 PORT=3199 tsx tools/v051-smoke.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/tmp/pa051-smoke';
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.PORT = process.env.PORT || '3199';
process.env.HOST = '127.0.0.1';

const realFetch = globalThis.fetch.bind(globalThis);
const calls: { lastUser: string; toolNames: string[] }[] = [];
let script: { mode: 'text' | 'notify' | 'login-card' | 'followup' } = { mode: 'text' };

function completion(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('api.openai.com/v1/models')) {
    return completion({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] });
  }
  if (url.includes('api.openai.com/v1/chat/completions')) {
    const body = JSON.parse(String(init?.body || '{}')) as { messages?: { role: string; content?: string }[] };
    const msgs = body.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
    const toolResult = msgs[msgs.length - 1]?.role === 'tool';
    calls.push({ lastUser, toolNames: msgs.filter((m) => m.role === 'tool').length ? ['(tool turn)'] : [] });
    const said = (text: string) => completion({ choices: [{ message: { role: 'assistant', content: text } }] });
    const toolCall = (name: string, args: Record<string, unknown>) =>
      completion({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: `call_${name}_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
            },
          },
        ],
      });

    if (lastUser.includes('[시스템]') && lastUser.includes('로그인 정보를 금고')) {
      return said('금고에 저장된 계정으로 깃허브 로그인을 마쳤어요.');
    }
    if (script.mode === 'login-card') {
      if (!toolResult) return toolCall('vault_request_login', { service: 'GitHub', login_url: 'https://github.com/login', site_host: 'github.com' });
      return said('아래 카드에 계정 정보를 입력해 주시면 제가 바로 로그인해 드릴게요!');
    }
    if (script.mode === 'notify') {
      if (!toolResult) return toolCall('chat_notify', { text: '잠시만요, 확인해 볼게요!' });
      return said('확인했어요. 더 도와드릴 일이 있을까요?');
    }
    return said('저는 포몽이에요. 무엇을 도와드릴까요?');
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

/* ------------------------------- helpers ------------------------------ */

let cookie = '';

async function api(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await realFetch(`http://127.0.0.1:${process.env.PORT}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 서버 기동 (index.ts가 listen까지 한다)
  await import('../server/index');
  await sleep(1200);

  /* 1. 초기 설정: 토큰 → 계정 → OpenAI 키 → 완료 */
  const state = await api('/api/setup/state');
  const token = fs.existsSync(path.join(DATA_DIR, 'setup-token.txt'))
    ? fs.readFileSync(path.join(DATA_DIR, 'setup-token.txt'), 'utf8').trim()
    : '';
  check('setup state', Boolean(token) || !state.body?.tokenRequired, JSON.stringify(state.body).slice(0, 120));
  if (token) {
    await api('/api/setup/verify-token', { method: 'POST', body: JSON.stringify({ token }) });
    await api('/api/setup/account', { method: 'POST', body: JSON.stringify({ username: 'tester', password: 'passw0rd!23' }) });
    const prov = await api('/api/setup/provider', {
      method: 'POST',
      body: JSON.stringify({ provider: 'openai', apiKey: 'sk-test-123', model: 'gpt-4o-mini' }),
    });
    check('setup provider', prov.status === 200, JSON.stringify(prov.body).slice(0, 160));
    await api('/api/setup/preferences', { method: 'POST', body: JSON.stringify({ nickname: '테스터', tone: 'polite', character: 'pimong' }) });
    const done = await api('/api/setup/complete', { method: 'POST', body: JSON.stringify({}) });
    check('setup complete', done.status === 200, JSON.stringify(done.body).slice(0, 160));
  }
  const me = await api('/api/auth/me');
  if (me.status !== 200) {
    const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'tester', password: 'passw0rd!23' }) });
    check('login', login.status === 200, JSON.stringify(login.body).slice(0, 120));
  }
  const me2 = await api('/api/auth/me');
  check('signed in', me2.status === 200 && me2.body?.ok === true, `status ${me2.status}`);

  /* 2. 일반 대화 → 작업 카드 없음 */
  script = { mode: 'text' };
  const plain = await api('/api/chat/messages', { method: 'POST', body: JSON.stringify({ message: '너이름은뭐야' }) });
  check('plain chat replies', plain.status === 200 && Boolean(plain.body?.message?.content), `status ${plain.status}`);
  check('plain chat has no task card', plain.body?.taskRun === null, JSON.stringify(plain.body?.taskRun));
  const afterPlain = await api('/api/chat/messages');
  check('no task_runs rows after plain chat', (afterPlain.body?.taskRuns || []).length === 0, JSON.stringify(afterPlain.body?.taskRuns));

  /* 3. chat_notify만 있는 턴 → 작업 카드 없음, 안내 말풍선은 남음 */
  script = { mode: 'notify' };
  const notify = await api('/api/chat/messages', { method: 'POST', body: JSON.stringify({ message: '오늘 뭐 해야 돼?' }) });
  check('notify turn has no task card', notify.body?.taskRun === null, JSON.stringify(notify.body?.taskRun));
  const afterNotify = await api('/api/chat/messages');
  const notices = (afterNotify.body?.messages || []).filter((m: any) => m.meta?.type === 'notice');
  check('notify bubble saved', notices.length === 1, `${notices.length} notice`);
  check('no task_runs rows after notify turn', (afterNotify.body?.taskRuns || []).length === 0, JSON.stringify(afterNotify.body?.taskRuns));

  /* 4. 금고에 계정 없이 로그인 요청 → vault_request_login 카드 */
  script = { mode: 'login-card' };
  const link = await api('/api/chat/messages', { method: 'POST', body: JSON.stringify({ message: '깃허브 연동하고싶어' }) });
  check('login card turn replies', link.status === 200, `status ${link.status}`);
  check('task card created for real tool', Boolean(link.body?.taskRun?.id) && (link.body?.taskRun?.steps || 0) === 1, JSON.stringify(link.body?.taskRun?.steps));
  const cards = await api('/api/vault/login-cards');
  const card = (cards.body?.requests || [])[0];
  check('login card created', Boolean(card?.id) && card.status === 'pending', JSON.stringify(card));
  check('card linked to reply message', card?.messageId === link.body?.message?.id, `${card?.messageId} vs ${link.body?.message?.id}`);
  check('vault not configured yet', cards.body?.configured === false, JSON.stringify({ c: cards.body?.configured, u: cards.body?.unlocked }));

  /* 5. 카드 제출 → 금고 저장 + 후속 턴 */
  const submit = await api(`/api/vault/login-card/${card.id}/submit`, {
    method: 'POST',
    body: JSON.stringify({ username: 'you@example.com', password: 'p@ssw0rd-very-secret', masterPin: '1234' }),
  });
  check('card submit ok', submit.status === 200 && Boolean(submit.body?.vaultId), JSON.stringify(submit.body).slice(0, 160));
  const afterSubmit = await api('/api/vault/login-cards');
  check('card marked submitted', (afterSubmit.body?.requests || [])[0]?.status === 'submitted', JSON.stringify(afterSubmit.body?.requests?.[0]?.status));
  const items = await api('/api/vault/items');
  const item = (items.body?.items || [])[0];
  check('vault item saved with default flag', Boolean(item?.id) && item?.isDefault === true && item?.type === 'login', JSON.stringify(item));

  // 후속 턴은 백그라운드 → 잠시 기다린 뒤 답변 확인
  await sleep(1500);
  const final = await api('/api/chat/messages');
  const followups = (final.body?.messages || []).filter((m: any) => String(m.content).includes('로그인을 마쳤어요'));
  check('follow-up turn produced a reply', followups.length === 1, `${followups.length}`);

  // 비밀번호가 어디에도 남지 않았는지 확인 (WAL 포함)
  const dbFiles = ['pomong-agent.db', 'pomong-agent.db-wal'].map((f) => path.join(DATA_DIR, f)).filter((f) => fs.existsSync(f));
  const leaked = dbFiles.some((f) => fs.readFileSync(f).includes(Buffer.from('p@ssw0rd-very-secret')));
  check('password not stored in plaintext', !leaked, leaked ? 'FOUND plaintext password in db' : 'ok');
  const messagesJson = JSON.stringify(final.body?.messages || []);
  check('password not in chat messages', !messagesJson.includes('p@ssw0rd-very-secret'), 'ok');

  /* 6. 잘못된 PIN으로는 저장되지 않는다 */
  const bad = await api(`/api/vault/login-card/${card.id}/submit`, {
    method: 'POST',
    body: JSON.stringify({ username: 'x@y.z', password: 'another-secret', masterPin: '0000' }),
  });
  check('second submit refused', bad.status === 409 || bad.status === 401, `status ${bad.status}`);

  /* 7. 닫기(취소) */
  script = { mode: 'login-card' };
  await api('/api/chat/messages', { method: 'POST', body: JSON.stringify({ message: '노션 연동하고싶어' }) });
  const cards2 = await api('/api/vault/login-cards');
  const pending = (cards2.body?.requests || []).find((r: any) => r.status === 'pending');
  if (pending) {
    await api(`/api/vault/login-card/${pending.id}/cancel`, { method: 'POST' });
    const after = await api('/api/vault/login-cards');
    check('cancelled card hidden', !(after.body?.requests || []).some((r: any) => r.id === pending.id), 'ok');
  } else {
    check('cancelled card hidden', false, 'no pending card');
  }

  /* 8. 버전 */
  const version = await api('/api/version');
  check('version is 0.5.1', version.body?.version === '0.5.1', JSON.stringify(version.body));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

void main();
