#!/usr/bin/env node
/**
 * 브라우저 워커 감독(supervisor)
 *
 * Playwright run-server 를 자식 프로세스로 띄우고, 9223 포트의 작은 HTTP API 로
 * 시작/정지 상태를 제어한다. 에이전트는 다음 경우에 정지를 요청한다.
 *   - 연결이 끊긴 채 오래 둔 크로미움을 회수할 때(유휴 10분)
 *   - 연결이 응답하지 않을 때(좀비 클라이언트 정리 후 재시도)
 *
 * 외부에 포트를 노출하지 않는다(도커 내부 네트워크 전용).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const CONTROL_PORT = Number(process.env.CONTROL_PORT || 9223);
const APP_PORT = Number(process.env.APP_PORT || 9222);
const START_TIMEOUT_MS = 30_000;

let child = null;
let starting = null;
let lastActivity = Date.now();
let idleSince = 0;
const ORPHAN_GRACE_MS = Number(process.env.ORPHAN_GRACE_MS || 10 * 60_000);

function childrenOf(pid) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(parts[1]);
      if (ppid === pid) out.push(Number(name));
    } catch {
      /* process vanished */
    }
  }
  return out;
}

function killTree(pid, signal = 'SIGKILL') {
  if (!pid) return;
  for (const child of childrenOf(pid)) killTree(child, signal);
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function chromiumCount() {
  let count = 0;
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (cmd.includes('ms-playwright') && cmd.includes('chrom')) count += 1;
    } catch {
      /* ignore */
    }
  }
  return count;
}

/* 9222 포트에 실제로 붙어 있는 클라이언트 수(established) */
function clientConnections() {
  const hexPort = APP_PORT.toString(16).toUpperCase().padStart(4, '0');
  let count = 0;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[1] || '';
      const state = cols[3];
      if (state === '01' && local.endsWith(`:${hexPort}`)) count += 1;
    }
  }
  return count;
}

/* 클라이언트가 없는데 남아 있는 크로미움(비정상 종료 잔재)을 회수한다. */
function reapOrphans(force) {
  if (chromiumCount() === 0) return;
  if (clientConnections() > 0) {
    idleSince = 0;
    return;
  }
  if (!force) {
    if (idleSince === 0) idleSince = Date.now();
    if (Date.now() - idleSince < ORPHAN_GRACE_MS) return;
  }
  console.log('[supervisor] reaping orphan chromium processes');
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (cmd.includes('ms-playwright') && cmd.includes('chrom')) {
        try {
          process.kill(Number(name), 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  idleSince = 0;
}

function start() {
  if (child && child.exitCode === null) return Promise.resolve();
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['playwright', 'run-server', '--host', '0.0.0.0', '--port', String(APP_PORT)],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: false }
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.log('[supervisor] start timeout');
      killTree(proc.pid);
      child = null;
      reject(new Error('run-server did not start in time'));
    }, START_TIMEOUT_MS);
    proc.stdout.on('data', (buf) => {
      const text = String(buf);
      process.stdout.write(text);
      if (!settled && text.includes('Listening on')) {
        settled = true;
        clearTimeout(timer);
        child = proc;
        lastActivity = Date.now();
        resolve();
      }
    });
    proc.stderr.on('data', (buf) => process.stderr.write(String(buf)));
    proc.on('exit', (code) => {
      console.log(`[supervisor] run-server exited (${code})`);
      if (child === proc) child = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`run-server exited (${code})`));
      }
    });
  }).finally(() => {
    starting = null;
  });
  return starting;
}

function stop() {
  const pid = child?.pid;
  child = null;
  if (pid) killTree(pid);
  // 남아 있는 크로미움(이전 클라이언트의 잔여 프로세스)도 함께 정리한다.
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (cmd.includes('ms-playwright') && cmd.includes('chrom')) {
        try {
          process.kill(Number(name), 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.startsWith('/health')) {
    send(200, {
      ok: true,
      running: Boolean(child && child.exitCode === null),
      pid: child?.pid ?? null,
      chromium: chromiumCount(),
      idleSec: Math.round((Date.now() - lastActivity) / 1000),
    });
    return;
  }
  if (url.startsWith('/start')) {
    // 새로 붙기 전에 잔여 크로미움을 정리해 첫 연결이 느려지지 않게 한다.
    reapOrphans(true);
    start()
      .then(() => send(200, { ok: true, running: true }))
      .catch((err) => send(500, { ok: false, message: String(err.message || err) }));
    return;
  }
  if (url.startsWith('/stop')) {
    stop();
    send(200, { ok: true, running: false });
    return;
  }
  if (url.startsWith('/restart')) {
    stop();
    start()
      .then(() => send(200, { ok: true, running: true }))
      .catch((err) => send(500, { ok: false, message: String(err.message || err) }));
    return;
  }
  if (url.startsWith('/touch')) {
    lastActivity = Date.now();
    send(200, { ok: true });
    return;
  }
  send(404, { ok: false, message: 'not found' });
});

server.listen(CONTROL_PORT, '0.0.0.0', () => {
  console.log(`[supervisor] control on :${CONTROL_PORT}, playwright on :${APP_PORT}`);
  start().catch((err) => console.error('[supervisor] initial start failed:', err.message));
  setInterval(() => reapOrphans(false), 60_000).unref();
});

function shutdown() {
  console.log('[supervisor] shutting down');
  stop();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
