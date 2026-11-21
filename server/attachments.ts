import crypto from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from './config';
import { addLog, db } from './db';

/**
 * 채팅 첨부(사진·파일) — v0.5.2 / 파일 내용 분석 보강 v0.6.5
 *
 * - 파일은 data/uploads/ 아래에만 저장한다(배포해도 보존).
 * - 이미지는 AI에게 멀티모달 파트(inlineData / image_url / base64)로 그대로 넘긴다.
 * - 텍스트·코드·CSV·JSON·MD는 내용을 읽어 프롬프트에 붙이고(길면 앞부분),
 * - PDF는 서버에서 본문 텍스트를 뽑아(poppler `pdftotext` → 내장 추출기 순서) 캐시한다.
 *   글자를 뽑지 못한 스캔본은 Gemini·Claude에 PDF 원본(application/pdf)을 함께 보낸다.
 * - 대화 기록에는 메타데이터(파일명·크기·종류·주소)만 남고 파일 본문은 남기지 않는다.
 */

export type AttachmentKind = 'image' | 'text' | 'pdf' | 'audio' | 'other';

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
export const MAX_FILES_PER_MESSAGE = 6;
/** 한 번의 프롬프트에 넣는 이미지는 최대 4장(서버 메모리 보호) */
const MAX_INLINE_IMAGES = 4;
/** 이미지 1장 인라인 상한(base64 전 원본 바이트) */
const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;
/** 텍스트 파일에서 프롬프트에 넣는 최대 글자 수 */
const MAX_TEXT_CHARS = 12_000;
/** PDF에서 뽑아 두는 본문 최대 글자 수(캐시) */
const MAX_PDF_CHARS = 40_000;
/** PDF 원본을 통째로 모델에 보낼 때의 상한(스캔본 대응) */
const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024;
/** pdftotext 한 번에 걸어 두는 시간 */
const PDFTOTEXT_TIMEOUT_MS = 25_000;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif']);
/** v0.6.18: 음성 메모·녹음 파일 — Gemini가 직접 듣고 받아쓰기·요약한다 */
const AUDIO_EXT = new Set(['m4a', 'mp3', 'wav', 'ogg', 'oga', 'webm', 'aac', 'flac', 'amr', 'caf']);
/** 오디오 1개 인라인 상한(base64 전 원본 바이트) */
const MAX_INLINE_AUDIO_BYTES = 12 * 1024 * 1024;
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
  /** v0.6.5: PDF에서 뽑아 둔 본문(NUL이면 미추출, ''면 글자 없음) */
  text_content?: string | null;
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
  // v0.6.18: .webm은 영상에도 쓰지만 채팅에서는 녹음 파일로 다룬다.
  if (type.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio';
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
  const saved = getRow(id) as AttachmentRow;
  // v0.6.5: PDF는 본문을 미리 뽑아 두어 다음 턴에서 바로 읽게 한다.
  if (saved.kind === 'pdf') warmPdfText(saved);
  return toView(saved);
}

export function guessMime(filename: string): string {
  const ext = extOf(filename);
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'amr') return 'audio/amr';
  if (ext === 'caf') return 'audio/x-caf';
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

