/**
 * v0.5.4 핵심 로직 스모크 검증 (서버 전용, 브라우저·모델 호출 없음)
 *
 * 실행: DATA_DIR=... npx tsx scripts/smoke-v054.ts
 */
import assert from 'node:assert';

async function main() {
  const results: string[] = [];
  const ok = (label: string) => results.push(`✅ ${label}`);
  const fail = (label: string, err: unknown) => {
    results.push(`❌ ${label} — ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  };

  // 1) [금고...] 자리표시자 차단
  try {
    const { runTool } = await import('../server/tools');
    const blocked = await runTool('browser_type', { ref: 'e1', text: '[금고의 비밀번호]' });
    assert.match(blocked.content, /차단/);
    assert.match(blocked.content, /browser_login_with_vault/);
    const blocked2 = await runTool('browser_type', { ref: 'e1', text: '[vault password]' });
    assert.match(blocked2.content, /차단/);
    ok('[금고...]·[vault...] 대괄호 문구는 타이핑 차단 + vault 도구 안내');
  } catch (err) {
    fail('[금고...] 차단', err);
  }

  // 2) 2단계 로그인 차단 사유 분류 (구글·MS 화면 문구)
  try {
    const { classifyLoginScreen } = await import('../server/browser');
    assert.equal(classifyLoginScreen('패스키를 사용하여 로그인'), 'passkey');
    assert.equal(classifyLoginScreen('비밀번호를 입력하세요. 보안문자를 입력해 주세요.'), 'captcha');
    assert.equal(classifyLoginScreen('인증번호 6자리를 입력하세요'), 'otp');
    assert.equal(classifyLoginScreen('아이디 또는 비밀번호가 일치하지 않습니다'), 'wrong_password');
    assert.equal(classifyLoginScreen('이메일로 인증 링크를 보냈습니다'), 'email_verify');
    assert.equal(classifyLoginScreen('다음'), null);
    ok('2단계 로그인 화면 문구 → passkey·captcha·otp·wrong_password·email_verify 판별');
  } catch (err) {
    fail('로그인 차단 사유 분류', err);
  }

  // 3) 금고 PIN 해제 카드 생성·목록·상태
  try {
    const vaultUnlock = await import('../server/vault-unlock');
    const card = vaultUnlock.create({
      sessionId: 'smoke-session',
      service: '무신사',
      loginUrl: 'https://member.one.musinsa.com/login',
      vaultId: 'vault-1',
      intent: JSON.stringify({ tool: 'browser_login_with_vault', vaultId: 'vault-1' }),
      note: '금고가 잠겨 있어 자동 입력을 시작하지 못했습니다.',
    });
    assert.equal(card.status, 'pending');
    assert.equal(card.service, '무신사');
    // 같은 방에 또 만들면 새 카드가 아니라 기존 카드를 쓴다.
    const again = vaultUnlock.create({ sessionId: 'smoke-session', service: '무신사' });
    assert.equal(again.id, card.id);
    assert.equal(vaultUnlock.listForSession('smoke-session').length, 1);
    vaultUnlock.setStatus(card.id, 'unlocked');
    const after = vaultUnlock.get(card.id);
    assert.equal(after?.status, 'unlocked');
    assert.equal(vaultUnlock.listForSession('smoke-session')[0]?.status, 'unlocked');
    ok('금고 PIN 카드 생성·중복 방지·해제 상태 저장');
  } catch (err) {
    fail('PIN 해제 카드', err);
  }

  // 4) 금고 잠금 → lockedVaultResponse(카드 생성) 경로
  try {
    const vault = await import('../server/vault');
    const vaultUnlock = await import('../server/vault-unlock');
    const { runTool } = await import('../server/tools');
    const db = (await import('../server/db')).db;
    db.prepare('DELETE FROM vault_items').run();
    vault.initVault('1234');
    const id = vault.createItem({ title: '무신사', type: 'login', username: 'smoke@example.com', secret: 'pw-1234', isDefault: true });
    assert.equal(vault.secretForFill(id).secret, 'pw-1234');
    vault.lockVault();
    const res = await runTool('browser_login_with_vault', { vault_id: id }, { session: 'smoke-session-2' });
    assert.equal(res.flags?.vaultLockedCardCreated, true);
    assert.match(res.content, /PIN/);
    const cards = vaultUnlock.listForSession('smoke-session-2');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].vaultId, id);
    assert.ok(!JSON.stringify(cards).includes('pw-1234'), '카드에 비밀번호가 남으면 안 된다');
    assert.equal(vault.unlockVault('1234'), true);
    ok('금고 잠금 시 PIN 카드 자동 생성(비밀번호는 카드·로그에 없음)');
  } catch (err) {
    fail('금고 잠금 카드 경로', err);
  }

  // 5) 자동 기억 추출: 필터·파싱·중복 제거
  try {
    const mx = await import('../server/memory-extract');
    assert.equal(mx.shouldExtract('안녕', '안녕하세요!'), false);
    assert.equal(mx.shouldExtract('오늘 인제 날씨 어때?', '맑고 12도입니다.'), false);
    assert.equal(mx.shouldExtract('[시스템] 이어서 하세요', '네 이어서 할게요'), false);
    assert.equal(mx.shouldExtract('나는 지금 군 복무 중이고 취사병이야', '군 복무 중이시군요. 취사병 근무 화이팅이에요!'), true);
    const parsed = mx.parseExtraction(
      '```json\n[{"category":"profile","content":"군 복무 중인 취사병이다","importance":4},{"category":"weird","content":"","importance":9}]\n```'
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].category, 'profile');
    assert.equal(parsed[0].importance, 4);
    const existing = ['아침 7시에 일어난다', '아침 브리핑은 서울 날씨로 받는다'];
    assert.equal(mx.isDuplicate('군 복무 중인 취사병이다', existing), true);
    assert.equal(mx.isDuplicate('군 복무 중인 취사병이다!', existing), true);
    assert.equal(mx.isDuplicate('서든어택을 즐겨 한다', existing), false);
    ok('자동 기억 추출 필터·JSON 파싱·중복(문구/토큰) 제거');
  } catch (err) {
    fail('자동 기억 추출', err);
  }

  // 6) 다중 대화방: 생성·이름변경·자동 제목·삭제(기본 방 보존)
  try {
    const sessions = await import('../server/sessions');
    const db = (await import('../server/db')).db;
    const created = sessions.createSession();
    assert.equal(created.title.startsWith('새 대화'), true);
    const renamed = sessions.renameSession(created.id, '무신사 로그인');
    assert.equal(renamed?.title, '무신사 로그인');
    db.prepare('INSERT INTO messages(session_id, role, content, created_at) VALUES(?,?,?,?)').run(
      created.id,
      'user',
      '무신사 장바구니 확인해줘',
      new Date().toISOString()
    );
    const listed = sessions.listSessions();
    assert.ok(listed.some((s) => s.id === created.id && s.messageCount === 1));
    // 제목이 자동으로 붙는 방
    const fresh = sessions.createSession();
    sessions.autoTitle(fresh.id, '이번 주 서버 상태 요약해줘');
    assert.match(sessions.getSession(fresh.id)?.title || '', /서버 상태/);
    const del = sessions.deleteSession(created.id);
    assert.equal(del.deletedMessages, 1);
    assert.equal(sessions.getSession(created.id), null);
    // 'default' 방은 지워지지 않고 대화만 비워진다
    db.prepare('INSERT INTO messages(session_id, role, content, created_at) VALUES(?,?,?,?)').run(
      'default',
      'user',
      '안녕',
      new Date().toISOString()
    );
    const delDefault = sessions.deleteSession('default');
    assert.equal(delDefault.keptDefault, true);
    assert.ok(sessions.getSession('default'));
    assert.equal(sessions.getSession('default')?.messageCount, 0);
    ok('다중 대화방 생성·이름변경·자동 제목·삭제(기본 방 보존)');
  } catch (err) {
    fail('다중 대화방', err);
  }

  // 7) 기본 'default' 대화 보존 확인 (마이그레이션)
  try {
    const db = (await import('../server/db')).db;
    const row = db.prepare("SELECT id, title FROM chat_sessions WHERE id = 'default'").get() as { id: string; title: string };
    assert.equal(row.id, 'default');
    ok("기존 'default' 방이 목록에 존재(기존 대화 보존)");
  } catch (err) {
    fail('default 방 보존', err);
  }

  console.log('\n' + results.join('\n') + '\n');
  console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK');
}

void main();
