/**
 * v0.6.16 — 도커 컨테이너 관리 (조회·로그·시작/중지/재시작) + **포몽 보호장치**
 *
 * 같은 서버에서 도는 다른 컨테이너를 챙길 수 있게 하되, 포몽 에이전트 **자신**은
 * 어떤 경우에도 멈추거나 재시작시키지 못한다. 보호는 두 겹이다.
 *
 *   1겹(도구 계층)  : 대상 컨테이너를 확인해 보호 대상이면 요청 자체를 거부한다.
 *   2겹(전송 계층)  : 상태를 바꾸는 요청을 보내기 **직전에** 컨테이너를 다시 조회해
 *                     한 번 더 검사한다(1겹을 우회한 호출도 여기서 막힌다).
 *
 * 삭제·파괴 계열(rm·prune·kill·exec …)은 보호 대상과 무관하게 전부 차단한다.
 *
 * 보호 기준
 *   - 컨테이너 이름이 `pomong`으로 시작 (예: pomong-agent, pomong-browser)
 *   - 이 프로세스가 돌고 있는 컨테이너 자신(hostname 기준) 또는 같은 compose 프로젝트
 *   - compose 서비스 이름이 pomong-agent · browser
 *   - 환경변수 POMONG_GUARD_NAMES 로 추가 지정한 이름
 *
 * 소켓은 docker-compose.yml 에서 `/var/run/docker.sock:ro` → 읽기·쓰기로 마운트해야
 * 상태 변경이 동작한다(조회·로그는 읽기 전용으로도 된다).
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DEFAULT_GUARD_PREFIXES = ['pomong'];
const GUARD_PREFIXES = (process.env.POMONG_GUARD_PREFIXES || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean)
  .concat(DEFAULT_GUARD_PREFIXES);
const EXTRA_GUARD_NAMES = (process.env.POMONG_GUARD_NAMES || '')
  .split(',')
  .map((item) => item.trim().toLowerCase().replace(/^\//, ''))
  .filter(Boolean);
const GUARD_SERVICES = new Set(['pomong-agent', 'browser', 'pomong-browser']);

/** 상태를 바꾸는 동작 중 허용하는 것 */
export const ALLOWED_STATE_ACTIONS = new Set(['start', 'stop', 'restart', 'pause', 'unpause']);
/** 어떤 대상에게도 허용하지 않는 파괴·침투 동작 */
export const BLOCKED_ACTIONS = new Set([
  'kill',
  'rm',
  'remove',
  'delete',
  'prune',
  'exec',
  'down',
  'update',
  'commit',
  'cp',
  'attach',
]);

export type DockerAction = 'ps' | 'logs' | 'inspect' | 'start' | 'stop' | 'restart' | 'pause' | 'unpause';

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: Record<string, string>;
  ports?: { PrivatePort?: number; PublicPort?: number; Type?: string }[];
  created?: number;
}

export interface GuardVerdict {
  protected: boolean;
  reason: string;
}

export function dockerAvailable(): boolean {
  try {
    return fs.existsSync(DOCKER_SOCKET);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Docker Engine API (unix 소켓)                                       */
/* ------------------------------------------------------------------ */

interface RawDockerResponse {
  status: number;
  body: Buffer;
}

function dockerRequestRaw(
  apiPath: string,
  options: { method?: string; timeoutMs?: number } = {}
): Promise<RawDockerResponse> {
  return new Promise<RawDockerResponse>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: apiPath,
        method: options.method || 'GET',
        timeout: options.timeoutMs ?? 8_000,
        headers: { Host: 'docker' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('도커 응답 시간 초과')));
    req.on('error', reject);
    req.end();
  });
}

