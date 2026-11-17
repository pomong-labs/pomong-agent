import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_PROC, HOST_ROOT } from './config';
import { addLog, recentLogs } from './db';

const CLK_TCK = 100; // Linux USER_HZ
const MAX_HISTORY = 120;

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  ramMB: number;
  status: string;
}

export interface SystemSnapshot {
  cpu: number;
  ram: number;
  disk: number;
  cores: number;
  cpuModel: string;
  cpuMhz: number;
  ramUsedGB: number;
  ramTotalGB: number;
  diskUsedGB: number;
  diskTotalGB: number;
  load1: number;
  load5: number;
  load15: number;
  uptimeSec: number;
  hostname: string;
  osName: string;
  status: 'healthy' | 'warning' | 'critical';
  processes: ProcessInfo[];
  logs: { id: number; level: string; message: string; at: string }[];
  sampledAt: string;
}

interface CpuSample {
  total: number;
  idle: number;
  at: number;
}

interface ProcSample {
  ticks: number;
  at: number;
  name: string;
  ramMB: number;
}

let lastCpu: CpuSample | null = null;
let lastProcs = new Map<number, ProcSample>();
let history: { t: number; cpu: number; ram: number; disk: number }[] = [];
let snapshot: SystemSnapshot | null = null;
let diskWarnedAt = 0;

function readProcStat(): CpuSample | null {
  try {
    const line = fs.readFileSync(path.join(HOST_PROC, 'stat'), 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] || 0) + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    return { total, idle, at: Date.now() };
  } catch {
    return null;
  }
}

function readMeminfo(): { total: number; available: number } {
  try {
    const txt = fs.readFileSync(path.join(HOST_PROC, 'meminfo'), 'utf8');
    const total = Number(/MemTotal:\s+(\d+)/.exec(txt)?.[1] || 0) * 1024;
    const available = Number(/MemAvailable:\s+(\d+)/.exec(txt)?.[1] || 0) * 1024;
    return { total, available };
  } catch {
    return { total: os.totalmem(), available: os.freemem() };
  }
}

function readCpuInfo(): { model: string; cores: number; mhz: number } {
  try {
    const txt = fs.readFileSync(path.join(HOST_PROC, 'cpuinfo'), 'utf8');
    const model = /model name\s*:\s*(.+)/.exec(txt)?.[1]?.trim() || 'CPU';
    const cores = (txt.match(/^processor\s*:/gm) || []).length || os.cpus().length || 1;
    const mhzRaw = /cpu MHz\s*:\s*([\d.]+)/.exec(txt)?.[1];
    const mhz = mhzRaw ? Number(mhzRaw) : (os.cpus()[0]?.speed || 0);
    return { model, cores, mhz };
  } catch {
    const cpus = os.cpus();
    return { model: cpus[0]?.model || 'CPU', cores: cpus.length || 1, mhz: cpus[0]?.speed || 0 };
  }
}

function readUptime(): number {
  try {
    const raw = fs.readFileSync(path.join(HOST_PROC, 'uptime'), 'utf8').trim().split(/\s+/)[0];
    return Number(raw) || os.uptime();
  } catch {
    return os.uptime();
  }
}

function readHostIdentity(): { hostname: string; osName: string } {
  let hostname = '';
  let osName = '';
  try {
    hostname = fs.readFileSync(path.join(HOST_ROOT, 'etc/hostname'), 'utf8').trim();
  } catch {
    hostname = os.hostname();
  }
  try {
    const rel = fs.readFileSync(path.join(HOST_ROOT, 'etc/os-release'), 'utf8');
    osName = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1] || '';
  } catch {
    osName = `${os.type()} ${os.release()}`;
  }
  return { hostname, osName };
}

function readDisk(): { used: number; total: number } {
  try {
    const st = fs.statfsSync(HOST_ROOT);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { used: total - free, total };
  } catch {
    return { used: 0, total: 0 };
  }
}

