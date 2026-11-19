import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, HOST_ROOT } from './config';
import { addLog, db } from './db';
import { currentStats } from './system';
import { postAutomationMessage } from './automation-chat';
import { publish } from './events';
import { queueSnapshot, stuckWork } from './queue';
import { BROWSER_CONTROL_URL, BROWSER_ENABLED } from './browser';

/**
 * 서버 보안·장애 감시 (v0.6.0)
 *
 * 3분마다 호스트 상태를 점검하고, **이상이 있을 때만** Pomong Agent 채팅방에
 * 선톡 + 웹 푸시로 알린다. 정상이면 아무 말도 하지 않는다.
 *
 * 점검 항목
 *   - 디스크 85% 이상 / 92% 이상(위험)
 *   - RAM 90% 이상이 3회 연속 지속(약 9분) / 96% 이상
 *   - CPU 부하(load1)가 코어 수의 2배를 3회 연속 초과
 *   - SSH 인증 실패 급증(fail2ban 감지 로그·auth.log)
 *   - fail2ban 차단 급증
 *   - 컨테이너 재시작·비정상(도커 소켓이 있으면 상세, 없으면 상태 엔드포인트)
 *   - 작업 큐 정체
 *
 * 알림은 같은 원인에 대해 쿨다운(기본 30분, 위험 10분)을 두어 반복되지 않는다.
 * 호스트 파일은 docker-compose 에서 읽기 전용으로 마운트한다:
 *   /var/log            → /host/var/log:ro
 *   /var/lib/fail2ban   → /host/var/lib/fail2ban:ro
 *   /var/run/docker.sock → /var/run/docker.sock:ro (선택)
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface Finding {
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  /** 이 값이 바뀌면 같은 kind라도 새 사건으로 본다(예: 컨테이너 이름) */
  subject?: string;
  advice?: string;
}

export interface MonitorReport {
  at: string;
  ok: boolean;
  checks: {
    disk: { pct: number };
    ram: { pct: number; streak: number };
    cpu: { load1: number; cores: number; streak: number };
    ssh: { failures: number; windowMin: number; source: string };
    fail2ban: { bans: number; currentlyBanned: number; source: string };
    containers: { name: string; running: boolean; health: string | null; restarts: number }[];
    queue: { running: number; queued: number; browserBusy: string | null };
  };
  findings: Finding[];
  /** 이번에 실제로 알림을 보낸 항목 */
  notified: string[];
}

const CHECK_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 3 * 60_000);
const HOST_LOG = process.env.HOST_LOG_DIR || path.join(HOST_ROOT === '/' ? '' : HOST_ROOT, 'var/log');
const FAIL2BAN_DB = process.env.FAIL2BAN_DB || path.join(HOST_ROOT === '/' ? '' : HOST_ROOT, 'var/lib/fail2ban/fail2ban.sqlite3');
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DISK_WARN = Number(process.env.MONITOR_DISK_WARN || 85);
const DISK_CRIT = Number(process.env.MONITOR_DISK_CRIT || 92);
const RAM_WARN = Number(process.env.MONITOR_RAM_WARN || 90);
const RAM_CRIT = Number(process.env.MONITOR_RAM_CRIT || 96);
const STREAK = 3;

let ramStreak = 0;
let cpuStreak = 0;
let lastReport: MonitorReport | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;

/* ------------------------------------------------------------------ */
/* 상태 저장(쿨다운·이전 값)                                            */
/* ------------------------------------------------------------------ */

