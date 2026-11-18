import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from './config';
import { addLog, db } from './db';

/**
 * 채팅 첨부(사진·파일) — v0.5.2
 *
 * - 파일은 data/uploads/ 아래에만 저장한다(배포해도 보존).
 * - 이미지는 AI에게 멀티모달 파트(inlineData / image_url / base64)로 그대로 넘긴다.
 * - 텍스트·코드·CSV·JSON·MD는 내용을 읽어 프롬프트에 붙이고(길면 앞부분),
 *   PDF는 가능한 만큼 텍스트를 뽑아 넘긴다. 뽑지 못하면 파일 정보·저장 경로를 알려 준다.
 * - 대화 기록에는 메타데이터(파일명·크기·종류·주소)만 남고 파일 본문은 남기지 않는다.
 */

export type AttachmentKind = 'image' | 'text' | 'pdf' | 'other';

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
export const MAX_FILES_PER_MESSAGE = 6;
/** 한 번의 프롬프트에 넣는 이미지는 최대 4장(서버 메모리 보호) */
const MAX_INLINE_IMAGES = 4;
/** 이미지 1장 인라인 상한(base64 전 원본 바이트) */
const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;
/** 텍스트 파일에서 프롬프트에 넣는 최대 글자 수 */
const MAX_TEXT_CHARS = 12_000;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif']);
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yml', 'yaml', 'xml', 'html', 'htm',
  'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'ini', 'toml', 'cfg', 'conf',
  'env', 'log', 'srt', 'vtt', 'tex',
]);

export interface AttachmentRow {
  id: string;
  session_id: string;
  message_id: number | null;
  filename: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  path: string;
  created_at: string;
}

export interface AttachmentView {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  url: string;
  downloadUrl: string;
  messageId: number | null;
  createdAt: string;
}

export interface InlineImage {
  mime: string;
  dataBase64: string;
}

function extOf(filename: string): string {
  const ext = path.extname(filename || '').replace('.', '').toLowerCase();
  return ext.slice(0, 8);
}

function sanitizeFilename(name: string): string {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim();
  return (base || 'file').slice(0, 120);
}

export function classify(filename: string, mime: string): AttachmentKind {
  const ext = extOf(filename);
  const type = String(mime || '').toLowerCase();
  if (type.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('text/') || TEXT_EXT.has(ext) || /json|xml|csv|javascript|yaml/.test(type)) return 'text';
  return 'other';
}

export function toView(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    url: `/api/chat/attachments/${row.id}`,
    downloadUrl: `/api/chat/attachments/${row.id}?download=1`,
    messageId: row.message_id,
    createdAt: row.created_at,
  };
}

export function getRow(id: string): AttachmentRow | null {
  const row = db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(String(id || '')) as AttachmentRow | undefined;
  return row || null;
}

export function absolutePath(row: AttachmentRow): string {
  return path.isAbsolute(row.path) ? row.path : path.join(DATA_DIR, row.path);
}

