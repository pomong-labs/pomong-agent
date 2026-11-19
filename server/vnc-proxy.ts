import net from 'node:net';
import type { Socket } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request } from 'express';
import { readSession } from './auth';
import { BROWSER_VNC_UPSTREAM, BROWSER_ENABLED } from './browser';
import { addLog } from './db';

/**
 * noVNC WebSocket 프록시 (v0.6.0)
 *
 * 브라우저 컨테이너의 websockify(6080)는 도커 내부에만 있고, 앱 서버가
 * `/api/browser/vnc` 로 **로그인 쿠키를 검증한 뒤** 업그레이드를 중계한다.
 * → 포트를 호스트에 열지 않고, 로그인한 사용자만 화면을 볼 수 있다.
 *
 * 클라이언트(noVNC)는 그냥 `wss://도메인/api/browser/vnc` 로 붙으면 된다.
 * (nginx 는 이 경로만 upgrade 헤더를 넘겨 준다)
 */

export const VNC_PATH = '/api/browser/vnc';

function parseUpstream(raw: string): { host: string; port: number; path: string } {
  try {
    const url = new URL(raw);
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'wss:' ? 443 : 80)),
      path: `${url.pathname || '/'}${url.search || ''}`,
    };
  } catch {
    return { host: 'browser', port: 6080, path: '/websockify' };
  }
}

function reject(socket: Duplex, status: string): void {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  } catch {
    /* ignore */
  }
}

/** 원본 업그레이드 요청을 업스트림용으로 다시 만든다(경로·쿠키 교체). */
function buildUpgradeRequest(req: IncomingMessage, path: string): string {
  const headers: string[] = [`GET ${path} HTTP/1.1`];
  const host = req.headers.host || 'localhost';
  headers.push(`Host: ${host}`);
  headers.push('Upgrade: websocket');
  headers.push('Connection: Upgrade');
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (['host', 'upgrade', 'connection', 'cookie', 'sec-websocket-extensions', 'content-length'].includes(lower)) continue;
    if (Array.isArray(value)) for (const v of value) headers.push(`${key}: ${v}`);
    else headers.push(`${key}: ${value}`);
  }
  return `${headers.join('\r\n')}\r\n\r\n`;
}

/** http 서버에 noVNC 중계기를 붙인다. */
export function attachVncProxy(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, rawSocket: Duplex, head: Buffer) => {
    const socket = rawSocket as Socket;
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== VNC_PATH) {
      // 우리가 처리하는 경로가 아니면 연결을 그대로 닫는다(다른 업그레이드 핸들러 없음).
      reject(socket, '404 Not Found');
      return;
    }
    if (!BROWSER_ENABLED) {
      reject(socket, '503 Service Unavailable');
      return;
    }
    // 로그인 쿠키 또는 서버가 발급한 1회용 토큰으로 인증한다.
    const token = url.searchParams.get('token');
    const user = readSession(req as unknown as Request) || (token ? sessionFromToken(token) : null);
    if (!user) {
      reject(socket, '401 Unauthorized');
      return;
    }

    const upstream = parseUpstream(BROWSER_VNC_UPSTREAM);
    const target = net.connect(upstream.port, upstream.host);
    target.setNoDelay(true);
    socket.setNoDelay(true);

    const timer = setTimeout(() => {
      target.destroy();
      reject(socket, '504 Gateway Timeout');
    }, 15_000);

    target.once('connect', () => {
      clearTimeout(timer);
      target.write(buildUpgradeRequest(req, upstream.path));
      if (head && head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
      addLog('info', `noVNC 화면 연결 · ${user.username}`);
    });
    target.on('error', () => {
      clearTimeout(timer);
      reject(socket, '502 Bad Gateway');
    });
    const close = () => {
      target.destroy();
      socket.destroy();
    };
    socket.on('error', close);
    socket.on('close', () => target.destroy());
    target.on('close', () => socket.destroy());
  });
}

/* ------------------------------------------------------------------ */
/* 1회용 noVNC 토큰                                                    */
/* ------------------------------------------------------------------ */

const tokens = new Map<string, { user: string; expires: number }>();

/** 로그인한 사용자가 noVNC 접속용 토큰을 받아 간다(60초 유효). */
export function issueVncToken(username: string): { token: string; expiresInSec: number } {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const expires = Date.now() + 60_000;
  tokens.set(token, { user: username, expires });
  // 오래된 토큰 정리
  for (const [key, value] of tokens) if (value.expires < Date.now()) tokens.delete(key);
  return { token, expiresInSec: 60 };
}

function sessionFromToken(token: string): { username: string } | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return { username: entry.user };
}
