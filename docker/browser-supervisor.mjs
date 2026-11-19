#!/usr/bin/env node
/**
 * 브라우저 워커 감독(supervisor) — v0.6.0 noVNC
 *
 * 한 컨테이너에서 네 가지를 함께 관리한다.
 *   1) Xvfb       : 가상 화면(기본 1280x800x24)
 *   2) Chromium   : 화면 있는(headed) 브라우저 + CDP(9222). 에이전트는 이 창을 그대로 조작한다.
 *   3) x11vnc     : X 화면을 VNC(5900, 로컬 전용)로 내보낸다.
 *   4) websockify : VNC를 WebSocket(6080)으로 감싼다. 앱 서버가 로그인 검증 후 중계한다.
 *
 * 9223 포트의 작은 HTTP API 로 상태 확인·재시작을 한다(도커 내부 전용).
 *   GET  /health   → 각 프로세스 상태 + 크로미움 CDP 준비 여부
 *   POST /start    → 모두 켜기(이미 켜져 있으면 그대로)
 *   POST /restart  → 크로미움만 재시작(화면·VNC는 유지)
 *   POST /stop     → 크로미움 종료(메모리 회수)
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const CONTROL_PORT = Number(process.env.CONTROL_PORT || 9223);
const CDP_PORT = Number(process.env.APP_PORT || 9222);
/** 다른 컨테이너(앱 서버)가 붙는 CDP 주소 — 크로미움은 127.0.0.1 에만 열리기 때문에 중계한다. */
const CDP_PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 9224);
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const WEB_PORT = Number(process.env.NOVNC_PORT || 6080);
const SCREEN = process.env.SCREEN || '1280x800';
const DISPLAY = process.env.DISPLAY || ':99';
const PROFILE_DIR = process.env.PROFILE_DIR || '/profile';
const NOVNC_WEB = process.env.NOVNC_WEB || '/usr/share/novnc';
const UA =
  process.env.BROWSER_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const procs = { xvfb: null, vnc: null, web: null, chrome: null };
let chromeStartedAt = 0;
let stopping = false;

function log(...args) {
  console.log('[supervisor]', ...args);
}

function chromiumBinary() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/root/.cache/ms-playwright';
  try {
    const dirs = fs
      .readdirSync(base)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const root = path.join(base, dir);
      // x86_64 는 chrome-linux, arm64 는 chrome-linux-arm64 로 들어온다.
      for (const sub of fs.readdirSync(root)) {
        if (!sub.startsWith('chrome-linux')) continue;
        const candidate = path.join(root, sub, 'chrome');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    /* 무시 */
  }
  return null;
}

