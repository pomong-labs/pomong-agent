/**
 * UI 확인용 시드: 임시 데이터에 로그인 카드 하나를 대기 상태로 만든다.
 * 실행: DATA_DIR=/tmp/pa051-ui tsx tools/v051-seed-ui.ts
 */
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/pa051-ui';

async function main() {
  const { db } = await import('../server/db');
  const loginRequests = await import('../server/login-requests');
  const crypto = await import('../server/crypto');
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number } | undefined;
  if (!existing) {
    db.prepare('INSERT INTO users(username, password_hash, created_at) VALUES(?,?,?)').run(
      'tester',
      crypto.hashPassword('passw0rd!23'),
      now
    );
  }
  const { setJson, setSetting } = await import('../server/db');
  setSetting('setup.completed', '1');
  setSetting('setup.completedAt', now);
  const { encrypt, serverKey } = crypto;
  setJson('llm', {
    active: { provider: 'openai', model: 'gpt-4o-mini' },
    accounts: { openai: { apiKeyEnc: encrypt('sk-demo-key-for-ui', serverKey()), connectedAt: now } },
  });
  setJson('profile', {
    nickname: '홍길동',
    theme: 'light',
    language: 'ko',
    agentName: '피몽',
    character: 'pimong',
    tone: 'polite',
  });
  db.prepare('DELETE FROM messages WHERE session_id = ?').run('default');
  db.prepare('DELETE FROM task_runs WHERE session_id = ?').run('default');
  db.prepare("DELETE FROM login_requests WHERE session_id = 'default'").run();
  const said = db
    .prepare('INSERT INTO messages(session_id, role, content, meta, created_at) VALUES(?,?,?,?,?)')
    .run('default', 'user', '깃허브 연동하고싶어', null, now);
  const reply = db
    .prepare('INSERT INTO messages(session_id, role, content, meta, created_at) VALUES(?,?,?,?,?)')
    .run(
      'default',
      'assistant',
      '홍길동 님, 금고에 깃허브 계정 정보가 아직 없어요. 아래 카드에 계정 정보를 입력해 주시면 제가 바로 로그인해 드릴게요!',
      null,
      now
    );
  const request = loginRequests.create({
    sessionId: 'default',
    service: 'GitHub',
    loginUrl: 'https://github.com/login',
    siteHost: 'github.com',
    note: '깃허브는 2단계 인증이 켜져 있으면 인증번호만 따로 물어볼게요.',
  });
  loginRequests.linkPendingToMessage('default', Number(reply.lastInsertRowid));
  console.log('seeded', { user: said.lastInsertRowid, reply: reply.lastInsertRowid, card: request.id });
  process.exit(0);
}

void main();
