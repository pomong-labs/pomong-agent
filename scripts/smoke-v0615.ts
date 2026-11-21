/**
 * v0.6.15 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0615.ts
 *
 * 이미지 생성·편집 · QR · 말풍선 리액션 검증. 외부 네트워크 없이 본다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset ↔ More/Settings)
 *   2) 도구 등록 — generate_image·edit_image·create_qr·react_to_message (스펙·카탈로그·라벨·그룹)
 *   3) 의도 감지 — 그림/사진 편집/QR 요청에 image 그룹이 붙는지
 *   4) 리액션 — 이모지 정규화 · 대상 찾기 · 중복/최대 3개 · 메시지 삭제 시 정리(트리거)
 *   5) 이미지 — 모델 선택 · 오류 문구(한도/정책) · 키 없음 안내
 *   6) QR — payload 규칙(URL·와이파이 이스케이프) · 실제 PNG 생성·저장
 *   7) 채팅 연결 — 답변 말풍선에 그림 붙이기 · SSE chat_reaction · 화면 뱃지
 *   8) 회귀 — PWA 메타·poppler, 개인정보 0건
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0615-'));
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
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');
  const { db } = await import('../server/db');
  const tools = await import('../server/tools');
  const filter = await import('../server/tool-filter');
  const reactions = await import('../server/reactions');
  const images = await import('../server/images');
  const filesBox = await import('../server/files');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  // v0.6.16 이후: 버전 표기가 한 값으로 모여 있는지만 본다.
  check('버전 0.6.x', /^0\.6\.\d+$/.test(pkg.version), pkg.version);
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check(
    'docker-compose 이미지 태그',
    compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`)
  );
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check('에셋 캐시 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check(
    'More·Settings 표시 버전',
    read('src/pages/More.tsx').includes(`useState('${pkg.version}')`) &&
      read('src/pages/Settings.tsx').includes(`|| '${pkg.version}'`)
  );

  /* 2) 도구 등록 ----------------------------------------------------------- */
  const names = tools.TOOL_SPECS.map((spec) => spec.name);
  for (const name of ['generate_image', 'edit_image', 'create_qr', 'react_to_message']) {
    const spec = tools.TOOL_SPECS.find((s) => s.name === name);
    check(`도구 스펙 ${name}`, Boolean(spec) && spec!.description.length > 30, spec ? `${spec.description.length}자` : '없음');
  }
  check(
    'generate_image 필수 인자 prompt',
    JSON.stringify(tools.TOOL_SPECS.find((s) => s.name === 'generate_image')?.parameters).includes('"prompt"')
  );
  check(
    'edit_image 필수 인자 instruction + source_image_id',
    (() => {
      const spec = tools.TOOL_SPECS.find((s) => s.name === 'edit_image');
      const params = JSON.stringify(spec?.parameters);
      return params.includes('"instruction"') && params.includes('source_image_id') && params.includes('required');
    })()
  );
  check(
    'create_qr 와이파이 인자',
    (() => {
      const params = JSON.stringify(tools.TOOL_SPECS.find((s) => s.name === 'create_qr')?.parameters);
      return params.includes('wifi_ssid') && params.includes('wifi_password') && params.includes('url');
    })()
  );
  for (const name of ['generate_image', 'edit_image', 'create_qr', 'react_to_message']) {
    const entry = tools.TOOL_CATALOG.find((item) => item.name === name);
    check(`도구 카탈로그 ${name}`, Boolean(entry?.label && entry?.summary), entry?.label || '없음');
    check(`도구 이름표 ${name}`, Boolean(tools.TOOL_LABELS[name]), tools.TOOL_LABELS[name] || '없음');
  }
  check(
    '도구 그룹 image = 그림 3종',
    JSON.stringify(filter.TOOL_GROUPS.image) === JSON.stringify(['generate_image', 'edit_image', 'create_qr']),
    JSON.stringify(filter.TOOL_GROUPS.image)
  );
  check('react_to_message는 기본 대화 그룹', filter.CORE_TOOLS.includes('react_to_message'));
  check('도구 관리자 화면에 image 그룹', filter.TOOL_GROUP_META.some((g) => g.id === 'image'));
  // 그룹에 들어간 도구 이름이 실제 스펙에 모두 존재하는지(이름 오타로 ON/OFF가 비는 일 방지)
  const allGroupTools = Object.values(filter.TOOL_GROUPS).flat();
  const missing = allGroupTools.filter((name) => !names.includes(name));
  check('그룹 도구 이름이 모두 실제 스펙에 존재', missing.length === 0, missing.join(', '));

  /* 3) 의도 감지 ----------------------------------------------------------- */
  const pick = (text: string) => filter.selectToolNames({ userRequest: text }).tools;
  const has = (list: string[] | null, name: string) => Boolean(list && list.includes(name));
  check('그림 그려줘 → generate_image', has(pick('겨울 카페 그림 그려줘'), 'generate_image'));
  check('로고 만들어줘 → generate_image', has(pick('카페 로고 만들어줘'), 'generate_image'));
  check('이 사진 배경 바꿔줘 → edit_image', has(pick('이 사진 배경 바꿔줘'), 'edit_image'));
  check('사진 편집 요청이면 첨부 도구도 함께', has(pick('사진 스타일 바꿔줘'), 'attachment_read'));
  check('QR 만들어줘 → create_qr', has(pick('내 블로그 링크 QR 코드 만들어줘'), 'create_qr'));
  check('와이파이 QR → create_qr', has(pick('와이파이 QR 만들어줘'), 'create_qr'));
  check('일상 대화는 전체 허용(기능 축소 없음)', pick('오늘 기분 어때') === null);

  /* 4) 리액션 -------------------------------------------------------------- */
  const norm = reactions.normalizeReaction;
  check('리액션 이모지 🎉', norm('🎉') === '🎉');
  check('리액션 이모지 ❤️(변형선택자)', norm('❤️') === '❤️');
  check('리액션 이모지 👍🏽(피부색)', norm('👍🏽') === '👍🏽');
  check('리액션은 이모지 하나만(문자 거부)', norm('좋아요') === null);
  check('리액션은 이모지 하나만(여러 글자 거부)', norm('🎉🎉🎉') === null);
  check('빈 리액션 거부', norm('') === null);

  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO chat_sessions(id, title, created_at, updated_at) VALUES(?,?,?,?)').run('s1', '테스트', now, now);
  const m1 = Number(
    db.prepare('INSERT INTO messages(session_id, role, content, created_at) VALUES(?,?,?,?)').run('s1', 'user', '오늘 시험 붙었어!', now).lastInsertRowid
  );
  const m2 = Number(
    db.prepare('INSERT INTO messages(session_id, role, content, created_at) VALUES(?,?,?,?)').run('s1', 'assistant', '축하해요!', now).lastInsertRowid
  );
  const targetLatest = reactions.resolveTarget('s1', {});
  check('대상 생략 → 방금 받은 사용자 메시지', 'row' in targetLatest && targetLatest.row.id === m1);
  const targetQuery = reactions.resolveTarget('s1', { query: '시험' });
  check('본문 일부로 대상 찾기', 'row' in targetQuery && targetQuery.row.id === m1);
  check('다른 방 메시지는 대상 아님', 'error' in reactions.resolveTarget('s2', { messageId: m1 }));

  const first = reactions.addReaction({ sessionId: 's1', messageId: m1, emoji: '🎉' });
  check('리액션 저장', first.ok && JSON.stringify(first.reactions) === JSON.stringify(['🎉']), JSON.stringify(first.reactions));
  const again = reactions.addReaction({ sessionId: 's1', messageId: m1, emoji: '🎉' });
  check('같은 이모지는 한 번만(중복 없음)', again.ok && reactions.listForMessage(m1).length === 1);
  reactions.addReaction({ sessionId: 's1', messageId: m1, emoji: '❤️' });
  reactions.addReaction({ sessionId: 's1', messageId: m1, emoji: '👍' });
  const fourth = reactions.addReaction({ sessionId: 's1', messageId: m1, emoji: '😂' });
  check('한 말풍선 최대 3개', !fourth.ok && reactions.listForMessage(m1).length === 3, String(fourth.error || ''));
  check('여러 메시지 리액션 묶음', reactions.listForMessages([m1, m2])[m1]?.length === 3);
  check('메시지가 없으면 0개', reactions.listForMessages([m2])[m2] === undefined);

  /* 5) 이미지 -------------------------------------------------------------- */
  check(
    '이미지 모델 선택 — 3.1 flash image 우선',
    images.pickImageModel(['gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image']) === 'gemini-3.1-flash-image'
  );
  check('이미지 모델 선택 — 목록에 하나뿐이면 그것', images.pickImageModel(['gemini-9-experimental-image']) === 'gemini-9-experimental-image');
  check('이미지 모델 없음 → null', images.pickImageModel(['gemini-3.8-flash']) === null);
  const quota = images.describeImageError(429, '{"error":{"message":"exceeded your current quota"}}', 'gemini-3.1-flash-image');
  check('한도(429) 안내에 이유·모델', quota.includes('한도') && quota.includes('gemini-3.1-flash-image'), quota.slice(0, 60));
  const safety = images.describeImageError(400, '{"error":{"message":"blocked"}}', 'gemini-3.1-flash-image');
  check('400 안내에 안전 정책 안내', safety.includes('안전 정책'), safety.slice(0, 50));
  check(
    '그림 없이 글만 온 응답은 오류로',
    (() => {
      try {
        images.extractImage({ candidates: [{ content: { parts: [{ text: '그릴 수 없어요' }] }, finishReason: 'STOP' }] }, 'x');
        return false;
      } catch (err) {
        return err instanceof Error && err.message.includes('그림 대신 글');
      }
    })()
  );
  const noKey = await images.generateImageTool({ sessionId: 's1', prompt: '고양이' });
  check('Gemini 키가 없으면 안내', !noKey.ok && noKey.content.includes('Gemini 키'), noKey.content.slice(0, 40));
  // 가짜 키를 넣어 '고칠 사진이 없을 때' 안내를 본다(원본이 없으면 네트워크를 부르지 않는다).
  {
    const { encrypt, serverKey } = await import('../server/crypto');
    const { setJson } = await import('../server/db');
    setJson('llm.state', {
      active: { provider: 'gemini', model: 'gemini-3.8-flash' },
      accounts: { gemini: { apiKeyEnc: encrypt('smoke-fake-key', serverKey()), connectedAt: now } },
    });
  }
  check(
    '편집 대상 없으면 안내',
    (await images.editImageTool({ sessionId: 's2', instruction: '배경 바꿔' })).content.includes('고칠 사진')
  );
  check('그림 파일 이름 규칙', images.imageFileName('image', 'image/png', new Date(2026, 10, 21, 9, 38, 12)) === 'pomong-image-20261121-093812.png');

  /* 6) QR ------------------------------------------------------------------ */
  const url = images.resolveQrPayload({ text: 'example.com' });
  check('QR URL에 https 자동', 'payload' in url && url.payload === 'https://example.com', 'payload' in url ? url.payload : url.error);
  const plain = images.resolveQrPayload({ text: '안녕하세요', kind: 'text' });
  check('QR 글자는 그대로', 'payload' in plain && plain.payload === '안녕하세요');
  const wifi = images.buildWifiPayload({ ssid: 'Cafe;WiFi', password: 'p:a;ss', security: 'WPA' });
  check('와이파이 payload 이스케이프', wifi === 'WIFI:T:WPA;S:Cafe\\;WiFi;P:p\\:a\\;ss;;', wifi);
  const openWifi = images.buildWifiPayload({ ssid: 'Free' });
  check('비밀번호 없는 와이파이는 nopass', openWifi === 'WIFI:T:nopass;S:Free;;', openWifi);
  check('QR 내용이 너무 길면 거부', 'error' in images.resolveQrPayload({ text: 'a'.repeat(1300), kind: 'text' }));
  const qr = await images.createQrTool({ sessionId: 's1', text: 'https://example.com', size: 512 });
  check('QR PNG 생성', qr.ok && qr.content.includes('QR'), qr.content.slice(0, 50));
  if (qr.attachmentIds?.length) {
    const row = db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(qr.attachmentIds[0]) as
      | { path: string; mime: string; kind: string }
      | undefined;
    const abs = row ? path.join(process.env.DATA_DIR as string, row.path) : '';
    const buf = row && fs.existsSync(abs) ? fs.readFileSync(abs) : Buffer.alloc(0);
    check('QR 파일이 PNG로 저장', Boolean(row) && row!.kind === 'image' && buf.subarray(0, 4).toString('hex') === '89504e47', `${buf.length}B`);
    check('QR 파일함 목록에 등록', filesBox.listFiles({}).some((item) => item.id === `a:${qr.attachmentIds![0]}`));
  } else {
    check('QR 파일이 PNG로 저장', false, '첨부 id 없음');
  }

  /* 7) 채팅 연결 ----------------------------------------------------------- */
  const indexSrc = read('server/index.ts');
  check('답변 말풍선에 만든 그림 첨부', /attachToMessage\(generatedImages/.test(indexSrc));
  check('만든 그림 flags 수집', /flags\?\.images/.test(indexSrc));
  check('대화 목록에 리액션 포함', /reactions: reactionMap\[r\.id\]/.test(indexSrc));
  check('보낸 메시지 응답에 리액션 포함', /reactions: reactions\.listForMessage\(userMessageId\)/.test(indexSrc));
  check('시스템 프롬프트에 그림 지침', indexSrc.includes('generate_image(새로 만들기)'));
  check('시스템 프롬프트에 리액션 아끼기 지침', indexSrc.includes('말풍선 리액션(react_to_message)'));
  const toolSrc = read('server/tools.ts');
  check('리액션 SSE 발행', toolSrc.includes("type: 'chat_reaction'") && toolSrc.includes('messageId: target.row.id'));
  check('이벤트 타입에 chat_reaction', read('server/events.ts').includes("'chat_reaction'") && read('src/lib/api.ts').includes("'chat_reaction'"));
  check('스토어가 chat_reaction 반영', read('src/lib/store.tsx').includes("event.type === 'chat_reaction'"));
  const chat = read('src/pages/Chat.tsx');
  check('말풍선 리액션 뱃지 렌더', chat.includes('<ReactionBadges') && chat.includes('m.reactions?.length'));
  check('리액션 뱃지 다크 모드', /ReactionBadges[\s\S]{0,900}dark:bg-\[#2B2838\]/.test(chat));
  check('ChatMessage 타입에 reactions', read('src/lib/api.ts').includes('reactions?: string[]'));

  // 메시지를 지우면 리액션도 함께 정리(트리거)
  db.prepare('DELETE FROM messages WHERE id = ?').run(m1);
  check('메시지 삭제 시 리액션 정리', reactions.listForMessage(m1).length === 0, `${reactions.countReactions('s1')}건`);

  /* 8) 회귀 ---------------------------------------------------------------- */
  const html = read('index.html');
  check('viewport-fit=cover 유지', html.includes('viewport-fit=cover'));
  check('poppler-utils·poppler-data 유지', read('Dockerfile').includes('poppler-utils poppler-data'));
  check('qrcode 의존성 등록', (JSON.parse(read('package.json')) as { dependencies: Record<string, string> }).dependencies.qrcode?.length > 0);

  const patterns: [string, RegExp][] = [
    ['이름', /김현준|현준/],
    ['네이버 아이디', /hyunjun|kimhj050326/i],
    ['깃허브 핸들', /khjkr/i],
    ['전화번호', /4343-?5216/],
    ['거주지 예시', /익산시 평동로/],
  ];
  const targets = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'server')))
    .concat(walk(path.join(ROOT, 'scripts')))
    .concat(walk(path.join(ROOT, 'tools')))
    .concat(walk(path.join(ROOT, 'public')))
    .concat([path.join(ROOT, 'index.html'), path.join(ROOT, 'README.md'), path.join(ROOT, 'SECURITY.md')])
    .filter((file) => /\.(ts|tsx|js|jsx|css|html|md|json|sh|py)$/.test(file));
  for (const [label, re] of patterns) {
    const hits: string[] = [];
    for (const file of targets) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('scripts/smoke-')) continue;
      if (rel.startsWith('public/sw.js')) continue;
      if (re.test(fs.readFileSync(file, 'utf8'))) hits.push(rel);
    }
    check(`개인정보(${label}) 0건`, hits.length === 0, hits.join(', '));
  }

  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