/** 텍스트 계열 파일의 앞부분(최대 maxChars 자) — PDF는 추출해 둔 본문을 쓴다 */
export function readTextContent(row: AttachmentRow, maxChars = MAX_TEXT_CHARS): string | null {
  if (row.kind === 'image') return null;
  // v0.6.5: PDF는 한 번 뽑아 둔 본문을 먼저 쓴다(없으면 지금 뽑아서 저장).
  if (row.kind === 'pdf') {
    const text = pdfText(row);
    return text ? text.slice(0, maxChars) : null;
  }
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
    if (slice.subarray(0, 5).toString('latin1') === '%PDF-') {
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

/* ------------------------------------------------------------------ */
/* v0.6.5: PDF 본문 추출                                               */
/* 서버 이미지(poppler-utils)의 pdftotext 를 먼저 쓰고, 없으면 내장 추출기. */
/* 뽑은 본문은 DB(chat_attachments.text_content)에 캐시해 매 턴 다시 뽑지 않는다. */
/* ------------------------------------------------------------------ */

function normalizePdfText(raw: string): string {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\f/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 외부 도구 없이 쓰는 내장 추출기(내용이 없으면 null) */
function builtinPdfText(abs: string): string | null {
  try {
    const text = extractPdfText(fs.readFileSync(abs));
    return text ? normalizePdfText(text) : null;
  } catch {
    return null;
  }
}

/** poppler pdftotext → 내장 추출기 순서로 PDF 본문을 뽑는다. */
function extractPdfFromFile(abs: string): string | null {
  try {
    const res = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', abs, '-'], {
      timeout: PDFTOTEXT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    if (!res.error && res.status === 0 && typeof res.stdout === 'string') {
      const text = normalizePdfText(res.stdout);
      if (text.length > 0) return text;
    }
  } catch {
    /* pdftotext가 없는 환경 → 내장 추출기로 */
  }
  return builtinPdfText(abs);
}

function savePdfText(id: string, text: string): void {
  try {
    db.prepare('UPDATE chat_attachments SET text_content = ? WHERE id = ?').run(text.slice(0, MAX_PDF_CHARS), id);
  } catch {
    /* 캐시 저장 실패는 답변을 막지 않는다 */
  }
}

/** PDF 본문(캐시 우선). 글자가 없는 스캔본이면 null. */
export function pdfText(row: AttachmentRow): string | null {
  const cached = row.text_content;
  if (cached !== undefined && cached !== null) return cached.length ? cached.slice(0, MAX_PDF_CHARS) : null;
  const text = extractPdfFromFile(absolutePath(row));
  const value = text || '';
  savePdfText(row.id, value);
  row.text_content = value;
  if (value) addLog('info', `PDF 본문 추출 · ${row.filename} (${value.length}자)`);
  return text;
}

/**
 * 업로드 직후 백그라운드로 본문을 뽑아 둔다.
 * (사용자가 바로 메시지를 보낸다면 pdfText 가 동기로 한 번 더 뽑는다 — 속도만을 위한 준비 단계)
 */
export function warmPdfText(row: AttachmentRow): void {
  if (row.kind !== 'pdf') return;
  if (row.text_content !== undefined && row.text_content !== null) return;
  const abs = absolutePath(row);
  execFile(
    'pdftotext',
    ['-layout', '-enc', 'UTF-8', abs, '-'],
    { timeout: PDFTOTEXT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    (err, stdout) => {
      const viaTool = !err && typeof stdout === 'string' ? normalizePdfText(stdout) : '';
      const value = viaTool || builtinPdfText(abs) || '';
      savePdfText(row.id, value);
      addLog(
        'info',
        value
          ? `PDF 본문 미리 추출 · ${row.filename} (${value.length}자)`
          : `PDF 본문 없음(스캔본) · ${row.filename} — 원본을 모델에 함께 보냅니다`
      );
    }
  );
}

/** PDF 원본을 base64로(스캔본을 볼 수 있는 모델에만, 크기 상한) */
export function inlinePdf(row: AttachmentRow): InlineImage | null {
  if (row.kind !== 'pdf') return null;
  if (row.size > MAX_INLINE_PDF_BYTES) return null;
  try {
    const data = fs.readFileSync(absolutePath(row));
    return { mime: 'application/pdf', dataBase64: data.toString('base64') };
  } catch {
    return null;
  }
}

/**
 * PDF 텍스트 최소 추출 — FlateDecode 스트림을 풀어 Tj/TJ 문자열만 모은다.
 * (…) 리터럴과 <hex> 문자열을 모두 본다. poppler(pdftotext)가 없는 환경의 폴백.
 * 완벽하지 않으므로 실패하면 null(호출부가 원본 PDF 전달로 대체).
 */
function decodeHexPdfString(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  if (!clean.length) return '';
  const buf = Buffer.from(clean.length % 2 ? `${clean}0` : clean, 'hex');
  // 대부분의 한글 PDF는 UTF-16BE 로 적어 둔다 — 짝수 바이트이고 상위 바이트가 0인 경우가 많다.
  if (buf.length % 2 === 0) {
    let printable = 0;
    const units: number[] = [];
    for (let i = 0; i < buf.length; i += 2) {
      const unit = (buf[i] << 8) | buf[i + 1];
      units.push(unit);
      if (unit === 0x20 || (unit >= 0x21 && unit <= 0x7e) || (unit >= 0xac00 && unit <= 0xd7a3) || (unit >= 0x3131 && unit <= 0x318e)) {
        printable += 1;
      }
    }
    if (units.length && printable / units.length > 0.85) {
      const swapped = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i += 2) {
        swapped[i] = buf[i + 1];
        swapped[i + 1] = buf[i];
      }
      return swapped.toString('utf16le');
    }
  }
  return buf.toString('latin1');
}

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
      for (const part of text.matchAll(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]{2,}>/g)) {
        const token = part[0];
        if (token.startsWith('<')) {
          const decoded = decodeHexPdfString(token.slice(1, -1));
          if (decoded) chunks.push(decoded);
          continue;
        }
        const literal = token.slice(1, -1).replace(/\\([nrt()\\])/g, (_m, c: string) => {
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

/** v0.6.18: 음성 파일 1개를 AI에 넘길 base64로 (너무 크면 null) */
export function inlineAudio(row: AttachmentRow): InlineImage | null {
  if (row.kind !== 'audio') return null;
  if (row.size > MAX_INLINE_AUDIO_BYTES) return null;
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
  /** v0.6.5: 글자를 뽑지 못한 스캔본 PDF 원본(볼 수 있는 모델에만 넘긴다) */
  documents: InlineImage[];
  /** v0.6.18: 음성 메모·녹음 파일(Gemini가 직접 듣는다) */
  audios: InlineImage[];
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 첨부들을 AI 프롬프트용으로 바꾼다.
 * - 텍스트: 본문(앞부분)을 붙인다.
 * - PDF: 뽑아 둔 본문을 붙이고, 글자가 없는 스캔본은 원본도 함께 넘긴다.
 * - 이미지: inlineData로 넘기고, 위치 설명만 텍스트로 남긴다.
 * - 그 밖: 파일 정보와 저장 경로. (필요하면 attachment_read 도구로 다시 읽게 한다)
 */
export function buildPromptBlock(
  ids: string[],
  options: { images?: boolean; pdfFiles?: boolean; audio?: boolean; maxChars?: number } = {}
): PromptAttachmentBlock {
  const images: InlineImage[] = [];
  const documents: InlineImage[] = [];
  const audios: InlineImage[] = [];
  const lines: string[] = [];
  const wantImages = options.images !== false;
  const wantPdfFiles = options.pdfFiles === true;
  const wantAudio = options.audio !== false;
  const maxChars = Math.max(400, Math.min(MAX_TEXT_CHARS, Number(options.maxChars) || MAX_TEXT_CHARS));
  for (const id of ids.slice(0, MAX_FILES_PER_MESSAGE)) {
    const row = getRow(id);
    if (!row) continue;
    const header = `- ${row.filename} (${row.kind}, ${humanSize(row.size)})`;
    if (row.kind === 'audio') {
      const audio = wantAudio && audios.length < 2 ? inlineAudio(row) : null;
      if (audio) {
        audios.push(audio);
        lines.push(
          `${header} — 음성 녹음 ${audios.length}번째를 함께 보냈다. 직접 듣고 받아쓰기와 핵심 요약을 할 수 있다. 요약한 뒤 할 일(D-Day·할 일)로 등록할 것이 보이면 사용자에게 먼저 알리고 tasks_add·dday_add로 등록한다.`
        );
      } else {
        lines.push(
          `${header} — 음성이 너무 크거나(12MB 초과) 형식을 읽지 못해 함께 보낼 수 없다. 파일은 서버에 저장되어 있다(data/${row.path}). 사용자에게 짧게 나눠 다시 올려 달라고 안내한다.`
        );
      }
      continue;
    }
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
        lines.push(`(PDF에서 추출한 본문 · 파일 ${humanSize(row.size)} · 저장 경로 data/${row.path})`);
        // 글자가 거의 없는 스캔본은 본문 대신(또는 함께) 원본을 넘길 수 있게 한다.
        const document = wantPdfFiles && content.replace(/\s/g, '').length < 400 && documents.length < 2 ? inlinePdf(row) : null;
        if (document) {
          documents.push(document);
          lines.push(`(본문 글자가 적어 PDF 원본 ${documents.length}번째도 함께 보냈다 — 페이지를 직접 보고 답할 수 있다)`);
        }
      } else if (content.length >= maxChars || row.size > content.length + 16) {
        lines.push(`(앞부분만 표시 · 전체 ${humanSize(row.size)} · 저장 경로 data/${row.path})`);
      }
    } else if (row.kind === 'pdf') {
      const document = wantPdfFiles && documents.length < 2 ? inlinePdf(row) : null;
      if (document) {
        documents.push(document);
        lines.push(`${header} — 글자가 없는 스캔본이라 PDF 원본 ${documents.length}번째를 함께 보냈다. 페이지를 직접 보고 답할 수 있다.`);
      } else {
        lines.push(
          `${header} — 스캔본(이미지) PDF라 본문 글자를 뽑지 못했고, 지금 모델에는 원본도 보낼 수 없다. 파일은 서버에 저장되어 있다(data/${row.path}). 사용자에게 한 장씩 사진으로 올려 달라고 안내하거나, 사진을 보는 모델(Gemini)로 바꾸자고 제안한다.`
        );
      }
    } else {
      lines.push(
        `${header} — 내용을 자동으로 읽지 못했다. 파일은 서버에 저장되어 있다(경로 data/${row.path}). 사용자가 물으면 이 사실을 알리고, 텍스트로 붙여 주면 읽을 수 있다고 안내한다.`
      );
    }
  }
  return { text: lines.join('\n'), images, documents, audios };
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
