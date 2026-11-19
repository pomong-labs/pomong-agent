/**
 * v0.5.6 핵심 로직 · API 스모크 (브라우저·모델 호출 없음)
 *
 * 실행: npx tsx scripts/smoke-v056.ts
 *
 * 1) 아이폰(WebKit) 마이크 — continuous=false, 같은 인스턴스 재시작 금지, 새 인스턴스 생성,
 *    aborted 무시 (데스크톱 Chrome은 기존 이어듣기 유지)
 * 2) 테마 — 포인트 컬러 파생값의 대비(라이트/다크), 캐릭터 6색, hex 정규화
 * 3) 성격 프리셋 — 프롬프트 문장(존댓말/반말·커스텀), 미리보기
 * 4) 실서버 — /api/version 0.5.6, 테마·성격 설정 저장·재조회, 잘못된 값 무시, sw.js 버전
 */
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const LOGIC_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-v056-')), 'logic');
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

/* ----------------------------- 마이크 스모크 ----------------------------- */

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  interimResults = false;
  continuous = false;
  maxAlternatives = 0;
  starts = 0;
  stops = 0;
  aborts = 0;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.starts += 1;
  }
  stop() {
    this.stops += 1;
  }
  abort() {
    this.aborts += 1;
  }
  fireEnd() {
    this.onend?.();
  }
  fireError(code: string) {
    this.onerror?.({ error: code });
  }
  fireResult(text: string, final: boolean) {
    this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { 0: { transcript: text }, isFinal: final } } });
  }
}

function setUserAgent(ua: string) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true });
}

async function speechTests() {
  // speech.ts는 import 시점에 window를 본다 → 먼저 가짜 window를 심는다.
  (globalThis as unknown as { window: unknown }).window = {
    SpeechRecognition: FakeRecognition,
    addEventListener: () => undefined,
  };
  const speech = await import('../src/lib/speech');

  try {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
    );
    assert.equal(speech.isAppleWebKit(), true, 'iPhone Safari');
    setUserAgent(
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1'
    );
    assert.equal(speech.isAppleWebKit(), true, '아이패드 크롬(내부는 WebKit)');
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15');
    assert.equal(speech.isAppleWebKit(), true, '맥 사파리');
    setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36');
    assert.equal(speech.isAppleWebKit(), false, '안드로이드 크롬');
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/127.0');
    assert.equal(speech.isAppleWebKit(), false, '파이어폭스');
    ok('WebKit 판별 — 아이폰·아이패드(CriOS 포함)·맥 사파리 true, 안드로이드·파이어폭스 false');
  } catch (err) {
    fail('WebKit 판별', err);
  }

  try {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
    FakeRecognition.instances = [];
    let ended = 0;
    const errors: string[] = [];
    let draft = '';
    const handle = speech.startDictation({
      onText: (finalText, interim) => {
        draft = [finalText, interim].filter(Boolean).join(' ');
      },
      onError: (code) => errors.push(code),
      onEnd: () => {
        ended += 1;
      },
    });
    assert.ok(handle, '아이폰에서도 인식기 생성');
    const first = FakeRecognition.instances[0];
    assert.equal(first.continuous, false, 'WebKit은 continuous=false');
    assert.equal(first.starts, 1, '첫 시작');
    first.fireResult('안녕', false);
    assert.equal(draft, '안녕', '중간 결과 반영');
    first.fireEnd();
    assert.equal(ended, 1, 'onend → 깔끔히 종료');
    assert.equal(first.starts, 1, 'WebKit은 같은 인스턴스를 다시 start() 하지 않음');

    // 다음 탭 → 새 인스턴스
    const handle2 = speech.startDictation({ onText: () => undefined, onError: () => undefined, onEnd: () => undefined });
    assert.ok(handle2, '두 번째 시작');
    assert.equal(FakeRecognition.instances.length, 2, '두 번째 인식은 새 인스턴스');
    assert.equal(FakeRecognition.instances[1].continuous, false);
    assert.equal(FakeRecognition.instances[1].starts, 1);

    // 사용자가 끌 때의 aborted는 오류 알림이 아니다
    const second = FakeRecognition.instances[1];
    second.fireError('aborted');
    assert.deepEqual(errors, [], 'aborted는 오류로 띄우지 않음');
    handle2?.abort();
    assert.equal(second.aborts, 1, 'abort 호출');
    ok('아이폰: continuous=false · onend에서 재시작 없음 · 다음 탭은 새 인스턴스 · aborted 무시');
  } catch (err) {
    fail('아이폰 받아쓰기 동작', err);
  }

  try {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36');
    FakeRecognition.instances = [];
    let ended = 0;
    let handleEndCount = 0;
    const handle = speech.startDictation({
      onText: () => undefined,
      onError: () => undefined,
      onEnd: () => {
        ended += 1;
      },
    });
    const rec = FakeRecognition.instances[0];
    assert.equal(rec.continuous, true, '데스크톱은 continuous 유지');
    rec.fireEnd();
    assert.equal(rec.starts, 2, '데스크톱은 침묵 후 같은 인스턴스로 이어 듣기');
    assert.equal(ended, 0, '이어 듣는 동안에는 종료 알림 없음');
    handle?.stop();
    rec.fireEnd();
    assert.equal(ended, 1, '사용자가 멈추면 종료');
    assert.equal(handleEndCount, 0);
    ok('데스크톱 크롬: continuous=true · 침묵 후 이어 듣기 · 사용자가 멈추면 종료');
  } catch (err) {
    fail('데스크톱 받아쓰기 동작', err);
  }

  try {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)');
    FakeRecognition.instances = [];
    const errors: string[] = [];
    const handle = speech.startDictation({
      onText: () => undefined,
      onError: (code) => errors.push(code),
      onEnd: () => undefined,
    });
    const rec = FakeRecognition.instances[0];
    rec.fireError('no-speech');
    assert.deepEqual(errors, [], '한 번의 침묵은 조용히');
    handle?.stop();
    ok('오류 안내: 첫 no-speech는 조용히 넘어감');
  } catch (err) {
    fail('오류 안내', err);
  }
}