async function dockerJson<T>(apiPath: string): Promise<T> {
  const res = await dockerRequestRaw(apiPath);
  const text = res.body.toString('utf8');
  if (res.status >= 400) {
    let message = `도커 응답 ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed?.message) message = parsed.message;
    } catch {
      /* 본문이 JSON이 아니면 상태 코드만 */
    }
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/* ------------------------------------------------------------------ */
/* 자기 자신(포몽) 알아보기                                             */
/* ------------------------------------------------------------------ */

export interface SelfIdentity {
  hostname: string;
  id: string;
  name: string;
  project: string;
  service: string;
}

let selfCache: { at: number; value: SelfIdentity } | null = null;

export async function selfIdentity(): Promise<SelfIdentity> {
  if (selfCache && Date.now() - selfCache.at < 60_000) return selfCache.value;
  const hostname = os.hostname();
  const empty: SelfIdentity = { hostname, id: '', name: hostname, project: '', service: '' };
  try {
    const info = await dockerJson<{
      Id?: string;
      Name?: string;
      Config?: { Labels?: Record<string, string> };
    }>(`/containers/${encodeURIComponent(hostname)}/json`);
    const labels = info.Config?.Labels || {};
    const value: SelfIdentity = {
      hostname,
      id: String(info.Id || ''),
      name: String((info.Name || hostname).replace(/^\//, '')),
      project: String(labels['com.docker.compose.project'] || ''),
      service: String(labels['com.docker.compose.service'] || ''),
    };
    selfCache = { at: Date.now(), value };
    return value;
  } catch {
    // 호스트 이름으로 못 찾으면 이름·id 접두어로 목록에서 찾아본다.
    try {
      const list = await listContainers();
      const found = list.find(
        (item) => item.id.startsWith(hostname) || item.name === hostname || item.name.startsWith(`${hostname}-`)
      );
      if (found) {
        const value: SelfIdentity = {
          hostname,
          id: found.id,
          name: found.name,
          project: String(found.labels['com.docker.compose.project'] || ''),
          service: String(found.labels['com.docker.compose.service'] || ''),
        };
        selfCache = { at: Date.now(), value };
        return value;
      }
    } catch {
      /* 도커를 못 읽으면 아래 기본값 */
    }
  }
  selfCache = { at: Date.now(), value: empty };
  return empty;
}

/* ------------------------------------------------------------------ */
/* 보호 판정 (1겹에서도, 전송 직전에도 같은 함수를 쓴다)                 */
/* ------------------------------------------------------------------ */

export function guardVerdict(container: { id?: string; name?: string; labels?: Record<string, string> }, self: SelfIdentity): GuardVerdict {
  const name = String(container.name || '').replace(/^\//, '').toLowerCase();
  const labels = container.labels || {};
  const project = String(labels['com.docker.compose.project'] || '');
  const service = String(labels['com.docker.compose.service'] || '');

  if (self.id && container.id && String(container.id).startsWith(self.id.slice(0, 12))) {
    return { protected: true, reason: '지금 이 요청을 실행하는 포몽 에이전트 자신의 컨테이너입니다' };
  }
  if (self.name && name === self.name.toLowerCase()) {
    return { protected: true, reason: '지금 이 요청을 실행하는 포몽 에이전트 자신의 컨테이너입니다' };
  }
  const prefix = GUARD_PREFIXES.find((item) => name.startsWith(item));
  if (prefix) {
    return { protected: true, reason: `이름이 '${prefix}'로 시작하는 포몽 컨테이너입니다` };
  }
  if (EXTRA_GUARD_NAMES.includes(name)) {
    return { protected: true, reason: '보호 목록에 지정된 포몽 컨테이너입니다' };
  }
  if (GUARD_SERVICES.has(service)) {
    return { protected: true, reason: `compose 서비스 '${service}'는 포몽 구성 요소입니다` };
  }
  if (self.project && project && project === self.project) {
    return { protected: true, reason: `같은 compose 프로젝트('${project}')에 속한 포몽 컨테이너입니다` };
  }
  return { protected: false, reason: '' };
}

/* ------------------------------------------------------------------ */
/* 조회                                                                */
/* ------------------------------------------------------------------ */

export async function listContainers(): Promise<DockerContainer[]> {
  const raw = await dockerJson<
    { Id: string; Names?: string[]; Image?: string; State?: string; Status?: string; Labels?: Record<string, string>; Ports?: DockerContainer['ports']; Created?: number }[]
  >('/containers/json?all=1');
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    id: String(item.Id || ''),
    name: String((item.Names?.[0] || '').replace(/^\//, '')),
    image: String(item.Image || ''),
    state: String(item.State || 'unknown'),
    status: String(item.Status || ''),
    labels: item.Labels || {},
    ports: item.Ports || [],
    created: item.Created,
  }));
}

export async function inspectContainer(ref: string): Promise<DockerContainer> {
  const info = await dockerJson<{
    Id: string;
    Name?: string;
    Config?: { Image?: string; Labels?: Record<string, string> };
    State?: { Status?: string; Health?: { Status?: string }; RestartCount?: number; StartedAt?: string };
    HostConfig?: { RestartPolicy?: { Name?: string } };
  }>(`/containers/${encodeURIComponent(ref)}/json`);
  return {
    id: String(info.Id || ''),
    name: String((info.Name || ref).replace(/^\//, '')),
    image: String(info.Config?.Image || ''),
    state: String(info.State?.Status || 'unknown'),
    status: info.State?.Health?.Status ? `health: ${info.State.Health.Status}` : String(info.State?.Status || ''),
    labels: info.Config?.Labels || {},
  };
}

/** 이름(정확) · 이름 일부 · id 접두어로 대상 찾기. 여러 개가 걸리면 후보를 알려 준다. */
export async function resolveContainer(
  ref: string,
  containers?: DockerContainer[]
): Promise<{ found: DockerContainer } | { error: string; candidates?: string[] }> {
  const raw = String(ref || '').trim();
  if (!raw) return { error: '어떤 컨테이너인지 이름을 알려 주세요.' };
  const list = containers || (await listContainers());
  const key = raw.replace(/^\//, '').toLowerCase();
  const exact = list.find((item) => item.name.toLowerCase() === key || item.id === raw);
  if (exact) return { found: exact };
  if (/^[0-9a-f]{4,}$/i.test(raw)) {
    const byId = list.filter((item) => item.id.toLowerCase().startsWith(key));
    if (byId.length === 1) return { found: byId[0] };
    if (byId.length > 1) return { error: `'${raw}'로 시작하는 컨테이너가 여러 개입니다.`, candidates: byId.map((item) => item.name) };
  }
  const partial = list.filter((item) => item.name.toLowerCase().includes(key));
  if (partial.length === 1) return { found: partial[0] };
  if (partial.length > 1) return { error: `'${raw}'와 비슷한 컨테이너가 여러 개입니다.`, candidates: partial.map((item) => item.name) };
  return { error: `'${raw}' 컨테이너를 찾지 못했습니다.`, candidates: list.map((item) => item.name) };
}

function demuxLogs(buffer: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if ((stream !== 0 && stream !== 1 && stream !== 2) || size === 0 || size > buffer.length) {
      // TTY 컨테이너는 머리글 없이 원문이 그대로 온다.
      return buffer.toString('utf8');
    }
    const start = offset + 8;
    parts.push(buffer.subarray(start, Math.min(buffer.length, start + size)).toString('utf8'));
    offset = start + size;
  }
  return parts.length ? parts.join('') : buffer.toString('utf8');
}

export async function containerLogs(id: string, tail = 60): Promise<string> {
  const lines = Math.max(1, Math.min(300, Math.round(tail) || 60));
  const res = await dockerRequestRaw(
    `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${lines}&timestamps=1`,
    { timeoutMs: 10_000 }
  );
  if (res.status >= 400) throw new Error(`로그 응답 ${res.status}`);
  return demuxLogs(res.body).slice(0, 20_000);
}

/* ------------------------------------------------------------------ */
/* 상태 변경 (2겹 검사)                                                */
/* ------------------------------------------------------------------ */

export async function changeContainerState(
  container: DockerContainer,
  action: string,
  self?: SelfIdentity
): Promise<{ ok: true; state: string } | { ok: false; error: string }> {
  const normalized = String(action || '').toLowerCase();
  if (BLOCKED_ACTIONS.has(normalized)) {
    return { ok: false, error: `${normalized} 동작은 허용되지 않습니다(삭제·파괴·명령 실행 차단).` };
  }
  if (!ALLOWED_STATE_ACTIONS.has(normalized)) {
    return { ok: false, error: `${normalized} 동작은 지원하지 않습니다.` };
  }
  // ── 2겹: 요청을 보내기 직전에 실제 컨테이너 정보를 다시 읽어 보호 대상을 확인한다.
  const identity = self || (await selfIdentity());
  let fresh: DockerContainer;
  try {
    fresh = await inspectContainer(container.id || container.name);
  } catch (err) {
    return { ok: false, error: `컨테이너 상태를 다시 확인하지 못해 ${normalized}을(를) 취소했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  const verdict = guardVerdict(fresh, identity);
  if (verdict.protected) {
    return { ok: false, error: `포몽 자신의 컨테이너는 ${normalized}할 수 없습니다 — ${verdict.reason}.` };
  }
  const query = normalized === 'stop' || normalized === 'restart' ? '?t=10' : '';
  const res = await dockerRequestRaw(`/containers/${encodeURIComponent(fresh.id)}/${normalized}${query}`, { method: 'POST' });
  if (res.status >= 400) {
    const detail = res.body.toString('utf8').slice(0, 300);
    return { ok: false, error: `${normalized} 실패(도커 응답 ${res.status})${detail ? `: ${detail}` : ''}` };
  }
  // 결과 상태를 다시 읽어 실제로 바뀌었는지 확인한다.
  const after = await inspectContainer(fresh.id).catch(() => null);
  return { ok: true, state: after?.state || (normalized === 'stop' ? 'exited' : 'running') };
}

/* ------------------------------------------------------------------ */
/* 도구 문구                                                           */
/* ------------------------------------------------------------------ */

const ACTION_LABELS: Record<string, string> = {
  ps: '목록 조회',
  logs: '로그 보기',
  inspect: '상세 조회',
  start: '시작',
  stop: '중지',
  restart: '재시작',
  pause: '일시정지',
  unpause: '다시 시작',
};

export interface ManageDockerInput {
  action?: unknown;
  container?: unknown;
  tail?: unknown;
}

export async function manageDockerBehavior(
  input: ManageDockerInput,
  ctx: { userRequest?: string } = {}
): Promise<{ content: string }> {
  const action = String(input.action || 'ps').trim().toLowerCase();
  if (BLOCKED_ACTIONS.has(action)) {
    return {
      content:
        `'${action}' 동작은 서버에서 원천 차단됩니다. 이 도구는 목록(ps)·상세(inspect)·로그(logs)·` +
        '시작(start)·중지(stop)·재시작(restart)·일시정지(pause)·다시 시작(unpause)만 할 수 있습니다. ' +
        '컨테이너 삭제(rm)·정리(prune)·강제 종료(kill)·명령 실행(exec)은 사용자가 부탁해도 실행하지 말고 그 사실을 알려 주세요.',
    };
  }
  if (!dockerAvailable()) {
    return {
      content:
        '도커 소켓(/var/run/docker.sock)을 읽을 수 없습니다. docker-compose.yml의 pomong-agent volumes에 ' +
        '`/var/run/docker.sock:/var/run/docker.sock`(읽기 전용 `:ro` 제외)을 넣고 컨테이너를 다시 만들어야 합니다.',
    };
  }

  let containers: DockerContainer[];
  try {
    containers = await listContainers();
  } catch (err) {
    return { content: `도커에 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  const self = await selfIdentity();

  if (action === 'ps') {
    if (!containers.length) return { content: '이 서버에는 컨테이너가 없습니다.' };
    const lines = containers
      .slice()
      .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name))
      .map((item) => {
        const verdict = guardVerdict(item, self);
        const mark = verdict.protected ? ' 🔒 포몽 자신' : '';
        const status = item.status || item.state;
        return `- ${item.name} · ${item.image} · ${status}${mark}`;
      });
    const running = containers.filter((item) => item.state === 'running').length;
    return {
      content: [
        `🐳 컨테이너 ${containers.length}개 (실행 중 ${running}개)`,
        ...lines,
        '',
        '🔒 표시는 포몽 에이전트 자신의 컨테이너입니다 — 로그와 상태만 볼 수 있고 중지·재시작은 서버가 거부합니다.',
      ].join('\n'),
    };
  }

  const ref = String(input.container || '').trim();
  if (!ref) {
    return { content: `${ACTION_LABELS[action] || action}할 컨테이너 이름을 함께 알려 주세요. (먼저 ps로 목록을 확인할 수 있습니다)` };
  }
  const resolved = await resolveContainer(ref, containers);
  if ('error' in resolved) {
    const hint = resolved.candidates?.length ? `\n후보: ${resolved.candidates.slice(0, 12).join(', ')}` : '';
    return { content: `${resolved.error}${hint}` };
  }
  const target = resolved.found;
  const verdict = guardVerdict(target, self);

  if (action === 'inspect') {
    let detail = '';
    try {
      const info = await inspectContainer(target.id);
      detail = `이미지: ${info.image}\n상태: ${info.state}${info.status ? ` (${info.status})` : ''}`;
    } catch {
      detail = `이미지: ${target.image}\n상태: ${target.status || target.state}`;
    }
    const project = target.labels['com.docker.compose.project'];
    const service = target.labels['com.docker.compose.service'];
    return {
      content: [
        `🔍 ${target.name}`,
        detail,
        project ? `compose 프로젝트: ${project}${service ? ` · 서비스 ${service}` : ''}` : '',
        verdict.protected ? `🔒 포몽 자신의 컨테이너입니다 — ${verdict.reason}. 중지·재시작은 거부됩니다.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  if (action === 'logs') {
    try {
      const text = await containerLogs(target.id, Number(input.tail) || 60);
      return {
        content: [
          `📜 ${target.name} 최근 로그${verdict.protected ? ' (포몽 자신 — 보기만 가능)' : ''}`,
          text.trim() ? text.trim().slice(-4000) : '(로그가 비어 있습니다)',
        ].join('\n'),
      };
    } catch (err) {
      return { content: `${target.name} 로그를 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (!ALLOWED_STATE_ACTIONS.has(action)) {
    return { content: `지원하지 않는 동작입니다: ${action} (ps·logs·inspect·start·stop·restart·pause·unpause)` };
  }

  // ── 1겹: 보호 대상이면 요청 자체를 만들지 않는다.
  if (verdict.protected) {
    return {
      content:
        `⛔ ${target.name}은(는) 포몽 자신의 컨테이너라 ${ACTION_LABELS[action] || action}할 수 없습니다 — ${verdict.reason}. ` +
        '이 차단은 서버 코드가 강제하며 우회할 수 없습니다. 사용자에게 이 사실을 그대로 알려 주세요(로그·상태 조회만 가능).',
    };
  }
  if (!ctx.userRequest || !ctx.userRequest.trim()) {
    return {
      content:
        `컨테이너 ${ACTION_LABELS[action] || action}은 사용자가 직접 요청했을 때만 실행합니다. ` +
        '지금은 요청 문장이 없어 실행하지 않았습니다. 사용자에게 먼저 확인해 주세요.',
    };
  }

  const result = await changeContainerState(target, action, self);
  if (!result.ok) return { content: `⛔ ${target.name}: ${result.error}` };
  return {
    content: [
      `✅ ${target.name} ${ACTION_LABELS[action] || action} 완료 — 현재 상태: ${result.state}`,
      '사용자에게 무엇을 했고 상태가 어떻게 바뀌었는지 한두 문장으로 알려 주세요.',
    ].join('\n'),
  };
}