function readProcesses(now: number): ProcessInfo[] {
  const next = new Map<number, ProcSample>();
  const pageSize = 4096;
  let pids: string[] = [];
  try {
    pids = fs.readdirSync(path.join(HOST_PROC)).filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    try {
      const stat = fs.readFileSync(path.join(HOST_PROC, pidStr, 'stat'), 'utf8');
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const rest = stat.slice(close + 2).split(' ');
      const utime = Number(rest[11]) || 0;
      const stime = Number(rest[12]) || 0;
      const state = rest[0] || 'S';
      const rssPages = Number(rest[21]) || 0;
      next.set(pid, { ticks: utime + stime, at: now, name, ramMB: (rssPages * pageSize) / 1024 / 1024 });
      if (state === 'Z') next.delete(pid);
    } catch {
      /* process vanished */
    }
  }

  const list: ProcessInfo[] = [];
  for (const [pid, cur] of next) {
    const prev = lastProcs.get(pid);
    let cpu = 0;
    if (prev) {
      const dTicks = Math.max(0, cur.ticks - prev.ticks);
      const dSec = Math.max(0.001, (cur.at - prev.at) / 1000);
      cpu = (dTicks / CLK_TCK / dSec) * 100;
    }
    list.push({ pid, name: cur.name, cpu: Math.round(cpu * 10) / 10, ramMB: Math.round(cur.ramMB), status: 'running' });
  }
  lastProcs = next;
  return list.sort((a, b) => b.cpu - a.cpu || b.ramMB - a.ramMB);
}

export function sample(force = false): SystemSnapshot {
  const now = Date.now();
  const stat = readProcStat();
  let cpuPct = 0;
  if (stat && lastCpu && !force) {
    const dTotal = stat.total - lastCpu.total;
    const dIdle = stat.idle - lastCpu.idle;
    if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
  } else if (stat && lastCpu && force) {
    const dTotal = stat.total - lastCpu.total;
    const dIdle = stat.idle - lastCpu.idle;
    if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
  }
  lastCpu = stat ?? lastCpu;

  const mem = readMeminfo();
  const disk = readDisk();
  const cpuInfo = readCpuInfo();
  const load = os.loadavg();
  const procs = readProcesses(now);

  const ramPct = mem.total > 0 ? ((mem.total - mem.available) / mem.total) * 100 : 0;
  const diskPct = disk.total > 0 ? (disk.used / disk.total) * 100 : 0;

  const first = snapshot === null;

  // Keep a useful CPU reading even on the very first call (no previous sample).
  if (first && cpuPct === 0) {
    cpuPct = Math.min(100, (load[0] / Math.max(1, cpuInfo.cores)) * 100);
  }

  const status: SystemSnapshot['status'] =
    cpuPct > 95 || ramPct > 95 || diskPct > 95 ? 'critical' : cpuPct > 85 || ramPct > 85 || diskPct > 85 ? 'warning' : 'healthy';

  snapshot = {
    cpu: Math.round(cpuPct * 10) / 10,
    ram: Math.round(ramPct * 10) / 10,
    disk: Math.round(diskPct * 10) / 10,
    cores: cpuInfo.cores,
    cpuModel: cpuInfo.model.replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').trim() || cpuInfo.model,
    cpuMhz: Math.round(cpuInfo.mhz),
    ramUsedGB: Math.round(((mem.total - mem.available) / 1024 ** 3) * 10) / 10,
    ramTotalGB: Math.round((mem.total / 1024 ** 3) * 10) / 10,
    diskUsedGB: Math.round((disk.used / 1024 ** 3) * 10) / 10,
    diskTotalGB: Math.round((disk.total / 1024 ** 3) * 10) / 10,
    load1: Math.round(load[0] * 100) / 100,
    load5: Math.round(load[1] * 100) / 100,
    load15: Math.round(load[2] * 100) / 100,
    uptimeSec: Math.round(readUptime()),
    hostname: readHostIdentity().hostname,
    osName: readHostIdentity().osName,
    status,
    processes: procs.slice(0, 8),
    logs: recentLogs(8),
    sampledAt: new Date(now).toISOString(),
  };

  history.push({ t: now, cpu: snapshot.cpu, ram: snapshot.ram, disk: snapshot.disk });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

  if (diskPct > 85 && now - diskWarnedAt > 30 * 60 * 1000) {
    diskWarnedAt = now;
    addLog('warn', `디스크 사용량 ${diskPct.toFixed(0)}% — 정리 필요`);
  }

  return snapshot;
}

export function currentStats(): SystemSnapshot {
  return snapshot ?? sample();
}

export function getHistory(): { t: number; cpu: number; ram: number; disk: number }[] {
  return history.slice();
}

let timer: NodeJS.Timeout | null = null;

export function startSampler(intervalMs = 3000): void {
  if (timer) return;
  sample(true);
  timer = setInterval(() => {
    try {
      sample();
    } catch (err) {
      console.error('sampler error', err);
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