/** 업로드 파일을 data/uploads/ 에 저장하고 DB에 메타데이터를 남긴다. */
export function saveUpload(input: { sessionId: string; filename: string; mime: string; data: Buffer }): AttachmentView {
  const data = input.data;
  if (!data || !data.length) throw new Error('빈 파일은 올릴 수 없습니다.');
  if (data.length > MAX_FILE_BYTES) {
    throw new Error(`파일이 너무 큽니다(최대 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB).`);
  }
  const filename = sanitizeFilename(input.filename);
  const kind = classify(filename, input.mime);
  const id = crypto.randomUUID();
  const ext = extOf(filename);
  const now = new Date();
  const folder = path.join('uploads', `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`);
  const dir = path.join(DATA_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join(folder, `${id}${ext ? `.${ext}` : ''}`);
  const abs = path.join(DATA_DIR, rel);
  fs.writeFileSync(abs, data, { mode: 0o600 });
  const mime = String(input.mime || '').trim() || guessMime(filename);
  db.prepare(
    'INSERT INTO chat_attachments(id, session_id, message_id, filename, mime, size, kind, path, created_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id, input.sessionId || 'default', null, filename, mime, data.length, kind, rel, now.toISOString());
  addLog('info', `첨부 파일 저장 · ${filename} (${(data.length / 1024).toFixed(0)}KB)`);
  return toView(getRow(id) as AttachmentRow);
}

export function guessMime(filename: string): string {
  const ext = extOf(filename);
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'json') return 'application/json';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (TEXT_EXT.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

/** 메시지 id들에 연결된 첨부를 묶어서 준다(대화 불러오기용). */
export function attachToMessage(ids: string[], messageId: number, sessionId: string): AttachmentView[] {
  const out: AttachmentView[] = [];
  for (const id of ids.slice(0, MAX_FILES_PER_MESSAGE)) {
    const row = getRow(id);
    // 다른 세션의 파일을 붙이지 못하게 세션도 확인한다.
    if (!row || (row.session_id !== sessionId && row.message_id)) continue;
    db.prepare('UPDATE chat_attachments SET message_id = ?, session_id = ? WHERE id = ?').run(messageId, sessionId, row.id);
    out.push(toView(getRow(row.id) as AttachmentRow));
  }
  return out;
}

export function listForMessage(messageId: number): AttachmentView[] {
  const rows = db
    .prepare('SELECT * FROM chat_attachments WHERE message_id = ? ORDER BY created_at ASC')
    .all(messageId) as AttachmentRow[];
  return rows.map(toView);
}

/** 여러 메시지의 첨부를 한 번에(대화 목록 렌더링용) */
export function listForMessages(messageIds: number[]): Record<number, AttachmentView[]> {
  const result: Record<number, AttachmentView[]> = {};
  if (!messageIds.length) return result;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM chat_attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...messageIds) as AttachmentRow[];
  for (const row of rows) {
    if (row.message_id === null) continue;
    (result[row.message_id] ||= []).push(toView(row));
  }
  return result;
}

/** 첨부 파일이 남아 있는 메시지 id 목록(최근 것부터) */
export function recentImageMessageIds(limit = 2): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT message_id FROM chat_attachments
        WHERE kind = 'image' AND message_id IS NOT NULL
        ORDER BY message_id DESC LIMIT ?`
    )
    .all(limit) as { message_id: number }[];
  return rows.map((r) => r.message_id);
}

/* ------------------------------------------------------------------ */
/* 파일 내용 읽기                                                       */
/* ------------------------------------------------------------------ */

/** 텍스트 계열 파일의 앞부분(최대 MAX_TEXT_CHARS 자) */
export function readTextContent(row: AttachmentRow, maxChars = MAX_TEXT_CHARS): string | null {
  if (row.kind === 'image') return null;
  try {
    const abs = absolutePath(row);
    const stat = fs.statSync(abs);
    // 텍스트 파일은 앞부분만 읽는다(큰 로그 파일 보호).
    const limit = Math.min(stat.size, Math.max(maxChars * 4, 64 * 1024));
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(limit);
    const read = fs.readSync(fd, buf, 0, limit, 0);
    fs.closeSync(fd);
    const slice = buf.subarray(0, read);
    if (row.kind === 'pdf' || slice.subarray(0, 5).toString('latin1') === '%PDF-') {
      const extracted = extractPdfText(slice);
      return extracted ? extracted.slice(0, maxChars) : null;
    }
    // 이진 파일이면 글자가 거의 없으므로 걸러 낸다.
    const text = slice.toString('utf8');
    const printable = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, '');
    if (printable.length < text.length * 0.6) return null;
    return text.slice(0, maxChars);
  } catch {
    return null;
  }
}

/**
 * PDF 텍스트 최소 추출 — FlateDecode 스트림을 풀어 (…)Tj / […]TJ 문자열만 모은다.
 * 완벽하지 않으므로 실패하면 null(호출부가 파일 정보로 대체).
 */
function extractPdfText(buf: Buffer): string | null {
  try {
    const raw = buf.toString('latin1');
    const chunks: string[] = [];
    const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
    let match: RegExpExecArray | null;
    while ((match = streamRe.exec(raw)) && chunks.join('').length < 60_000) {
      const body = Buffer.from(match[1], 'latin1');
      let text = '';
      try {
        text = zlib.inflateSync(body).toString('latin1');
      } catch {
        continue; // 압축이 아니거나 다른 필터
      }
      for (const part of text.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
        const literal = part[0].slice(1, -1).replace(/\\([nrt()\\])/g, (_m, c: string) => {
          if (c === 'n') return '\n';
          if (c === 'r') return '\r';
          if (c === 't') return '\t';
          return c;
        });
        chunks.push(literal);
      }
      if (chunks.length) chunks.push('\n');
    }
    const text = chunks.join('').replace(/[ \t]{2,}/g, ' ').trim();
    return text.length > 20 ? text : null;
  } catch {
    return null;
  }
}

/** 이미지 1장을 AI에 넘길 base64로 (너무 크면 null) */
export function inlineImage(row: AttachmentRow): InlineImage | null {
  if (row.kind !== 'image') return null;
  if (row.size > MAX_INLINE_IMAGE_BYTES) return null;
  try {
    const data = fs.readFileSync(absolutePath(row));
    return { mime: row.mime || guessMime(row.filename), dataBase64: data.toString('base64') };
  } catch {
    return null;
  }
}

export interface PromptAttachmentBlock {
  /** 프롬프트에 붙일 텍스트 블록 */
  text: string;
  /** 멀티모달로 넘길 이미지 */
  images: InlineImage[];
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 첨부들을 AI 프롬프트용으로 바꾼다.
 * - 텍스트/PDF: 본문(앞부분)을 붙인다.
 * - 이미지: inlineData로 넘기고, 위치 설명만 텍스트로 남긴다.
 * - 그 밖: 파일 정보와 저장 경로. (필요하면 attachment_read 도구로 다시 읽게 한다)
 */
export function buildPromptBlock(
  ids: string[],
  options: { images?: boolean; maxChars?: number } = {}
): PromptAttachmentBlock {
  const images: InlineImage[] = [];
  const lines: string[] = [];
  const wantImages = options.images !== false;
  const maxChars = Math.max(400, Math.min(MAX_TEXT_CHARS, Number(options.maxChars) || MAX_TEXT_CHARS));
  for (const id of ids.slice(0, MAX_FILES_PER_MESSAGE)) {
    const row = getRow(id);
    if (!row) continue;
    const header = `- ${row.filename} (${row.kind}, ${humanSize(row.size)})`;
    if (row.kind === 'image') {
      const image = wantImages && images.length < MAX_INLINE_IMAGES ? inlineImage(row) : null;
      if (image) {
        images.push(image);
        lines.push(`${header} — 사진 ${images.length}번째 (직접 보고 답할 수 있다)`);
      } else {
        lines.push(`${header} — 사진이 너무 커서 함께 보낼 수 없다. 필요하면 attachment_read로 경로를 확인해 사용자에게 안내한다.`);
      }
      continue;
    }
    const content = readTextContent(row, maxChars);
    if (content) {
      lines.push(`${header} — 내용:`);
      lines.push('<file>');
      lines.push(content);
      lines.push('</file>');
      if (row.kind === 'pdf') {
        lines.push(`(PDF에서 추출한 텍스트 · 파일 ${humanSize(row.size)} · 저장 경로 data/${row.path})`);
      } else if (content.length >= maxChars || row.size > content.length + 16) {
        lines.push(`(앞부분만 표시 · 전체 ${humanSize(row.size)} · 저장 경로 data/${row.path})`);
      }
    } else {
      lines.push(
        `${header} — 내용을 자동으로 읽지 못했다. 파일은 서버에 저장돼 있다(경로 data/${row.path}). 사용자가 물으면 이 사실을 알리고, 텍스트로 붙여 주면 읽을 수 있다고 안내한다.`
      );
    }
  }
  return { text: lines.join('\n'), images };
}

/** 오래된 첨부 파일 정리(30일). DB 행은 남기고 파일만 지운다. */
export function cleanupOldFiles(days = 30): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare('SELECT * FROM chat_attachments WHERE created_at < ?').all(cutoff) as AttachmentRow[];
  let removed = 0;
  for (const row of rows) {
    try {
      fs.rmSync(absolutePath(row), { force: true });
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}