function isRunning(name) {
  return Boolean(procs[name] && procs[name].exitCode === null && !procs[name].killed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Xvfb                                                                */
/* ------------------------------------------------------------------ */

async function startXvfb() {
  if (isRunning('xvfb')) return;
  const socket = `/tmp/.X11-unix/X${DISPLAY.replace(':', '')}`;
  if (fs.existsSync(socket)) {
    try {
      fs.unlinkSync(socket);
    } catch {
      /* 다른 인스턴스가 쓰고 있을 수 있다 */
    }
  }
  log('starting Xvfb', SCREEN);
  const proc = spawn('Xvfb', [DISPLAY, '-screen', '0', `${SCREEN}x24`, '-nolisten', 'tcp', '-ac', '+extension', 'RANDR'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (b) => process.stdout.write(String(b)));
  proc.stderr.on('data', (b) => process.stderr.write(String(b)));
  proc.on('exit', (code) => {
    log('Xvfb exited', code);
    procs.xvfb = null;
    if (!stopping) setTimeout(() => void startXvfb(), 1500);
  });
  procs.xvfb = proc;
  // X 소켓이 생길 때까지 잠깐 기다린다.
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(socket)) return;
    await sleep(150);
  }
}

/* ------------------------------------------------------------------ */
/* x11vnc + websockify                                                  */
/* ------------------------------------------------------------------ */

async function startVnc() {
  if (isRunning('vnc')) return;
  log('starting x11vnc on', VNC_PORT);
  const proc = spawn(
    'x11vnc',
    [
      '-display',
      DISPLAY,
      '-rfbport',
      String(VNC_PORT),
      '-localhost', // 컨테이너 밖으로 직접 노출하지 않는다(websockify만 붙는다)
      '-nopw',
      '-forever',
      '-shared',
      '-noxdamage',
      '-repeat',
      '-cursor',
      'arrow',
      '-wait',
      '20',
      '-defer',
      '10',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  proc.stdout.on('data', (b) => process.stdout.write(String(b)));
  proc.stderr.on('data', (b) => process.stderr.write(String(b)));
  proc.on('exit', (code) => {
    log('x11vnc exited', code);
    procs.vnc = null;
    if (!stopping) setTimeout(() => void startVnc(), 1500);
  });
  procs.vnc = proc;
}

async function startWeb() {
  if (isRunning('web')) return;
  log('starting noVNC websockify on', WEB_PORT);
  const proc = spawn(
    'websockify',
    ['--web', NOVNC_WEB, String(WEB_PORT), `localhost:${VNC_PORT}`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  proc.stdout.on('data', (b) => process.stdout.write(String(b)));
  proc.stderr.on('data', (b) => process.stderr.write(String(b)));
  proc.on('exit', (code) => {
    log('websockify exited', code);
    procs.web = null;
    if (!stopping) setTimeout(() => void startWeb(), 1500);
  });
  procs.web = proc;
}

/* ------------------------------------------------------------------ */
/* Chromium (headed, kiosk)                                             */
/* ------------------------------------------------------------------ */

async function cdpReady() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

async function startChrome(force = false) {
  if (!force && isRunning('chrome')) return;
  const bin = chromiumBinary();
  if (!bin) {
    log('chromium binary not found');
    return;
  }
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  } catch {
    /* 무시 */
  }
  // 컨테이너가 재생성될 때 프로필 볼륨에 남은 잠금 파일을 지운다.
  // (지난 컨테이너의 크로미움이 남긴 SingletonLock 이 있으면 'profile in use'로 뜨지 못한다)
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(PROFILE_DIR, name), { force: true });
    } catch {
      /* 무시 */
    }
  }
  // 같은 프로필로 두 번 뜨지 않도록 이전 크로미움을 정리한다.
  if (force && procs.chrome) {
    try {
      procs.chrome.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    procs.chrome = null;
    await sleep(600);
  }
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    // v0.6.0: 컨테이너 안에서만 통하는 주소로 연다(호스트에 publish 하지 않는다).
    // 기본값은 127.0.0.1 이라 다른 컨테이너(앱 서버)가 붙지 못한다.
    '--remote-debugging-address=0.0.0.0',
    '--remote-allow-origins=*',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--kiosk',
    `--window-size=${SCREEN.replace('x', ',')}`,
    '--window-position=0,0',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    '--password-store=basic',
    '--lang=ko-KR',
    `--user-agent=${UA}`,
    '--disable-blink-features=AutomationControlled',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
    'about:blank',
  ];
  log('starting chromium', bin);
  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DISPLAY },
  });
  proc.stdout.on('data', (b) => process.stdout.write(String(b)));
  proc.stderr.on('data', (b) => {
    const text = String(b);
    // dbus·GPU 관련 잡음은 줄인다
    if (/dbus|GetVSyncParametersIfAvailable|Failed to connect to the bus|libva/i.test(text)) return;
    process.stderr.write(text);
  });
  proc.on('exit', (code) => {
    log('chromium exited', code);
    procs.chrome = null;
    // 화면만 남기고 자동으로 다시 띄운다(사용자는 noVNC에서 빈 화면을 잠깐 본다).
    if (!stopping) setTimeout(() => void startChrome(), 5000);
  });
  procs.chrome = proc;
  chromeStartedAt = Date.now();
}

/* ------------------------------------------------------------------ */
/* CDP 중계(0.0.0.0:9224 → 127.0.0.1:9222)                                */
/* ------------------------------------------------------------------ */

/**
 * Chromium 의 DevTools 는 127.0.0.1 에만 열린다(스위치를 줘도 build에 따라 무시).
 * 앱 서버 컨테이너도 붙을 수 있도록 컨테이너 안에서 얇은 HTTP/WebSocket 중계를 둔다.
 * /json/version 의 webSocketDebuggerUrl(127.0.0.1:9222)을 요청한 호스트로 바꿔 준다.
 */
