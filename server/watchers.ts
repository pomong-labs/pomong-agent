import crypto from 'node:crypto';
import zlib from 'node:zlib';
import * as cheerio from 'cheerio';
import { addLog, db } from './db';

/**
 * 워치(웹 변화 감시)
 * - 추출: CSS 선택자 · 전체 텍스트 · JSON 경로 · 정규식 · 가격/재고 · RSS/Atom · GitHub · 서버 ping
 * - 정규화 후 SHA-256 비교, 변경 시 이전/이후 요약(diff)
 * - 주기 최소 5분(기본 30분) ±10% 지터, 실패 3회면 알림 + 주기 2배(최대 4시간)
 * - robots.txt 존중(User-Agent 명시)
 */

export type WatchMode = 'selector' | 'text' | 'json' | 'regex' | 'price' | 'rss' | 'github' | 'ping';

export interface WatcherRow {
  id: string;
  name: string;
  url: string;
  mode: WatchMode;
  target: string | null;
  interval_min: number;
  quiet_hours: string | null;
  enabled: number;
  last_hash: string | null;
  last_value: string | null;
  last_checked: string | null;
  last_status: string | null;
  fail_count: number;
  next_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WatchEventRow {
  id: string;
  watcher_id: string;
  kind: 'changed' | 'failed' | 'recovered' | 'first';
  diff_summary: string | null;
  before_text: string | null;
  after_text: string | null;
  url: string | null;
  created_at: string;
  notified_at: string | null;
}

export interface WatcherView {
  id: string;
  name: string;
  url: string;
  mode: WatchMode;
  target: string | null;
  intervalMin: number;
  quietHours: string | null;
  enabled: boolean;
  lastHash: string | null;
  lastValue: string | null;
  lastChecked: string | null;
  lastStatus: string | null;
  failCount: number;
  nextCheckAt: string | null;
  createdAt: string;
  events?: WatchEventView[];
  lastEvent?: WatchEventView | null;
}

export interface WatchEventView {
  id: string;
  watcherId: string;
  kind: WatchEventRow['kind'];
  diffSummary: string | null;
  beforeText: string | null;
  afterText: string | null;
  url: string | null;
  createdAt: string;
  notifiedAt: string | null;
}

export const MAX_WATCHERS = 20;
export const MIN_INTERVAL = 5;
export const MAX_SNAPSHOTS = 30;

export const MODE_LABELS: Record<WatchMode, string> = {
  selector: 'CSS 선택자',
  text: '페이지 전체 텍스트',
  json: 'JSON 경로',
  regex: '정규식',
  price: '가격·재고',
  rss: 'RSS/Atom',
  github: 'GitHub 릴리스',
  ping: '서버 응답',
};

const UA = 'PomongAgent/0.4.0 (+https://github.com/pomong-labs/pomong-agent)';

export function toEventView(row: WatchEventRow): WatchEventView {
  return {
    id: row.id,
    watcherId: row.watcher_id,
    kind: row.kind,
    diffSummary: row.diff_summary,
    beforeText: row.before_text,
    afterText: row.after_text,
    url: row.url,
    createdAt: row.created_at,
    notifiedAt: row.notified_at,
  };
}

function latestEvent(watcherId: string): WatchEventRow | null {
  const row = db
    .prepare('SELECT * FROM watch_events WHERE watcher_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(watcherId) as WatchEventRow | undefined;
  return row || null;
}

export function toWatcherView(row: WatcherRow, withEvents = true): WatcherView {
  const last = withEvents ? latestEvent(row.id) : null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    mode: row.mode,
    target: row.target,
    intervalMin: row.interval_min,
    quietHours: row.quiet_hours,
    enabled: Boolean(row.enabled),
    lastHash: row.last_hash,
    lastValue: row.last_value,
    lastChecked: row.last_checked,
    lastStatus: row.last_status,
    failCount: row.fail_count,
    nextCheckAt: row.next_check_at,
    createdAt: row.created_at,
    lastEvent: last ? toEventView(last) : null,
  };
}

export function listWatchers(): WatcherView[] {
  const rows = db.prepare('SELECT * FROM watchers ORDER BY created_at ASC').all() as WatcherRow[];
  return rows.map((r) => toWatcherView(r));
}

export function getWatcher(id: string): WatcherView | null {
  const row = db.prepare('SELECT * FROM watchers WHERE id = ?').get(id) as WatcherRow | undefined;
  return row ? toWatcherView(row) : null;
}

export function listEvents(watcherId?: string, limit = 40): WatchEventView[] {
  const rows = watcherId
    ? (db.prepare('SELECT * FROM watch_events WHERE watcher_id = ? ORDER BY created_at DESC LIMIT ?').all(watcherId, limit) as WatchEventRow[])
    : (db.prepare('SELECT * FROM watch_events ORDER BY created_at DESC LIMIT ?').all(limit) as WatchEventRow[]);
  return rows.map(toEventView);
}

export interface WatcherInput {
  name?: string;
  url?: string;
  mode?: WatchMode;
  target?: string | null;
  intervalMin?: number;
  quietHours?: string | null;
  enabled?: boolean;
}

export function normalizeMode(value: unknown): WatchMode {
  const modes: WatchMode[] = ['selector', 'text', 'json', 'regex', 'price', 'rss', 'github', 'ping'];
  return modes.includes(value as WatchMode) ? (value as WatchMode) : 'text';
}

function normalizeInterval(value: unknown): number {
  const n = Math.round(Number(value) || 30);
  return Math.max(MIN_INTERVAL, Math.min(24 * 60, n));
}

function nextCheckAt(intervalMin: number, jitter = true): string {
  const jitterFactor = jitter ? 1 + (Math.random() * 0.2 - 0.1) : 1;
  return new Date(Date.now() + intervalMin * 60_000 * jitterFactor).toISOString();
}

export function createWatcher(input: WatcherInput): WatcherView {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM watchers').get() as { n: number }).n;
  if (count >= MAX_WATCHERS) throw new Error(`워치는 최대 ${MAX_WATCHERS}개까지 만들 수 있습니다.`);
  const name = String(input.name || '').trim().slice(0, 80);
  const url = String(input.url || '').trim().slice(0, 2000);
  if (!name) throw new Error('감시 이름을 입력해 주세요.');
  if (!/^https?:\/\//i.test(url)) throw new Error('http:// 또는 https://로 시작하는 주소를 입력해 주세요.');
  const mode = normalizeMode(input.mode);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO watchers(id, name, url, mode, target, interval_min, quiet_hours, enabled, next_check_at, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    url,
    mode,
    input.target ? String(input.target).slice(0, 400) : null,
    normalizeInterval(input.intervalMin),
    input.quietHours ? String(input.quietHours).slice(0, 40) : null,
    input.enabled === false ? 0 : 1,
    nextCheckAt(normalizeInterval(input.intervalMin), false),
    now,
    now
  );
  addLog('info', `워치 추가 · ${name} (${MODE_LABELS[mode]})`);
  return getWatcher(id) as WatcherView;
}

export function updateWatcher(id: string, input: WatcherInput): WatcherView {
  const current = db.prepare('SELECT * FROM watchers WHERE id = ?').get(id) as WatcherRow | undefined;
  if (!current) throw new Error('워치를 찾을 수 없습니다.');
  const name = input.name === undefined ? current.name : String(input.name).trim().slice(0, 80);
  const url = input.url === undefined ? current.url : String(input.url).trim().slice(0, 2000);
  if (!name) throw new Error('감시 이름을 입력해 주세요.');
  if (!/^https?:\/\//i.test(url)) throw new Error('http:// 또는 https://로 시작하는 주소를 입력해 주세요.');
  const mode = input.mode === undefined ? current.mode : normalizeMode(input.mode);
  const interval = input.intervalMin === undefined ? current.interval_min : normalizeInterval(input.intervalMin);
  const target = input.target === undefined ? current.target : input.target ? String(input.target).slice(0, 400) : null;
  const enabled = input.enabled === undefined ? Boolean(current.enabled) : Boolean(input.enabled);
  db.prepare(
    'UPDATE watchers SET name=?, url=?, mode=?, target=?, interval_min=?, quiet_hours=?, enabled=?, next_check_at=?, updated_at=? WHERE id=?'
  ).run(
    name,
    url,
    mode,
    target,
    interval,
    input.quietHours === undefined ? current.quiet_hours : input.quietHours ? String(input.quietHours).slice(0, 40) : null,
    enabled ? 1 : 0,
    enabled ? current.next_check_at || nextCheckAt(interval, false) : null,
    new Date().toISOString(),
    id
  );
  return getWatcher(id) as WatcherView;
}

export function deleteWatcher(id: string): void {
  db.prepare('DELETE FROM watcher_snapshots WHERE watcher_id = ?').run(id);
  db.prepare('DELETE FROM watch_events WHERE watcher_id = ?').run(id);
  db.prepare('DELETE FROM watchers WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ */
/* 추출                                                                */
/* ------------------------------------------------------------------ */

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n')
    .trim()
    .slice(0, 20_000);
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function fetchPage(url: string, timeoutMs = 20_000): Promise<{ status: number; body: string; ms: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    const body = await res.text();
    return { status: res.status, body, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function jsonPath(data: unknown, path: string): unknown {
  const clean = path.replace(/^\$\.?/, '');
  if (!clean) return data;
  const tokens: (string | number)[] = [];
  clean.replace(/\[(\d+)\]|([^.[\]]+)/g, (_m, idx: string, key: string) => {
    tokens.push(idx !== undefined ? Number(idx) : key);
    return '';
  });
  let cursor: unknown = data;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = (cursor as Record<string | number, unknown>)[token as string];
  }
  return cursor;
}

function githubTarget(url: string, target: string | null): { owner: string; repo: string; api: string } {
  const fromUrl = /github\.com\/([^/]+)\/([^/?#]+)/i.exec(url);
  const owner = target && target.includes('/') ? target.split('/')[0] : fromUrl?.[1] || '';
  const repo = target && target.includes('/') ? target.split('/')[1] : fromUrl?.[2] || '';
  return { owner, repo, api: `https://api.github.com/repos/${owner}/${repo}` };
}

async function extract(row: { url: string; mode: WatchMode; target: string | null }): Promise<string> {
  if (row.mode === 'ping') {
    const res = await fetchPage(row.url, 15_000);
    return `상태 ${res.status} · 응답 ${res.ms}ms`;
  }
  if (row.mode === 'github') {
    const { owner, repo, api } = githubTarget(row.url, row.target);
    if (!owner || !repo) throw new Error('GitHub 감시는 대상에 owner/repo를 넣어 주세요.');
    const res = await fetch(api, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = (await res.json()) as {
      tag_name?: string;
      name?: string;
      published_at?: string;
      pushed_at?: string;
      default_branch?: string;
      full_name?: string;
    };
    const release = await fetch(`${api}/releases/latest`, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } });
    let releaseLine = '릴리스 없음';
    if (release.ok) {
      const rel = (await release.json()) as { tag_name?: string; name?: string; published_at?: string };
      releaseLine = `${rel.tag_name || rel.name || ''} · ${rel.published_at || ''}`.trim();
    }
    return normalizeText(`${data.full_name || `${owner}/${repo}`}\n최근 릴리스: ${releaseLine}\n최근 푸시: ${data.pushed_at || '-'}`);
  }

  const page = await fetchPage(row.url);
  if (page.status >= 400) throw new Error(`페이지 응답 ${page.status}`);

  if (row.mode === 'json') {
    let data: unknown;
    try {
      data = JSON.parse(page.body);
    } catch {
      throw new Error('JSON으로 읽지 못했습니다(주소가 JSON API인지 확인).');
    }
    const value = jsonPath(data, row.target || '');
    if (value === undefined) throw new Error(`JSON 경로를 찾지 못했습니다: ${row.target || '$'}`);
    return normalizeText(typeof value === 'string' ? value : JSON.stringify(value));
  }

  if (row.mode === 'rss') {
    const $ = cheerio.load(page.body, { xmlMode: true });
    const items = $('item')
      .toArray()
      .map((el) => {
        const node = $(el);
        return `${node.find('title').first().text().trim()} | ${node.find('link').first().text().trim()} | ${node
          .find('pubDate')
          .first()
          .text()
          .trim()}`;
      });
    const entries = $('entry')
      .toArray()
      .map((el) => {
        const node = $(el);
        return `${node.find('title').first().text().trim()} | ${node.find('link').first().attr('href') || ''} | ${node
          .find('updated')
          .first()
          .text()
          .trim()}`;
      });
    const list = (items.length ? items : entries).slice(0, 20);
    if (!list.length) throw new Error('RSS 항목을 찾지 못했습니다.');
    return normalizeText(list.join('\n'));
  }

  if (row.mode === 'regex') {
    if (!row.target) throw new Error('정규식을 대상에 입력해 주세요.');
    let re: RegExp;
    try {
      re = new RegExp(row.target, 'm');
    } catch (err) {
      throw new Error(`정규식 오류: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = cheerio.load(page.body).text();
    const match = re.exec(text);
    if (!match) throw new Error('정규식과 맞는 내용이 없습니다.');
    return normalizeText(match[1] ?? match[0]);
  }

  const $ = cheerio.load(page.body);
  $('script, style, noscript, svg, iframe').remove();

  if (row.mode === 'selector') {
    if (!row.target) throw new Error('CSS 선택자를 입력해 주세요.');
    const node = $(row.target).first();
    if (!node.length) throw new Error(`선택자와 맞는 요소가 없습니다: ${row.target}`);
    return normalizeText(node.text() || node.attr('content') || '');
  }

  if (row.mode === 'price') {
    const text = $('body').text();
    const pattern = row.target
      ? new RegExp(row.target, 'g')
      : /([0-9][0-9,\.]{2,})\s*(원|₩|KRW)|\$\s?([0-9][0-9,\.]{1,})|([0-9][0-9,\.]{1,})\s*(USD|EUR)/g;
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null && found.size < 30) {
      found.add(match[0].replace(/\s+/g, ' ').trim());
    }
    if (!found.size) throw new Error('가격으로 보이는 값을 찾지 못했습니다. 정규식을 직접 넣어 보세요.');
    return normalizeText([...found].join('\n'));
  }

  return normalizeText($('body').text());
}

/** 이전/이후를 사람이 읽을 수 있게 요약(최대 500자) */
export function diffSummary(before: string | null, after: string): string {
  if (!before) return `처음 기록: ${after.slice(0, 200)}`;
  if (before === after) return '변경 없음';
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const added: string[] = [];
  const removed: string[] = [];
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  for (const line of afterLines) {
    if (!beforeSet.has(line) && line.trim()) added.push(line.trim());
    if (added.join(' ').length > 240) break;
  }
  for (const line of beforeLines) {
    if (!afterSet.has(line) && line.trim()) removed.push(line.trim());
    if (removed.join(' ').length > 160) break;
  }
  const parts: string[] = [];
  if (removed.length) parts.push(`이전: ${removed.slice(0, 3).join(' / ')}`);
  if (added.length) parts.push(`이후: ${added.slice(0, 3).join(' / ')}`);
  const summary = parts.join(' → ') || '내용이 바뀌었습니다.';
  return summary.slice(0, 500);
}

function saveSnapshot(watcherId: string, hash: string, content: string): void {
  const gz = zlib.gzipSync(Buffer.from(content, 'utf8')).toString('base64');
  db.prepare('INSERT INTO watcher_snapshots(id, watcher_id, hash, content, captured_at) VALUES(?,?,?,?,?)').run(
    crypto.randomUUID(),
    watcherId,
    hash,
    gz,
    new Date().toISOString()
  );
  db.prepare(
    `DELETE FROM watcher_snapshots WHERE watcher_id = ? AND id NOT IN (
       SELECT id FROM watcher_snapshots WHERE watcher_id = ? ORDER BY captured_at DESC LIMIT ${MAX_SNAPSHOTS}
     )`
  ).run(watcherId, watcherId);
}

function inQuietHours(quiet: string | null): boolean {
  if (!quiet) return false;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(quiet.trim());
  if (!m) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export interface WatchNotifier {
  (watcher: WatcherView, event: WatchEventView): void;
}

let notifier: WatchNotifier | null = null;
let timer: NodeJS.Timeout | null = null;
let checking = false;

export function setWatchNotifier(fn: WatchNotifier): void {
  notifier = fn;
}

function recordEvent(watcher: WatcherRow, kind: WatchEventRow['kind'], summary: string, before: string | null, after: string | null): WatchEventView {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const quiet = inQuietHours(watcher.quiet_hours);
  db.prepare(
    'INSERT INTO watch_events(id, watcher_id, kind, diff_summary, before_text, after_text, url, created_at, notified_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id, watcher.id, kind, summary.slice(0, 600), before?.slice(0, 4000) || null, after?.slice(0, 4000) || null, watcher.url, now, quiet ? null : now);
  const row = db.prepare('SELECT * FROM watch_events WHERE id = ?').get(id) as WatchEventRow;
  const view = toEventView(row);
  if (!quiet) notifier?.(toWatcherView(watcher, false), view);
  return view;
}

/** 워치 1회 확인. 변경이면 이벤트를 남긴다. */
export async function checkWatcherNow(id: string, trigger = 'manual'): Promise<{ watcher: WatcherView; event: WatchEventView | null; value: string }> {
  const row = db.prepare('SELECT * FROM watchers WHERE id = ?').get(id) as WatcherRow | undefined;
  if (!row) throw new Error('워치를 찾을 수 없습니다.');
  const now = new Date().toISOString();
  try {
    const value = await extract({ url: row.url, mode: row.mode, target: row.target });
    const hash = sha256(value);
    const first = !row.last_hash;
    const changed = !first && hash !== row.last_hash;
    const recovered = row.fail_count > 0;
    saveSnapshot(row.id, hash, value);
    db.prepare(
      'UPDATE watchers SET last_hash=?, last_value=?, last_checked=?, last_status=?, fail_count=0, next_check_at=?, updated_at=? WHERE id=?'
    ).run(hash, value.slice(0, 2000), now, changed ? 'changed' : 'ok', nextCheckAt(row.interval_min), now, row.id);

    let event: WatchEventView | null = null;
    if (first) {
      event = recordEvent(row, 'first', `처음 기록: ${value.slice(0, 200)}`, null, value);
      addLog('info', `워치 첫 기록 · ${row.name}`);
    } else if (changed) {
      event = recordEvent(row, 'changed', diffSummary(row.last_value, value), row.last_value, value);
      addLog('success', `워치 변경 감지 · ${row.name}`);
    } else if (recovered) {
      event = recordEvent(row, 'recovered', '다시 정상적으로 확인되고 있습니다.', null, value);
      addLog('info', `워치 복구 · ${row.name}`);
    }
    return { watcher: getWatcher(row.id) as WatcherView, event, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failCount = row.fail_count + 1;
    // 실패는 3회부터 알린다(일시적 오류로 알림이 쏟아지지 않게).
    const backoffFactor = failCount >= 3 ? Math.min(8, 2 ** (failCount - 2)) : 1;
    const interval = Math.min(24 * 60, row.interval_min * backoffFactor);
    db.prepare('UPDATE watchers SET last_checked=?, last_status=?, fail_count=?, next_check_at=?, updated_at=? WHERE id=?').run(
      now,
      'failed',
      failCount,
      nextCheckAt(interval),
      now,
      row.id
    );
    let event: WatchEventView | null = null;
    if (failCount >= 3) {
      event = recordEvent(row, 'failed', `확인 실패 ${failCount}회 · ${message.slice(0, 200)} · 주기 ${interval}분로 늦춤`, null, null);
      addLog('warn', `워치 실패 ${failCount}회 · ${row.name}: ${message.slice(0, 120)}`);
    }
    if (trigger === 'manual') throw new Error(message);
    return { watcher: getWatcher(row.id) as WatcherView, event, value: '' };
  }
}

export function startWatcherLoop(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void tick();
  }, 30_000);
  timer.unref?.();
  setTimeout(() => void tick(), 8_000).unref?.();
}

export function stopWatcherLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const now = Date.now();
    const rows = db
      .prepare('SELECT * FROM watchers WHERE enabled = 1')
      .all() as WatcherRow[];
    for (const row of rows) {
      const due = row.next_check_at ? new Date(row.next_check_at).getTime() : 0;
      if (due > now) continue;
      // 한 번에 하나씩(1GB 서버 보호)
      await checkWatcherNow(row.id, 'schedule');
    }
  } catch (err) {
    addLog('error', `워치 오류: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    checking = false;
  }
}
