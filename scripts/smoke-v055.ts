/**
 * v0.5.5 핵심 로직 · API 스모크 (브라우저·모델 호출 없음)
 *
 * 실행: DATA_DIR=/tmp/pa-smoke npx tsx scripts/smoke-v055.ts
 *
 * 1) 아이폰 Load failed 판별(네트워크 단절 vs 진짜 서버 오류)
 * 2) 파일함 경로 탈출(`..`) 차단 · 안전한 Content-Disposition
 * 3) 파일 저장·목록·내려받기·삭제 (모듈)
 * 4) 실제 express 서버로 /api/files 목록·내려받기·삭제·탈출 차단
 */
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const LOGIC_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-v055-')), 'logic');
const HTTP_DIR = path.join(path.dirname(LOGIC_DIR), 'http');
fs.mkdirSync(LOGIC_DIR, { recursive: true });
fs.mkdirSync(HTTP_DIR, { recursive: true });
process.env.DATA_DIR = LOGIC_DIR;

const results: string[] = [];
const ok = (label: string) => results.push(`✅ ${label}`);
const fail = (label: string, err: unknown) => {
  results.push(`❌ ${label} — ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
};

async function logicTests(): Promise<void> {
  const { isNetworkError, decideTurnOutcome } = await import('../src/lib/network');
  const { ApiError } = await import('../src/lib/api');

  try {
    assert.equal(isNetworkError(new TypeError('Load failed')), true, 'Safari Load failed');
    assert.equal(isNetworkError(new TypeError('Failed to fetch')), true, 'Chrome Failed to fetch');
    assert.equal(isNetworkError(new Error('NetworkError when attempting to fetch resource.')), true, 'Firefox NetworkError');
    assert.equal(isNetworkError(new DOMException('aborted', 'AbortError')), true, 'AbortError');
    assert.equal(isNetworkError(new ApiError('키 오류', 'no_provider', 409)), false, 'ApiError는 네트워크 오류가 아님');
    assert.equal(isNetworkError(new ApiError('AI 응답 실패', 'provider_error', 502)), false, '5xx ApiError도 오류 카드');
    assert.equal(isNetworkError(new Error('일반 오류')), false, '일반 오류');
    ok('Load failed·Failed to fetch·NetworkError·AbortError만 네트워크 단절로 판별(ApiError 제외)');
  } catch (err) {
    fail('네트워크 단절 판별', err);
  }

  try {
    // 끊긴 뒤 서버 상태에 따라 어떻게 마무리할지
    assert.equal(decideTurnOutcome({ freshReply: true, running: false, busy: false, agentError: null, delivered: false }), 'reply', '답장 도착');
    assert.equal(decideTurnOutcome({ freshReply: false, running: true, busy: false, agentError: null, delivered: true }), 'wait', '서버가 아직 실행 중 → 계속 대기');
    assert.equal(decideTurnOutcome({ freshReply: false, running: false, busy: true, agentError: null, delivered: true }), 'wait', '상태가 작업 중 → 계속 대기');
    assert.equal(decideTurnOutcome({ freshReply: false, running: false, busy: false, agentError: 'quota exceeded', delivered: true }), 'error', '진짜 서버 오류 → 오류 카드');
    assert.equal(decideTurnOutcome({ freshReply: false, running: false, busy: false, agentError: null, delivered: false }), 'lost', '서버에 닿지 않음 → 다시 보내기 안내');
    assert.equal(decideTurnOutcome({ freshReply: false, running: false, busy: false, agentError: null, delivered: true }), 'ended', '중지·빈 응답 → 조용히 정리');
    ok('복구 분기: 답장·대기·오류·미전송·종료 5가지 판단');
  } catch (err) {
    fail('복구 분기 판단', err);
  }

  const files = await import('../server/files');
  const { DATA_DIR } = await import('../server/config');

  try {
    assert.ok(files.resolveInside('uploads/202611/a.png'), '정상 상대 경로');
    assert.equal(files.resolveInside('../etc/passwd'), null, '../ 탈출');
    assert.equal(files.resolveInside(decodeURIComponent('..%2f..%2fetc/passwd')), null, 'URL 인코딩을 푼 탈출');
    const literal = files.resolveInside('..%2f..%2fetc/passwd');
    assert.ok(literal && literal.startsWith(DATA_DIR), '인코딩된 글자는 DATA_DIR 안 파일 이름으로만 취급');
    assert.equal(files.resolveInside('files/../../../etc/shadow'), null, '중첩 탈출');
    assert.equal(files.resolveInside('/etc/passwd'), null, '절대 경로');
    assert.equal(files.resolveInside(''), null, '빈 값');
    ok('파일 경로 탈출(`..`·절대경로·빈 값) 차단');
  } catch (err) {
    fail('경로 탈출 차단', err);
  }

  try {
    const disposition = files.contentDisposition('보고서 "\r\nX-Injected: 1".md', false);
    assert.ok(disposition.startsWith('attachment;'), 'attachment');
    assert.ok(!/[\r\n]/.test(disposition), '헤더에 줄바꿈 없음');
    assert.match(disposition, /filename\*=UTF-8''/, 'UTF-8 파일명');
    const inline = files.contentDisposition('사진.png', true);
    assert.ok(inline.startsWith('inline;'), '사진은 inline');
    ok('Content-Disposition 안전 처리(줄바꿈·따옴표 제거 + UTF-8 파일명)');
  } catch (err) {
    fail('Content-Disposition', err);
  }

  let savedId = '';
  try {
    const saved = files.saveFile({ name: '테스트 결과.md', data: Buffer.from('# 안녕\n파일함 테스트') });
    savedId = saved.id;
    assert.equal(saved.source, 'agent');
    assert.equal(saved.kind, 'text');
    assert.equal(saved.exists, true, '저장 직후 존재');
    assert.ok(fs.existsSync(files.resolveFile(saved.id)!.absPath), '디스크에 저장됨');
    const listed = files.listFiles();
    assert.ok(listed.some((item) => item.id === saved.id), '목록에 포함');
    const resolved = files.resolveFile(saved.id);
    assert.ok(resolved && resolved.absPath.startsWith(DATA_DIR), '해석된 경로가 DATA_DIR 안쪽');
    ok('AI 결과물 저장 → 목록 → 경로 해석');
  } catch (err) {
    fail('파일 저장·목록', err);
  }

  try {
    assert.equal(files.resolveFile('f:../../etc/passwd'), null, '없는 id');
    assert.equal(files.resolveFile('a:../../etc/passwd'), null, '첨부 탈출');
    assert.equal(files.resolveFile('nonsense'), null, '접두사 없음');
    ok('파일 id 변조·탈출 시 null');
  } catch (err) {
    fail('파일 id 변조', err);
  }

  try {
    const attachments = await import('../server/attachments');
    const view = attachments.saveUpload({
      sessionId: 'default',
      filename: '사진.png',
      mime: 'image/png',
      data: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    const listed = files.listFiles({ source: 'chat' });
    const found = listed.find((item) => item.id === `a:${view.id}`);
    assert.ok(found, '채팅 첨부가 파일함 목록에 포함');
    assert.equal(found?.kind, 'image');
    assert.equal(found?.source, 'chat');
    const resolved = files.resolveFile(`a:${view.id}`);
    assert.ok(resolved && resolved.absPath.startsWith(DATA_DIR));
    const deleted = files.deleteFile(`a:${view.id}`);
    assert.equal(deleted.ok, true);
    assert.ok(!fs.existsSync(resolved!.absPath), '삭제 시 파일도 지워짐');
    ok('채팅 첨부가 파일함에 보이고(사진·채팅 배지) 삭제 시 파일도 정리');
  } catch (err) {
    fail('채팅 첨부 목록', err);
  }

  try {
    const deleted = files.deleteFile(savedId);
    assert.equal(deleted.ok, true);
    assert.equal(files.resolveFile(savedId), null);
    ok('저장 파일 삭제');
  } catch (err) {
    fail('저장 파일 삭제', err);
  }
}

/* ------------------------------------------------------------------ */
/* 실제 express 서버 스모크                                             */
/* ------------------------------------------------------------------ */

async function waitForHealth(base: string, timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* 아직 안 떴다 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('서버가 시간 안에 뜨지 않았습니다');
}

async function httpTests(): Promise<void> {
  const port = 3400 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'server-dist/index.js')], {
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATA_DIR: HTTP_DIR, TZ: 'Asia/Seoul' },
      stdio: 'pipe',
    });
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', () => undefined);
    await waitForHealth(base);

    const version = (await (await fetch(`${base}/api/version`)).json()) as { version: string };
    assert.equal(version.version, '0.5.5', '배포 버전 0.5.5');

    // 초기 설정: 토큰 → 계정 → 완료(세션 쿠키 발급)
    const token = fs.readFileSync(path.join(HTTP_DIR, 'setup-token.txt'), 'utf8').trim();
    const verify = await fetch(`${base}/api/setup/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const setupCookie = (verify.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(verify.ok, '설정 토큰 확인');

    const account = await fetch(`${base}/api/setup/account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: setupCookie },
      body: JSON.stringify({ username: 'smoke', password: 'smoke-test-pass' }),
    });
    assert.ok(account.ok, '관리자 계정 생성');

    const complete = await fetch(`${base}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: setupCookie },
      body: JSON.stringify({}),
    });
    assert.ok(complete.ok, '설정 완료');
    const setCookies = complete.headers.getSetCookie?.() || [complete.headers.get('set-cookie') || ''];
    const cookie = (setCookies.find((value) => value.startsWith('pa_session=')) || '').split(';')[0];
    assert.match(cookie, /pa_session=/, '로그인 세션 쿠키');

    const auth = { Cookie: cookie };

    // 채팅 첨부 업로드 → 파일함 목록 → 내려받기 → 삭제
    const upload = await fetch(`${base}/api/chat/upload?name=${encodeURIComponent('스모크 파일.txt')}&session=default`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: '파일함 스모크 내용',
    });
    const uploaded = (await upload.json()) as { attachment?: { id: string } };
    assert.ok(upload.ok && uploaded.attachment?.id, '채팅 첨부 업로드');

    // 브라우저가 저장한 화면(data/files)도 목록에 잡히는지
    const shotDir = path.join(HTTP_DIR, 'files', 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, 'smoke-shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

    const listRes = await fetch(`${base}/api/files`, { headers: auth });
    const list = (await listRes.json()) as {
      files: { id: string; name: string; source: string; downloadUrl: string }[];
      totals: { count: number };
    };
    assert.ok(listRes.ok, '목록 200');
    assert.ok(list.files.some((f) => f.name === '스모크 파일.txt' && f.source === 'chat'), '채팅 첨부가 목록에 있음');
    assert.ok(list.files.some((f) => f.name === 'smoke-shot.png' && f.source === 'browser'), '브라우저 저장 파일 스캔');
    assert.equal(list.totals.count, list.files.length);

    const attachmentItem = list.files.find((f) => f.name === '스모크 파일.txt');
    const download = await fetch(`${base}${attachmentItem!.downloadUrl}`, { headers: auth });
    assert.equal(download.status, 200, '내려받기 200');
    const disposition = download.headers.get('content-disposition') || '';
    assert.match(disposition, /attachment;/, '내려받기는 attachment');
    assert.match(disposition, /filename\*=UTF-8''/, 'UTF-8 파일명 헤더');
    assert.equal(await download.text(), '파일함 스모크 내용');

    const image = list.files.find((f) => f.name === 'smoke-shot.png');
    const inline = await fetch(`${base}/api/files/${encodeURIComponent(image!.id)}/download`, { headers: auth });
    assert.equal(inline.status, 200);
    assert.match(inline.headers.get('content-disposition') || '', /^inline;/, '사진은 inline');

    const escape = await fetch(`${base}/api/files/${encodeURIComponent('f:../../etc/passwd')}/download`, { headers: auth });
    assert.equal(escape.status, 404, '경로 탈출 요청은 404');

    const missing = await fetch(`${base}/api/files/f:nope/download`, { headers: auth });
    assert.equal(missing.status, 404, '없는 파일 404');

    const remove = await fetch(`${base}/api/files/${encodeURIComponent(attachmentItem!.id)}`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.ok(remove.ok, '삭제 200');
    const after = (await (await fetch(`${base}/api/files`, { headers: auth })).json()) as { files: { id: string }[] };
    assert.ok(!after.files.some((f) => f.id === attachmentItem!.id), '삭제 후 목록에서 사라짐');

    const unauthorized = await fetch(`${base}/api/files`);
    assert.equal(unauthorized.status, 401, '로그인 없이는 401');

    ok('실서버: /api/files 목록·내려받기(inline/attachment)·삭제·경로탈출 404·비로그인 401, 브라우저 저장 파일 스캔');
    ok('실서버 /api/version = 0.5.5');
  } catch (err) {
    fail('실서버 /api/files', err);
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

async function main(): Promise<void> {
  await logicTests();
  await httpTests();
  console.log(results.join('\n'));
  if (process.exitCode) console.log('\n일부 검증이 실패했습니다.');
  else console.log('\n모든 v0.5.5 스모크 통과');
}

void main();
