import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config';
import { addLog, db } from './db';
import * as attachments from './attachments';

/**
 * 받은 파일 · 결과물 보관함 (v0.5.5)
 *
 * 한곳에서 보여 주는 파일은 세 갈래다.
 *  - chat    : 채팅에 올린 첨부(사진·PDF·문서). 파일은 data/uploads/ 에 있고 메타데이터는 chat_attachments.
 *  - browser : AI가 연 브라우저가 저장한 화면·내려받기 파일. data/files/ 아래.
 *  - agent   : AI가 만들어 준 결과물(file_save 도구). data/files/agent/ 아래.
 *
 * 목록은 두 테이블(chat_attachments, saved_files)을 합쳐서 만들고,
 * saved_files에 없는 data/files/ 파일은 처음 조회할 때 등록해 준다(스캔).
 * 경로는 언제나 DATA_DIR 안쪽만 허용한다(`..` 탈출 방어).
 */

export type FileSource = 'chat' | 'browser' | 'agent';

export interface FileItem {
  /** 'a:<첨부 id>' 또는 'f:<저장 파일 id>' */
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: attachments.AttachmentKind;
  source: FileSource;
  /** 사진은 화면에 바로 보여 줄 수 있는 주소 */
  previewUrl: string;
  downloadUrl: string;
  createdAt: string;
  sessionId: string | null;
  /** 서버 디스크에 실제로 남아 있는지 */
  exists: boolean;
}

export interface ResolvedFile {
  item: FileItem;
  absPath: string;
}

interface SavedFileRow {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  source: string;
  path: string;
  created_at: string;
}

const FILES_DIR = 'files';
const MAX_SCAN_FILES = 3000;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
};

function sanitizeName(name: string): string {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim();
  return (base || 'file').slice(0, 120);
}

/**
 * DATA_DIR 안쪽 경로만 돌려준다. `..`·절대경로·빈 값은 null.
 * 목록·다운로드·삭제 어디서든 파일 경로는 이 함수를 거친다.
 */