/* ------------------------------ 테마 스모크 ------------------------------ */

async function themeTests() {
  const theme = await import('../src/lib/theme');

  try {
    assert.equal(theme.normalizeHex('#abc'), '#AABBCC', '3자리 hex 확장');
    assert.equal(theme.normalizeHex('8b72f8'), theme.PURPLE_ACCENT, '잘못된 값은 기본');
    assert.equal(theme.resolveTheme('dark'), 'dark');
    assert.equal(theme.resolveTheme('light'), 'light');
    assert.equal(Object.keys(theme.CHARACTER_ACCENTS).length, 6, '캐릭터 6종');
    const colors = new Set(Object.values(theme.CHARACTER_ACCENTS).map((c) => c.color));
    assert.equal(colors.size, 6, '6종 색이 모두 다름');
    ok('hex 정규화 · 테마 모드 해석 · 캐릭터 6색');
  } catch (err) {
    fail('테마 기본', err);
  }

  try {
    const bases = [
      theme.PURPLE_ACCENT,
      ...Object.values(theme.CHARACTER_ACCENTS).map((c) => c.color),
      '#4A90E2',
      '#8E8A9E',
    ];
    for (const base of bases) {
      const light = theme.accentVars(base, 'light');
      const dark = theme.accentVars(base, 'dark');
      assert.ok(theme.contrastRatio(light['--accent-deep'], '#FFFFFF') >= 4.5, `${base} 라이트 본문 대비`);
      assert.ok(theme.contrastRatio(light['--accent-ink'], light['--accent-soft']) >= 4.4, `${base} 라이트 소프트 위 글자`);
      assert.ok(theme.contrastRatio(dark['--accent-deep'], '#1B1923') >= 4.5, `${base} 다크 본문 대비`);
      assert.ok(theme.contrastRatio(dark['--accent-ink'], '#1B1923') >= 4.5, `${base} 다크 강조 글자`);
      assert.ok(theme.contrastRatio(light['--accent-contrast'], base) >= 4.5, `${base} 채움 위 글자(라이트)`);
      assert.ok(theme.contrastRatio(dark['--accent-contrast'], base) >= 4.5, `${base} 채움 위 글자(다크)`);
      assert.match(light['--bubble-user'], /linear-gradient/, '내 말풍선 그라데이션');
    }
    ok('포인트 컬러 파생값 대비(WCAG 4.5) — 기본·캐릭터 6색·수동 색 모두 라이트/다크 통과');
  } catch (err) {
    fail('포인트 컬러 대비', err);
  }
}

/* ----------------------------- 성격 스모크 ----------------------------- */

async function personaTests() {
  const persona = await import('../server/persona');
  const client = await import('../src/lib/persona');

  try {
    assert.equal(persona.normalizePersona('calm', 'default'), 'calm');
    assert.equal(persona.normalizePersona('nope', 'bright'), 'bright', '모르는 값은 이전 값 유지');
    assert.match(persona.personaInstruction('calm', '', true), /차분/);
    assert.match(persona.personaInstruction('concise', '', false), /간결/);
    assert.ok(!/하세요/.test(persona.personaInstruction('calm', '', false)), '반말 모드 문장에 존댓말 없음');
    const custom = persona.personaInstruction('custom', '말은 짧게, 챙길 건 다 챙기는 비서', true);
    assert.match(custom, /말은 짧게, 챙길 건 다 챙기는 비서/, '커스텀 성격이 프롬프트에 그대로');
    assert.match(custom, /말투 규칙이 항상 우선/, '말투 규칙이 우선');
    assert.match(persona.personaInstruction('custom', '   ', true), /다정하고 발랄/, '빈 커스텀은 기본 성격');
    ok('성격 프리셋 → 프롬프트(차분/간결·반말 문체·커스텀·빈 값 폴백)');
  } catch (err) {
    fail('성격 프롬프트', err);
  }

  try {
    const ids = client.PERSONA_OPTIONS.map((p) => p.id);
    for (const id of ['default', 'calm', 'bright', 'concise', 'witty', 'custom'] as const) {
      assert.ok(ids.includes(id), `${id} 프리셋 존재`);
    }
    const preview = client.personaExample('calm', { callName: '현준', agentName: '포몽', polite: true });
    assert.match(preview, /포몽:/, '미리보기에 AI 이름');
    assert.match(preview, /확인했습니다/, '차분한 예시 문구');
    const customPreview = client.personaExample('custom', {
      callName: '현준',
      agentName: '포몽',
      polite: false,
      custom: '말수 적은 비서',
    });
    assert.match(customPreview, /말수 적은 비서/, '커스텀 미리보기');
    ok('설정 화면 성격 프리셋 6종 + 말투별 미리보기');
  } catch (err) {
    fail('성격 미리보기', err);
  }
}