function getState(key: string): string | null {
  const row = db.prepare('SELECT value FROM monitor_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setState(key: string, value: string): void {
  db.prepare('INSERT INTO monitor_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function lastNotified(kind: string): { at: number; count: number } | null {
  const row = db
    .prepare('SELECT notified_at, notify_count FROM monitor_alerts WHERE kind = ? ORDER BY last_seen DESC LIMIT 1')
    .get(kind) as { notified_at: string | null; notify_count: number } | undefined;
  if (!row?.notified_at) return null;
  return { at: new Date(row.notified_at).getTime(), count: row.notify_count };
}

function recordAlert(finding: Finding, notified: boolean): void {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id, notify_count FROM monitor_alerts WHERE kind = ? AND resolved_at IS NULL ORDER BY last_seen DESC LIMIT 1')
    .get(finding.kind) as { id: string; notify_count: number } | undefined;
  if (existing) {
    db.prepare('UPDATE monitor_alerts SET severity=?, title=?, detail=?, last_seen=?, notified_at=?, notify_count=? WHERE id=?').run(
      finding.severity,
      finding.title,
      finding.detail.slice(0, 1000),
      now,
      notified ? now : null,
      notified ? existing.notify_count + 1 : existing.notify_count,
      existing.id
    );
    return;
  }
  db.prepare(
    'INSERT INTO monitor_alerts(id, kind, severity, title, detail, first_seen, last_seen, notified_at, notify_count) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(
    crypto.randomUUID(),
    finding.kind,
    finding.severity,
    finding.title,
    finding.detail.slice(0, 1000),
    now,
    now,
    notified ? now : null,
    notified ? 1 : 0
  );
}

function cooldownMs(severity: Severity): number {
  if (severity === 'critical') return 10 * 60_000;
  if (severity === 'info') return 60 * 60_000;
  return 30 * 60_000;
}

/* ------------------------------------------------------------------ */
/* 점검 항목                                                           */
/* ------------------------------------------------------------------ */

function tailLines(file: string, maxBytes = 512 * 1024): string[] {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n');
  } catch {
    return [];
  }
}

function fileFresh(file: string, maxAgeMs: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

/** SSH 인증 실패 수 — fail2ban 로그(감지)와 auth.log(있으면)를 합쳐 센다. */
function sshFailures(windowMin = 15): { count: number; source: string } {
  const since = Date.now() - windowMin * 60_000;
  let count = 0;
  const sources: string[] = [];

  const f2b = path.join(HOST_LOG, 'fail2ban.log');
  if (fs.existsSync(f2b)) {
    for (const line of tailLines(f2b)) {
      // 예: 2026-11-19 09:41:02,123 fail2ban.filter [6701]: INFO [sshd] Found 1.2.3.4 - 2026-11-19 09:41:02
      const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
      if (!match) continue;
      if (!/\b(?:Found|Ban)\b/.test(line)) continue;
      const at = new Date(match[1].replace(' ', 'T')).getTime();
      if (Number.isNaN(at) || at < since) continue;
      count += 1;
    }
    sources.push('fail2ban.log');
  }

  const auth = path.join(HOST_LOG, 'auth.log');
  if (fs.existsSync(auth)) {
    for (const line of tailLines(auth)) {
      if (!/(Failed password|Invalid user|authentication failure|Connection closed by authenticating user)/i.test(line)) continue;
      const stamp = /^([A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2})/.exec(line);
      if (stamp) {
        const parsed = new Date(`${new Date().getFullYear()} ${stamp[1]}`);
        if (!Number.isNaN(parsed.getTime()) && parsed.getTime() < since) continue;
      }
      count += 1;
    }
    sources.push('auth.log');
  }

  // btmp(실패 로그인 기록) — 파일이 비어 있지 않으면 마지막 1시간 기록을 센다.
  const btmp = path.join(HOST_LOG, 'btmp');
  try {
    const size = fs.statSync(btmp).size;
    if (size > 0) {
      const fd = fs.openSync(btmp, 'r');
      const record = Buffer.alloc(384);
      let read = 0;
      const cutoff = Math.floor((Date.now() - windowMin * 60_000) / 1000);
      while (fs.readSync(fd, record, 0, 384, read * 384) === 384) {
        const seconds = record.readInt32LE(340);
        if (seconds >= cutoff) count += 1;
        read += 1;
      }
      fs.closeSync(fd);
      sources.push('btmp');
    }
  } catch {
    /* btmp 없음 */
  }

  return { count, source: sources.join('+') || 'none' };
}

/** fail2ban 차단 수(최근 1시간)와 현재 차단 IP 수 */
function fail2banStats(): { bans: number; currentlyBanned: number; source: string } {
  const since = Date.now() - 60 * 60_000;
  let bans = 0;
  let unban = 0;
  const log = path.join(HOST_LOG, 'fail2ban.log');
  let source = 'none';
  if (fs.existsSync(log)) {
    source = 'fail2ban.log';
    for (const line of tailLines(log)) {
      const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
      if (!/\bBan\b/.test(line)) continue;
      const at = match ? new Date(match[1].replace(' ', 'T')).getTime() : 0;
      if (at && at < since) continue;
      if (/\bUnban\b/.test(line)) unban += 1;
      else bans += 1;
    }
  }
  // sqlite(있으면)에서 현재 차단 수를 더 정확히 읽는다(파일을 복사해 읽기 전용으로 연다).
  let currentlyBanned = Math.max(0, bans - unban);
  if (fs.existsSync(FAIL2BAN_DB)) {
    try {
      const tmp = path.join(DATA_DIR, 'tmp');
      fs.mkdirSync(tmp, { recursive: true });
      const copy = path.join(tmp, 'fail2ban.sqlite3');
      fs.copyFileSync(FAIL2BAN_DB, copy);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const DatabaseCtor = require('better-sqlite3') as typeof import('better-sqlite3');
      const reader = new DatabaseCtor(copy, { readonly: true, fileMustExist: true });
      const row = reader.prepare('SELECT COUNT(*) AS n FROM bans WHERE bantime > ?').get(Math.floor(Date.now() / 1000)) as
        | { n: number }
        | undefined;
      if (row) currentlyBanned = Math.max(currentlyBanned, row.n);
      reader.close();
      source = 'fail2ban.log+db';
    } catch {
      /* DB를 읽지 못하면 로그 값만 쓴다 */
    }
  }
  return { bans, currentlyBanned, source };
}

interface ContainerState {
  name: string;
  running: boolean;
  health: string | null;
  restarts: number;
}

function dockerGet<T>(apiPath: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path: apiPath, method: 'GET', timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function containerStates(): Promise<ContainerState[]> {
  if (fs.existsSync(DOCKER_SOCKET)) {
    try {
      const list = await dockerGet<{ Id: string; Names: string[]; State: string }[]>('/containers/json?all=1');
      const out: ContainerState[] = [];
      for (const item of list.slice(0, 12)) {
        const name = (item.Names?.[0] || '').replace(/^\//, '');
        if (!/^pomong/.test(name)) continue;
        const detail = await dockerGet<{ RestartCount?: number; State?: { Status?: string; Health?: { Status?: string } } }>(
          `/containers/${item.Id}/json`
        ).catch(() => null);
        out.push({
          name,
          running: (detail?.State?.Status || item.State) === 'running',
          health: detail?.State?.Health?.Status || null,
          restarts: detail?.RestartCount || 0,
        });
      }
      if (out.length) return out;
    } catch {
      /* 소켓이 있어도 권한이 없으면 상태 엔드포인트로 넘어간다 */
    }
  }
  // 폴백: 브라우저 워커의 상태 엔드포인트만 확인한다.
  const out: ContainerState[] = [];
  if (BROWSER_ENABLED) {
    let running = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${BROWSER_CONTROL_URL}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      const data = (await res.json()) as { ok?: boolean; running?: boolean };
      running = Boolean(data?.ok) && Boolean(data?.running);
    } catch {
      running = false;
    }
    out.push({ name: 'pomong-browser', running, health: running ? 'healthy' : null, restarts: 0 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 점검 실행                                                           */
/* ------------------------------------------------------------------ */

export async function runMonitorCheck(): Promise<MonitorReport> {
  const stats = currentStats();
  const findings: Finding[] = [];

  // 디스크
  if (stats.disk >= DISK_WARN) {
    findings.push({
      kind: 'disk',
      severity: stats.disk >= DISK_CRIT ? 'critical' : 'warning',
      title: `디스크 사용량 ${stats.disk.toFixed(0)}%`,
      detail: `디스크 ${stats.diskUsedGB}/${stats.diskTotalGB}GB 사용 중입니다(기준 ${DISK_WARN}%). 로그·도커 이미지·백업 파일을 정리해야 합니다.`,
      advice: 'docker system prune -f 와 /var/log 정리를 권합니다.',
    });
  }

  // RAM 지속 고부하
  if (stats.ram >= RAM_WARN) ramStreak += 1;
  else ramStreak = 0;
  if (stats.ram >= RAM_CRIT || ramStreak >= STREAK) {
    findings.push({
      kind: 'ram',
      severity: stats.ram >= RAM_CRIT ? 'critical' : 'warning',
      title: `메모리 사용량 ${stats.ram.toFixed(0)}%`,
      detail: `RAM ${stats.ramUsedGB}/${stats.ramTotalGB}GB · ${ramStreak}회 연속 ${RAM_WARN}% 이상입니다. 브라우저(크로미움)나 컨테이너가 메모리를 오래 잡고 있는지 확인이 필요합니다.`,
    });
  }

  // CPU 부하 지속
  if (stats.load1 > stats.cores * 2) cpuStreak += 1;
  else cpuStreak = 0;
  if (cpuStreak >= STREAK) {
    findings.push({
      kind: 'cpu',
      severity: stats.load1 > stats.cores * 4 ? 'critical' : 'warning',
      title: `CPU 부하 ${stats.load1.toFixed(1)} (코어 ${stats.cores}개)`,
      detail: `load1이 코어 수의 2배를 ${cpuStreak}회 연속 넘었습니다. 어떤 프로세스가 도는지 확인해 주세요.`,
    });
  }

  // SSH 실패·fail2ban
  const ssh = sshFailures(15);
  if (ssh.count >= 50) {
    findings.push({
      kind: 'ssh',
      severity: ssh.count >= 300 ? 'critical' : 'warning',
      title: `SSH 인증 실패 급증 · 15분간 ${ssh.count}건`,
      detail: `출처: ${ssh.source}. 봇 스캔일 가능성이 큽니다. fail2ban이 켜져 있는지, root 비밀번호 로그인이 막혀 있는지 확인해 주세요.`,
    });
  }
  const f2b = fail2banStats();
  if (f2b.bans >= 30) {
    findings.push({
      kind: 'fail2ban',
      severity: f2b.bans >= 100 ? 'critical' : 'warning',
      title: `fail2ban 차단 급증 · 1시간 ${f2b.bans}건`,
      detail: `현재 차단 중인 IP ${f2b.currentlyBanned}개 (출처: ${f2b.source}).`,
    });
  }

  // 컨테이너
  const containers = await containerStates();
  const previous = getState('containers');
  let prevMap: Record<string, { restarts: number }> = {};
  try {
    prevMap = previous ? (JSON.parse(previous) as Record<string, { restarts: number }>) : {};
  } catch {
    prevMap = {};
  }
  for (const container of containers) {
    if (!container.running) {
      findings.push({
        kind: `container_down:${container.name}`,
        severity: 'critical',
        title: `${container.name} 컨테이너가 멈춰 있어요`,
        detail: 'restart: unless-stopped 설정인데도 실행 중이 아니어서, 반복 재시작 실패나 자원 부족일 수 있습니다.',
        subject: container.name,
      });
      continue;
    }
    if (container.health && !['healthy', 'starting'].includes(container.health)) {
      findings.push({
        kind: `container_sick:${container.name}`,
        severity: 'warning',
        title: `${container.name} 상태 이상 (${container.health})`,
        detail: '헬스체크가 unhealthy 입니다. 컨테이너 로그를 확인해 주세요.',
        subject: container.name,
      });
    }
    const before = prevMap[container.name]?.restarts;
    if (container.restarts > 0 && before !== undefined && container.restarts > before) {
      findings.push({
        kind: `container_restart:${container.name}`,
        severity: 'warning',
        title: `${container.name} 컨테이너가 다시 시작됐어요`,
        detail: `재시작 횟수 ${before} → ${container.restarts}. 메모리 한도 초과나 내부 오류가 원인일 수 있습니다.`,
        subject: container.name,
      });
    }
  }
  setState(
    'containers',
    JSON.stringify(Object.fromEntries(containers.map((c) => [c.name, { restarts: c.restarts }])))
  );

  // 작업 큐 정체
  const stuck = stuckWork(300);
  if (stuck.length) {
    findings.push({
      kind: 'queue',
      severity: 'warning',
      title: '작업 큐가 막혀 있어요',
      detail: stuck.map((s) => `${s.label}(${s.seconds}초 대기)`).join(', '),
    });
  }

  // 앱 재시작 감지(배포·장애 모두 해당 — 정보성)
  const bootAt = getState('bootAt');
  const thisBoot = String((globalThis as unknown as { __pomongBootAt?: string }).__pomongBootAt || '');
  if (bootAt && thisBoot && bootAt !== thisBoot) {
    findings.push({
      kind: 'app_restart',
      severity: 'info',
      title: 'Pomong Agent가 다시 시작됐어요',
      detail: `이전 기동: ${bootAt} → 이번 기동: ${thisBoot}`,
    });
  }
  if (thisBoot) setState('bootAt', thisBoot);

  // 알림
  const notified: string[] = [];
  for (const finding of findings) {
    const last = lastNotified(finding.kind);
    const silence = cooldownMs(finding.severity);
    const shouldNotify = !last || Date.now() - last.at >= silence;
    recordAlert(finding, shouldNotify);
    if (!shouldNotify) continue;
    notified.push(finding.kind);
    const emoji = finding.severity === 'critical' ? '🚨' : finding.severity === 'warning' ? '⚠️' : 'ℹ️';
    postAutomationMessage({
      kind: 'monitor',
      badge: `${emoji} ${finding.title}`,
      body: [finding.detail, finding.advice ? `→ ${finding.advice}` : ''].filter(Boolean).join('\n'),
      notifyTitle: `${finding.title}`,
      notifyBody: finding.detail.slice(0, 160),
    });
  }
  if (findings.length) {
    addLog(findings.some((f) => f.severity === 'critical') ? 'error' : 'warn', `서버 점검: ${findings.map((f) => f.title).join(' / ')}`);
  }

  const queue = queueSnapshot();
  lastReport = {
    at: new Date().toISOString(),
    ok: findings.filter((f) => f.severity !== 'info').length === 0,
    checks: {
      disk: { pct: stats.disk },
      ram: { pct: stats.ram, streak: ramStreak },
      cpu: { load1: stats.load1, cores: stats.cores, streak: cpuStreak },
      ssh: { failures: ssh.count, windowMin: 15, source: ssh.source },
      fail2ban: { bans: f2b.bans, currentlyBanned: f2b.currentlyBanned, source: f2b.source },
      containers,
      queue: { running: queue.totalRunning, queued: queue.totalQueued, browserBusy: queue.browserBusy?.label || null },
    },
    findings,
    notified,
  };
  return lastReport;
}

export function lastMonitorReport(): MonitorReport | null {
  return lastReport;
}

export function monitorAlertHistory(limit = 20): {
  kind: string;
  severity: string;
  title: string;
  detail: string | null;
  firstSeen: string;
  lastSeen: string;
  notifiedAt: string | null;
  count: number;
}[] {
  const rows = db
    .prepare('SELECT * FROM monitor_alerts ORDER BY last_seen DESC LIMIT ?')
    .all(limit) as {
    kind: string;
    severity: string;
    title: string;
    detail: string | null;
    first_seen: string;
    last_seen: string;
    notified_at: string | null;
    notify_count: number;
  }[];
  return rows.map((r) => ({
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    notifiedAt: r.notified_at,
    count: r.notify_count,
  }));
}

/** 감시 시작(부팅 시 1회) */
export function startMonitor(intervalMs = CHECK_INTERVAL_MS): void {
  if (timer) return;
  if (process.env.MONITOR_ENABLED === '0') {
    addLog('info', '서버 감시가 꺼져 있습니다(MONITOR_ENABLED=0)');
    return;
  }
  void runMonitorCheck().catch((err) => addLog('warn', `서버 점검 실패: ${err instanceof Error ? err.message : String(err)}`));
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runMonitorCheck()
      .catch((err) => addLog('warn', `서버 점검 실패: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  publish({ type: 'info', title: '서버 감시 시작', body: `${Math.round(intervalMs / 60_000)}분마다 점검합니다` }, { push: false });
}

export function stopMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