export function resolveInside(relative: string): string | null {
  const raw = String(relative || '').replace(/\\/g, '/').replace(/\u0000/g, '');
  if (!raw.trim()) return null;
  const root = path.resolve(DATA_DIR);
  const abs = path.resolve(root, raw);
  if (abs === root) return null;
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

function toRelative(abs: string): string {
  return path.relative(path.resolve(DATA_DIR), abs).split(path.sep).join('/');
}

function fileExists(abs: string | null): boolean {
  if (!abs) return false;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function sizeOf(abs: string | null, fallback = 0): number {
  if (!abs) return fallback;
  try {
    return fs.statSync(abs).size;
  } catch {
    return fallback;
  }
}

function mimeOf(name: string, given?: string): string {
  const type = String(given || '').trim();
  if (type && type !== 'application/octet-stream') return type;
  const ext = path.extname(name).replace('.', '').toLowerCase();
  return MIME_BY_EXT[ext] || attachments.guessMime(name);
}

/** DATA_DIR 안쪽의 실제 파일 경로만 돌려준다. */
function insideDataDir(abs: string | null): string | null {
  if (!abs) return null;
  const root = path.resolve(DATA_DIR);
  const resolved = path.resolve(abs);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

function chatItem(row: attachments.AttachmentRow): FileItem {
  const safeAbs = insideDataDir(attachments.absolutePath(row));
  return {
    id: `a:${row.id}`,
    name: row.filename,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    source: 'chat',
    previewUrl: `/api/files/a:${row.id}/download`,
    downloadUrl: `/api/files/a:${row.id}/download?download=1`,
    createdAt: row.created_at,
    sessionId: row.session_id || null,
    exists: fileExists(safeAbs),
    // 실제 크기는 디스크 기준이 더 정확할 때가 있어 보정한다.
    ...(fileExists(safeAbs) ? { size: sizeOf(safeAbs, row.size) } : null),
  };
}

function savedItem(row: SavedFileRow): FileItem {
  const abs = resolveInside(row.path);
  const kind = (['image', 'pdf', 'text', 'other'] as const).includes(row.kind as attachments.AttachmentKind)
    ? (row.kind as attachments.AttachmentKind)
    : attachments.classify(row.name, row.mime);
  return {
    id: `f:${row.id}`,
    name: row.name,
    mime: row.mime,
    size: fileExists(abs) ? sizeOf(abs, row.size) : row.size,
    kind,
    source: row.source === 'agent' ? 'agent' : 'browser',
    previewUrl: `/api/files/f:${row.id}/download`,
    downloadUrl: `/api/files/f:${row.id}/download?download=1`,
    createdAt: row.created_at,
    sessionId: null,
    exists: fileExists(abs),
  };
}

function walk(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || out.length >= MAX_SCAN_FILES) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) break;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, depth + 1, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** data/files/ 에 있는데 목록에 없는 파일(브라우저 화면·내려받기 등)을 등록한다. */
export function syncScannedFiles(): number {
  const root = resolveInside(FILES_DIR);
  if (!root || !fs.existsSync(root)) return 0;
  const known = new Set(
    (db.prepare('SELECT path FROM saved_files').all() as { path: string }[]).map((r) => r.path)
  );
  let added = 0;
  for (const abs of walk(root)) {
    const rel = toRelative(abs);
    if (known.has(rel)) continue;
    const name = path.basename(abs);
    const mime = mimeOf(name);
    const kind = attachments.classify(name, mime);
    const stat = fs.statSync(abs);
    const source: FileSource = rel.includes('/agent/') || rel.startsWith('files/agent') ? 'agent' : 'browser';
    db.prepare(
      'INSERT OR IGNORE INTO saved_files(id, name, mime, size, kind, source, path, created_at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(crypto.randomUUID(), name, mime, stat.size, kind, source, rel, stat.mtime.toISOString());
    known.add(rel);
    added += 1;
  }
  if (added) addLog('info', `파일함에 파일 ${added}개를 새로 등록했습니다`);
  return added;
}

export interface ListOptions {
  q?: string;
  kind?: string;
  source?: string;
  limit?: number;
}

export function listFiles(options: ListOptions = {}): FileItem[] {
  syncScannedFiles();
  const chatRows = db
    .prepare('SELECT * FROM chat_attachments ORDER BY created_at DESC LIMIT 500')
    .all() as attachments.AttachmentRow[];
  const savedRows = db
    .prepare('SELECT * FROM saved_files ORDER BY created_at DESC LIMIT 500')
    .all() as SavedFileRow[];
  let items = [...chatRows.map(chatItem), ...savedRows.map(savedItem)].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  const q = String(options.q || '').trim().toLowerCase();
  if (q) items = items.filter((item) => item.name.toLowerCase().includes(q));
  const kind = String(options.kind || '').trim();
  if (kind && kind !== 'all') items = items.filter((item) => item.kind === kind);
  const source = String(options.source || '').trim();
  if (source && source !== 'all') items = items.filter((item) => item.source === source);
  const limit = Math.min(1000, Math.max(1, Number(options.limit) || 300));
  return items.slice(0, limit);
}

export function totals(items: FileItem[]): { count: number; bytes: number; images: number; missing: number } {
  return {
    count: items.length,
    bytes: items.reduce((sum, item) => sum + (Number(item.size) || 0), 0),
    images: items.filter((item) => item.kind === 'image').length,
    missing: items.filter((item) => !item.exists).length,
  };
}

/** id로 실제 파일을 찾는다. 목록에 없는 id·경로 탈출은 null. */
export function resolveFile(id: string): ResolvedFile | null {
  const raw = String(id || '').trim();
  if (!raw) return null;
  if (raw.startsWith('a:')) {
    const row = attachments.getRow(raw.slice(2));
    if (!row) return null;
    const abs = insideDataDir(attachments.absolutePath(row));
    if (!abs) return null;
    return { item: chatItem(row), absPath: abs };
  }
  if (raw.startsWith('f:')) {
    const row = db.prepare('SELECT * FROM saved_files WHERE id = ?').get(raw.slice(2)) as SavedFileRow | undefined;
    if (!row) return null;
    const abs = resolveInside(row.path);
    if (!abs) return null;
    return { item: savedItem(row), absPath: abs };
  }
  return null;
}

/**
 * AI가 만든 결과물을 파일로 저장한다(도구 file_save).
 * 텍스트뿐 아니라 base64로 받은 바이너리도 저장할 수 있다.
 */
export function saveFile(input: {
  name: string;
  data: Buffer;
  source?: FileSource;
  mime?: string;
  sessionId?: string | null;
}): FileItem {
  const data = input.data;
  if (!data || !data.length) throw new Error('저장할 내용이 비어 있습니다.');
  if (data.length > 20 * 1024 * 1024) throw new Error('파일이 너무 큽니다(최대 20MB).');
  const name = sanitizeName(input.name);
  const mime = mimeOf(name, input.mime);
  const kind = attachments.classify(name, mime);
  const source: FileSource = input.source === 'browser' ? 'browser' : 'agent';
  const id = crypto.randomUUID();
  const now = new Date();
  const folder = path.join(FILES_DIR, source, `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`);
  const dir = resolveInside(folder);
  if (!dir) throw new Error('저장 경로가 올바르지 않습니다.');
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name).slice(0, 10);
  const safeAbs = insideDataDir(path.join(dir, `${id.slice(0, 8)}-${name}${ext || ''}`));
  if (!safeAbs) throw new Error('저장 경로가 올바르지 않습니다.');
  fs.writeFileSync(safeAbs, data, { mode: 0o600 });
  db.prepare(
    'INSERT INTO saved_files(id, name, mime, size, kind, source, path, created_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id, name, mime, data.length, kind, source, toRelative(safeAbs), now.toISOString());
  addLog('info', `파일함에 저장 · ${name} (${(data.length / 1024).toFixed(0)}KB · ${source})`);
  const row = db.prepare('SELECT * FROM saved_files WHERE id = ?').get(id) as SavedFileRow;
  return savedItem(row);
}

/** 파일 하나를 지운다(채팅 첨부는 chat_attachments 행도 함께). */
export function deleteFile(id: string): { ok: boolean; removed: boolean } {
  const raw = String(id || '').trim();
  if (raw.startsWith('a:')) {
    const attachmentId = raw.slice(2);
    const row = attachments.getRow(attachmentId);
    if (!row) return { ok: false, removed: false };
    const abs = insideDataDir(attachments.absolutePath(row));
    let removed = false;
    if (abs && fileExists(abs)) {
      try {
        fs.rmSync(abs, { force: true });
        removed = true;
      } catch {
        /* 파일이 이미 없어도 행은 지운다 */
      }
    }
    db.prepare('DELETE FROM chat_attachments WHERE id = ?').run(attachmentId);
    addLog('info', `파일함에서 삭제 · ${row.filename}`);
    return { ok: true, removed };
  }
  if (raw.startsWith('f:')) {
    const fileId = raw.slice(2);
    const row = db.prepare('SELECT * FROM saved_files WHERE id = ?').get(fileId) as SavedFileRow | undefined;
    if (!row) return { ok: false, removed: false };
    const abs = resolveInside(row.path);
    let removed = false;
    if (abs && fileExists(abs)) {
      try {
        fs.rmSync(abs, { force: true });
        removed = true;
      } catch {
        /* ignore */
      }
    }
    db.prepare('DELETE FROM saved_files WHERE id = ?').run(fileId);
    addLog('info', `파일함에서 삭제 · ${row.name}`);
    return { ok: true, removed };
  }
  return { ok: false, removed: false };
}

/** 내려받기 응답에 쓸 Content-Disposition (줄바꿈·따옴표 제거 + UTF-8 파일명). */
export function contentDisposition(name: string, inline: boolean): string {
  const fallback = String(name || 'file')
    .replace(/[\r\n"]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .slice(0, 120) || 'file';
  return [
    `${inline ? 'inline' : 'attachment'}`,
    `filename="${fallback}"`,
    `filename*=UTF-8''${encodeURIComponent(String(name || 'file').replace(/[\r\n]/g, ''))}`,
  ].join('; ');
}