function startCdpProxy() {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: CDP_PORT,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${CDP_PORT}` },
      },
      (up) => {
        let body = '';
        up.setEncoding('utf8');
        up.on('data', (chunk) => {
          body += chunk;
        });
        up.on('end', () => {
          const host = req.headers.host || `localhost:${CDP_PROXY_PORT}`;
          const rewritten = body
            .split(`127.0.0.1:${CDP_PORT}`)
            .join(host)
            .split(`localhost:${CDP_PORT}`)
            .join(host);
          const headers = { ...up.headers };
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          headers['content-length'] = Buffer.byteLength(rewritten);
          res.writeHead(up.statusCode || 502, headers);
          res.end(rewritten);
        });
      }
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"cdp upstream unavailable"}');
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    const target = net.connect(CDP_PORT, '127.0.0.1', () => {
      const lines = [`GET ${req.url} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        // Chrome DevTools 는 Host 가 localhost/IP 가 아니면 500 으로 거절한다.
        if (key.toLowerCase() === 'host') {
          lines.push(`host: 127.0.0.1:${CDP_PORT}`);
          continue;
        }
        if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
        else if (value !== undefined) lines.push(`${key}: ${value}`);
      }
      target.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.on('close', () => target.destroy());
  });

  server.listen(CDP_PROXY_PORT, '0.0.0.0', () => log(`CDP proxy on :${CDP_PROXY_PORT} → 127.0.0.1:${CDP_PORT}`));
  server.on('error', (err) => log('CDP proxy error', err.message));
}

/* ------------------------------------------------------------------ */
/* HTTP 제어                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (url.startsWith('/health')) {
    const ready = await cdpReady();
    send(200, {
      ok: true,
      xvfb: isRunning('xvfb'),
      vnc: isRunning('vnc'),
      websockify: isRunning('web'),
      chromium: isRunning('chrome'),
      cdp: ready,
      screen: SCREEN,
      chromeSec: chromeStartedAt ? Math.round((Date.now() - chromeStartedAt) / 1000) : null,
    });
    return;
  }
  if (url.startsWith('/start')) {
    await startXvfb();
    await startVnc();
    await startWeb();
    await startChrome();
    for (let i = 0; i < 30; i += 1) {
      if (await cdpReady()) break;
      await sleep(300);
    }
    send(200, { ok: true, cdp: await cdpReady() });
    return;
  }
  if (url.startsWith('/restart')) {
    await startChrome(true);
    for (let i = 0; i < 30; i += 1) {
      if (await cdpReady()) break;
      await sleep(300);
    }
    send(200, { ok: true, cdp: await cdpReady() });
    return;
  }
  if (url.startsWith('/stop')) {
    if (procs.chrome) {
      try {
        procs.chrome.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      procs.chrome = null;
    }
    send(200, { ok: true, running: false });
    return;
  }
  if (url.startsWith('/touch')) {
    send(200, { ok: true });
    return;
  }
  send(404, { ok: false, message: 'not found' });
});

async function boot() {
  await startXvfb();
  await startVnc();
  await startWeb();
  await startChrome();
  for (let i = 0; i < 40; i += 1) {
    if (await cdpReady()) {
      log('CDP ready');
      return;
    }
    await sleep(300);
  }
  log('CDP not ready yet (will keep retrying in background)');
}

server.listen(CONTROL_PORT, '0.0.0.0', () => {
  log(`control on :${CONTROL_PORT}, CDP :${CDP_PORT}, VNC :${VNC_PORT}, noVNC :${WEB_PORT}, screen ${SCREEN}`);
  startCdpProxy();
  void boot();
  // 30초마다 죽은 프로세스를 다시 띄운다.
  setInterval(() => {
    if (stopping) return;
    if (!isRunning('xvfb')) void startXvfb();
    if (!isRunning('vnc')) void startVnc();
    if (!isRunning('web')) void startWeb();
    if (!isRunning('chrome')) void startChrome();
  }, 30_000).unref?.();
});

function shutdown() {
  stopping = true;
  log('shutting down');
  for (const name of ['chrome', 'web', 'vnc', 'xvfb']) {
    const proc = procs[name];
    if (!proc) continue;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 시작 전에 남아 있는 X 소켓을 정리(이전 컨테이너 잔재)
try {
  const sock = `/tmp/.X11-unix/X${DISPLAY.replace(':', '')}`;
  if (fs.existsSync(sock)) fs.unlinkSync(sock);
} catch {
  /* ignore */
}
void spawnSync; // lint 방지