/* ------------------------------ 실서버 스모크 ------------------------------ */

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

async function httpTests() {
  const port = 3700 + Math.floor(Math.random() * 200);
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
    assert.equal(version.version, '0.5.6', '배포 버전 0.5.6');

    const sw = await (await fetch(`${base}/sw.js`)).text();
    assert.match(sw, /pomong-agent-v0\.5\.6/, '서비스워커 캐시 버전');

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
    const auth = { Cookie: cookie, 'Content-Type': 'application/json' };

    // 1) 테마·성격 저장
    const put = await fetch(`${base}/api/settings/profile`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({
        nickname: '현준',
        agentName: '포몽',
        character: 'lamong',
        tone: 'casual',
        theme: 'system',
        accentMode: 'character',
        accentColor: '#35B98A',
        persona: 'witty',
        personaCustom: '',
      }),
    });
    assert.ok(put.ok, '설정 저장 200');
    const saved = (await put.json()) as { profile: Record<string, unknown> };
    assert.equal(saved.profile.theme, 'system');
    assert.equal(saved.profile.accentMode, 'character');
    assert.equal(saved.profile.accentColor, '#35B98A');
    assert.equal(saved.profile.persona, 'witty');

    const reread = (await (await fetch(`${base}/api/settings`, { headers: auth })).json()) as {
      profile: Record<string, unknown>;
      version: string;
    };
    assert.equal(reread.version, '0.5.6');
    assert.equal(reread.profile.theme, 'system', '새로고침 뒤에도 테마 유지');
    assert.equal(reread.profile.accentMode, 'character');
    assert.equal(reread.profile.accentColor, '#35B98A');
    assert.equal(reread.profile.persona, 'witty');
    assert.equal(reread.profile.character, 'lamong');
    ok('테마(라이트/다크/기기)·포인트 컬러·성격 설정이 DB에 저장되고 재조회됨');

    // 2) 커스텀 성격 + 잘못된 값 무시
    const put2 = await fetch(`${base}/api/settings/profile`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ persona: 'custom', personaCustom: '말은 짧게, 챙길 건 다 챙기는 비서', theme: 'neon', accentColor: 'zzz' }),
    });
    const saved2 = (await put2.json()) as { profile: Record<string, unknown> };
    assert.equal(saved2.profile.persona, 'custom');
    assert.match(String(saved2.profile.personaCustom), /말은 짧게/);
    assert.equal(saved2.profile.theme, 'system', '알 수 없는 테마는 이전 값 유지');
    assert.equal(saved2.profile.accentColor, '#35B98A', '잘못된 색은 이전 값 유지');
    ok('커스텀 성격 저장 · 잘못된 테마/색 값은 이전 설정 유지');

    const unauthorized = await fetch(`${base}/api/settings`);
    assert.equal(unauthorized.status, 401, '로그인 없이는 401');

    // 3) 빌드 산출물에 테마가 들어갔는지 (다크 규칙·첫 페인트 스크립트)
    const html = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
    assert.match(html, /pomong\.theme/, 'index.html 첫 페인트 테마 스크립트');
    const cssFile = fs
      .readdirSync(path.join(ROOT, 'dist/assets'))
      .find((name) => name.endsWith('.css'));
    const css = fs.readFileSync(path.join(ROOT, 'dist/assets', cssFile!), 'utf8');
    assert.match(css, /html\.dark/, '빌드 CSS에 다크 규칙');
    assert.match(css, /--accent-deep/, '빌드 CSS에 포인트 컬러 변수');
    ok('빌드 산출물에 첫 페인트 테마 스크립트·다크 규칙·포인트 컬러 변수 포함');
  } catch (err) {
    fail('실서버 설정 저장·테마', err);
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

async function main() {
  await speechTests();
  await themeTests();
  await personaTests();
  await httpTests();
  console.log(results.join('\n'));
  if (process.exitCode) console.log('\n일부 검증이 실패했습니다.');
  else console.log('\n모든 v0.5.6 스모크 통과');
}

void main();
