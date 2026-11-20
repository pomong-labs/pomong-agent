import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { addLog, getJson, setJson } from './db';
import { decrypt, encrypt, serverKey } from './crypto';

/**
 * v0.6.3 — 이메일(네이버·지메일) IMAP/SMTP 직접 연동
 *
 * 앱 비밀번호만 있으면 별도 OAuth 없이 메일함을 읽고 보낼 수 있다.
 * - 계정 정보와 앱 비밀번호는 **서버 키로 암호화**해 data/settings 에 보관한다.
 * - AI 도구(mail_list·mail_read·mail_search·mail_send)는 아래 함수들을 쓴다.
 * - 발송은 바로 하지 않는다: 초안(draft)을 만들어 채팅에 확인 카드를 띄우고,
 *   사용자가 카드에서 "보내기"를 눌렀을 때만 나간다.
 */

export type MailProvider = 'naver' | 'gmail' | 'custom';

export interface MailPreset {
  label: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  help: string;
}

export const MAIL_PRESETS: Record<Exclude<MailProvider, 'custom'>, MailPreset> = {
  naver: {
    label: '네이버 메일',
    imap: { host: 'imap.naver.com', port: 993, secure: true },
    smtp: { host: 'smtp.naver.com', port: 465, secure: true },
    help: '네이버 메일 > 환경설정 > POP3/IMAP 설정에서 "IMAP/SMTP 사용함"으로 바꾸고, 2단계 인증을 켠 뒤 앱 비밀번호를 발급해 주세요.',
  },
  gmail: {
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    help: 'Google 계정 > 보안 > 2단계 인증을 켠 뒤 "앱 비밀번호"를 만들어 주세요(일반 비밀번호로는 IMAP 로그인이 막혀요).',
  },
};

interface MailAccountRow {
  id: string;
  provider: MailProvider;
  email: string;
  /** 앱 비밀번호(암호화) */
  secretEnc: string;
  senderName: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  createdAt: string;
  lastTestAt: string | null;
  lastError: string | null;
}

export interface MailAccountView {
  id: string;
  provider: MailProvider;
  label: string;
  email: string;
  senderName: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  createdAt: string;
  lastTestAt: string | null;
  lastError: string | null;
}

const STORAGE_KEY = 'mail.accounts';
const DRAFT_KEY = 'mail.drafts';

function readRows(): MailAccountRow[] {
  const raw = getJson<unknown>(STORAGE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is MailAccountRow => Boolean(row && typeof row === 'object' && (row as MailAccountRow).id));
}

function writeRows(rows: MailAccountRow[]): void {
  setJson(STORAGE_KEY, rows);
}

function presetOf(provider: MailProvider): MailPreset | null {
  return provider === 'custom' ? null : MAIL_PRESETS[provider];
}

function toView(row: MailAccountRow): MailAccountView {
  const preset = presetOf(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    label: preset?.label || '직접 설정',
    email: row.email,
    senderName: row.senderName,
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    createdAt: row.createdAt,
    lastTestAt: row.lastTestAt,
    lastError: row.lastError,
  };
}

export function mailPresets(): (MailPreset & { id: string })[] {
  return Object.entries(MAIL_PRESETS).map(([id, preset]) => ({ id, ...preset }));
}

export function listAccounts(): MailAccountView[] {
  return readRows().map(toView);
}

export function hasAccounts(): boolean {
  return readRows().length > 0;
}

function findRow(id?: string): MailAccountRow | null {
  const rows = readRows();
  if (!rows.length) return null;
  if (id) return rows.find((r) => r.id === id) || null;
  return rows[0];
}

/** 비밀번호·발신자 이름 등록 전에 쓰는 연결 입력 */
export interface MailAccountInput {
  id?: string;
  provider?: MailProvider;
  email?: string;
  secret?: string;
  senderName?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

function buildConnection(input: MailAccountInput): {
  provider: MailProvider;
  email: string;
  secret: string;
  senderName: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
} {
  const provider = (input.provider || 'naver') as MailProvider;
  const email = String(input.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('이메일 주소를 확인해 주세요.');
  const secret = String(input.secret || '').replace(/\s+/g, '');
  if (!secret) throw new Error('앱 비밀번호를 입력해 주세요.');
  const preset = presetOf(provider);
  const imapHost = String(input.imapHost || preset?.imap.host || '').trim();
  const smtpHost = String(input.smtpHost || preset?.smtp.host || '').trim();
  if (!imapHost || !smtpHost) throw new Error('IMAP/SMTP 서버 주소를 입력해 주세요.');
  const label = preset?.label || email.split('@')[1] || '메일';
  return {
    provider,
    email,
    secret,
    senderName: String(input.senderName || '').trim().slice(0, 40) || label,
    imapHost,
    imapPort: Number(input.imapPort) || preset?.imap.port || 993,
    smtpHost,
    smtpPort: Number(input.smtpPort) || preset?.smtp.port || 465,
  };
}

/* ------------------------------------------------------------------ */
/* IMAP 공통                                                            */
/* ------------------------------------------------------------------ */

const CONNECT_TIMEOUT_MS = 12_000;

function imapClient(row: Pick<MailAccountRow, 'email' | 'secretEnc' | 'imapHost' | 'imapPort'>): ImapFlow {
  const secret = decrypt(row.secretEnc, serverKey());
  return new ImapFlow({
    host: row.imapHost,
    port: row.imapPort,
    secure: true,
    auth: { user: row.email, pass: secret },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 45_000,
  });
}

async function withImap<T>(
  row: Pick<MailAccountRow, 'email' | 'secretEnc' | 'imapHost' | 'imapPort'>,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = imapClient(row);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** 연결 시험: IMAP 로그인 + SMTP 인증 둘 다 확인한다. */
export async function testConnection(input: MailAccountInput): Promise<{ ok: boolean; message: string }> {
  let conn: ReturnType<typeof buildConnection>;
  try {
    conn = buildConnection(input);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const fakeRow = {
    email: conn.email,
    secretEnc: encrypt(conn.secret, serverKey()),
    imapHost: conn.imapHost,
    imapPort: conn.imapPort,
  };
  try {
    await withImap(fakeRow, async (client) => {
      await client.mailboxOpen('INBOX');
    });
  } catch (err) {
    return { ok: false, message: `IMAP 접속 실패: ${friendlyError(err)}` };
  }
  try {
    const transport = nodemailer.createTransport({
      host: conn.smtpHost,
      port: conn.smtpPort,
      secure: conn.smtpPort === 465,
      auth: { user: conn.email, pass: conn.secret },
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: 30_000,
    });
    await transport.verify();
    transport.close();
  } catch (err) {
    return { ok: false, message: `SMTP 접속 실패: ${friendlyError(err)}` };
  }
  return { ok: true, message: `${conn.email} 메일함과 발송 서버에 연결됐어요.` };
}

function friendlyError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|535|534/i.test(text)) {
    return '로그인이 거부됐어요. 앱 비밀번호가 맞는지, IMAP/SMTP 사용이 켜져 있는지 확인해 주세요.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return '서버 주소를 찾지 못했어요. 인터넷 연결을 확인해 주세요.';
  if (/ETIMEDOUT|timeout|Timeout/i.test(text)) return '서버 응답이 없어요. 잠시 뒤 다시 시도해 주세요.';
  if (/self.signed|CERT/i.test(text)) return '보안 인증서 확인에 실패했어요.';
  return text.slice(0, 200);
}

/** 계정 저장(연결 시험 통과 후). 같은 주소가 있으면 앱 비밀번호만 갱신한다. */
export async function saveAccount(input: MailAccountInput): Promise<MailAccountView> {
  const conn = buildConnection(input);
  const test = await testConnection(input);
  if (!test.ok) throw new Error(test.message);
  const rows = readRows();
  const now = new Date().toISOString();
  const existing = rows.find((r) => r.email.toLowerCase() === conn.email.toLowerCase());
  const row: MailAccountRow = {
    id: input.id || existing?.id || crypto.randomUUID(),
    provider: conn.provider,
    email: conn.email,
    secretEnc: encrypt(conn.secret, serverKey()),
    senderName: conn.senderName,
    imapHost: conn.imapHost,
    imapPort: conn.imapPort,
    smtpHost: conn.smtpHost,
    smtpPort: conn.smtpPort,
    createdAt: existing?.createdAt || now,
    lastTestAt: now,
    lastError: null,
  };
  const next = existing ? rows.map((r) => (r.id === existing.id ? row : r)) : [...rows, row];
  writeRows(next);
  addLog('success', `메일 계정을 연결했습니다 · ${conn.email}`);
  return toView(row);
}

export function removeAccount(id: string): boolean {
  const rows = readRows();
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) return false;
  writeRows(next);
  addLog('info', '메일 계정 연결을 해제했습니다');
  return true;
}

function accountOrThrow(id?: string): MailAccountRow {
  const row = findRow(id);
  if (!row) throw new Error('먼저 설정에서 메일 계정을 연결해 주세요.');
  return row;
}

/* ------------------------------------------------------------------ */
/* 메일 읽기                                                            */
/* ------------------------------------------------------------------ */

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  fromName: string;
  date: string;
  seen: boolean;
  size: number;
  preview: string;
}

export interface MailMessage extends MailSummary {
  to: string[];
  cc: string[];
  messageId: string;
  text: string;
  html: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

/** RFC 2047 인코딩(=?UTF-8?B?..?=) 풀기 */
export function decodeMimeWords(value: string): string {
  if (!value) return '';
  return value
    .replace(/\r?\n[ \t]+/g, ' ')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, enc: string, data: string) => {
      try {
        let buf: Buffer;
        if (enc.toUpperCase() === 'B') buf = Buffer.from(data, 'base64');
        else {
          const bytes: number[] = [];
          const text = data.replace(/_/g, ' ');
          for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
              bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
              i += 2;
            } else bytes.push(ch.charCodeAt(0));
          }
          buf = Buffer.from(bytes);
        }
        return decodeCharset(buf, charset);
      } catch {
        return data;
      }
    });
}

/** charset 버퍼 → 문자열(Node의 TextDecoder가 UTF-8·EUC-KR 등을 처리, 외부 의존성 없음) */
export function decodeCharset(buf: Buffer, charset: string): string {
  const name = (charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (name === 'utf-8' || name === 'utf8' || name === 'us-ascii' || name === 'ascii') return buf.toString('utf8');
  try {
    return new TextDecoder(name).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** quoted-printable 풀기 */
export function decodeQuotedPrintable(input: string): string {
  const text = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = ch.charCodeAt(0);
      if (code < 256) bytes.push(code);
      else bytes.push(...Buffer.from(ch, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('latin1');
}

/** HTML 메일을 글자만 남긴다(스크립트·스타일 제거). */
export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

interface ParsedEntity {
  headers: Record<string, string>;
  text: string;
  html: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = recoverUtf8(line.slice(idx + 1).trim());
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * 헤더를 latin1 문자열로 읽었을 때, 인코딩 워드 없이 UTF-8 바이트가 그대로 들어온 경우를 되살린다.
 * (EUC-KR 같은 다른 charset은 =?...?= 인코딩 워드로 오므로 여기서는 건드리지 않는다)
 */
function recoverUtf8(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? value : decoded;
}

/** 헤더 블록과 본문을 나눈다(바이트 보존을 위해 latin1 문자열로 다룬다). */
function splitEntity(raw: string): { head: string; body: string } {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return { head: raw, body: '' };
  return { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

function toBytes(body: string, encoding: string): Buffer {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return Buffer.from(decodeQuotedPrintable(body), 'latin1');
  return Buffer.from(body, 'latin1');
}

/** MIME 엔티티 하나를 해석한다(멀티파트는 재귀). */
function parseEntity(raw: string, depth = 0): ParsedEntity {
  const { head, body } = splitEntity(raw);
  const headers = parseHeaders(head);
  const contentType = headers['content-type'] || 'text/plain; charset=utf-8';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const encoding = (headers['content-transfer-encoding'] || '').trim();
  const result: ParsedEntity = { headers, text: '', html: '', attachments: [] };

  if (mime.startsWith('multipart/') && depth < 5) {
    const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
    const boundary = boundaryMatch?.[1];
    if (boundary) {
      const parts = raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      for (const part of parts) {
        const trimmed = part.replace(/^\r?\n/, '');
        if (!trimmed.trim() || /^--\s*$/.test(trimmed.trim())) continue;
        const child = parseEntity(trimmed, depth + 1);
        if (child.text && !result.text) result.text = child.text;
        if (child.html && !result.html) result.html = child.html;
        result.attachments.push(...child.attachments);
      }
      return result;
    }
  }

  if (mime === 'text/plain' || mime === 'text/html') {
    const charsetMatch = contentType.match(/charset="?([^";]+)"?/i);
    const charset = charsetMatch?.[1] || 'utf-8';
    const decoded = decodeCharset(toBytes(body, encoding), charset);
    if (mime === 'text/html') result.html = decoded;
    else result.text = decoded;
    return result;
  }

  const disposition = headers['content-disposition'] || '';
  const nameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i) || contentType.match(/name="?([^";]+)"?/i);
  result.attachments.push({
    filename: nameMatch ? decodeMimeWords(decodeURIComponent(nameMatch[1])) : '(이름 없음)',
    contentType: mime,
    size: toBytes(body, encoding).length,
  });
  return result;
}

/** IMAP이 준 원문(Buffer)을 읽기 좋은 메일로 바꾼다. */
export function parseRawMessage(raw: Buffer): Omit<MailMessage, 'uid' | 'seen' | 'size'> {
  const entity = parseEntity(raw.toString('latin1'));
  const h = entity.headers;
  const addresses = (value: string) =>
    decodeMimeWords(value)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  const subject = decodeMimeWords(h.subject || '(제목 없음)');
  const fromRaw = decodeMimeWords(h.from || '');
  const fromMatch = fromRaw.match(/^(.*?)<([^>]+)>/);
  const fromName = (fromMatch?.[1] || '').trim().replace(/^"|"$/g, '');
  const fromAddress = (fromMatch?.[2] || fromRaw).trim();
  const text = entity.text?.trim() ? entity.text : entity.html ? htmlToText(entity.html) : '';
  return {
    subject,
    from: fromAddress,
    fromName: fromName || fromAddress.split('@')[0] || '',
    date: h.date ? new Date(h.date).toISOString() : new Date().toISOString(),
    to: addresses(h.to || ''),
    cc: addresses(h.cc || ''),
    messageId: h['message-id'] || '',
    text: text.slice(0, 20_000),
    html: entity.html || '',
    attachments: entity.attachments,
    preview: '',
  };
}

function envelopeSummary(message: {
  uid: number;
  envelope?: { subject?: string; from?: { name?: string; address?: string }[]; date?: Date };
  flags?: Set<string>;
  size?: number;
}): MailSummary {
  const from = message.envelope?.from?.[0];
  return {
    uid: message.uid,
    subject: decodeMimeWords(message.envelope?.subject || '(제목 없음)'),
    from: from?.address || '',
    fromName: decodeMimeWords(from?.name || from?.address || ''),
    date: (message.envelope?.date ? new Date(message.envelope.date) : new Date()).toISOString(),
    seen: Boolean(message.flags?.has('\\Seen')),
    size: message.size || 0,
    preview: '',
  };
}

/** 최근 메일 목록(기본 10통) */
export async function listMessages(
  options: { accountId?: string; unreadOnly?: boolean; limit?: number } = {}
): Promise<{ account: string; messages: MailSummary[]; total: number }> {
  const row = accountOrThrow(options.accountId);
  const limit = Math.max(1, Math.min(30, Number(options.limit) || 10));
  const messages = await withImap(row, async (client) => {
    const out: MailSummary[] = [];
    for await (const message of client.fetch(
      '1:*',
      { uid: true, envelope: true, flags: true, size: true },
      { uid: false }
    )) {
      const summary = envelopeSummary(message as never);
      if (options.unreadOnly && summary.seen) continue;
      out.push(summary);
    }
    return out;
  });
  const sorted = messages.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { account: row.email, messages: sorted.slice(0, limit), total: sorted.length };
}

/** 메일 한 통 읽기(uid 기준) */
export async function readMessage(uid: number, accountId?: string): Promise<MailMessage & { account: string }> {
  const row = accountOrThrow(accountId);
  const num = Number(uid);
  if (!Number.isFinite(num) || num <= 0) throw new Error('읽을 메일 번호(uid)가 올바르지 않습니다.');
  const found = await withImap(row, async (client) => {
    await client.mailboxOpen('INBOX');
    const message = await client.fetchOne(String(num), { uid: true, source: true, flags: true, size: true, envelope: true }, { uid: true });
    if (!message) return null;
    const parsed = parseRawMessage((message as { source?: Buffer }).source || Buffer.alloc(0));
    const summary = envelopeSummary(message as never);
    return {
      ...parsed,
      uid: num,
      seen: summary.seen,
      size: summary.size,
      preview: (parsed.text || '').slice(0, 120).replace(/\s+/g, ' '),
    };
  });
  if (!found) throw new Error('그 번호의 메일을 찾지 못했습니다. 목록을 다시 확인해 주세요.');
  return { ...found, account: row.email };
}

/** 제목·보낸사람·본문에서 검색 */
export async function searchMessages(
  query: string,
  options: { accountId?: string; limit?: number } = {}
): Promise<{ account: string; query: string; messages: MailSummary[] }> {
  const row = accountOrThrow(options.accountId);
  const q = String(query || '').trim();
  if (!q) throw new Error('검색어를 입력해 주세요.');
  const limit = Math.max(1, Math.min(30, Number(options.limit) || 10));
  const messages = await withImap(row, async (client) => {
    const uids = await client.search(
      { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] },
      { uid: true }
    );
    const list = (uids || []).slice(-200);
    if (!list.length) return [];
    const out: MailSummary[] = [];
    for await (const message of client.fetch(
      list.join(','),
      { uid: true, envelope: true, flags: true, size: true },
      { uid: true }
    )) {
      out.push(envelopeSummary(message as never));
    }
    return out;
  });
  const sorted = messages.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { account: row.email, query: q, messages: sorted.slice(0, limit) };
}

/* ------------------------------------------------------------------ */
/* 메일 보내기(초안 → 사용자 확인 → 발송)                                 */
/* ------------------------------------------------------------------ */

export interface MailDraft {
  id: string;
  accountId: string;
  accountEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  createdAt: string;
  /** 초안을 만든 채팅방 */
  session: string | null;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  sentAt?: string | null;
  error?: string | null;
}

function readDrafts(): Record<string, MailDraft> {
  const raw = getJson<Record<string, MailDraft>>(DRAFT_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function writeDrafts(drafts: Record<string, MailDraft>): void {
  // 24시간 지난 초안은 정리한다.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const kept: Record<string, MailDraft> = {};
  for (const [id, draft] of Object.entries(drafts)) {
    if (new Date(draft.createdAt).getTime() >= cutoff) kept[id] = draft;
  }
  setJson(DRAFT_KEY, kept);
}

function splitAddresses(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
  const out: string[] = [];
  for (const item of list) {
    const addr = String(item || '').trim().replace(/^.*<([^>]+)>$/, '$1');
    if (!addr) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw new Error(`이메일 주소가 올바르지 않습니다: ${addr}`);
    if (!out.includes(addr)) out.push(addr);
  }
  return out;
}

/** 발송 전에 확인 카드로 띄울 초안을 만든다(실제로 보내지 않는다). */
export function createDraft(input: {
  to: unknown;
  subject?: unknown;
  text?: unknown;
  cc?: unknown;
  accountId?: string;
  session?: string | null;
}): MailDraft {
  const row = accountOrThrow(input.accountId);
  const to = splitAddresses(input.to);
  if (!to.length) throw new Error('받는 사람 주소를 입력해 주세요.');
  const subject = String(input.subject || '').trim().slice(0, 200);
  if (!subject) throw new Error('메일 제목을 입력해 주세요.');
  const text = String(input.text || '').trim();
  if (!text) throw new Error('메일 본문을 입력해 주세요.');
  const draft: MailDraft = {
    id: crypto.randomUUID(),
    accountId: row.id,
    accountEmail: row.email,
    to,
    cc: splitAddresses(input.cc),
    subject,
    text: text.slice(0, 20_000),
    createdAt: new Date().toISOString(),
    session: input.session || null,
    status: 'pending',
  };
  const drafts = readDrafts();
  drafts[draft.id] = draft;
  writeDrafts(drafts);
  addLog('info', `메일 초안을 만들었습니다 · ${to.join(', ')}`);
  return draft;
}

export function getDraft(id: string): MailDraft | null {
  return readDrafts()[id] || null;
}

export function cancelDraft(id: string): boolean {
  const drafts = readDrafts();
  const draft = drafts[id];
  if (!draft) return false;
  draft.status = 'cancelled';
  writeDrafts(drafts);
  return true;
}

export function pendingDraftForSession(session: string): MailDraft | null {
  const drafts = Object.values(readDrafts())
    .filter((d) => d.session === session && d.status === 'pending')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return drafts[0] || null;
}

/** 사용자가 카드에서 확인한 뒤에만 실제로 보낸다. */
export async function sendDraft(id: string): Promise<MailDraft> {
  const drafts = readDrafts();
  const draft = drafts[id];
  if (!draft) throw new Error('메일 초안을 찾지 못했습니다. 다시 작성해 주세요.');
  if (draft.status !== 'pending') throw new Error('이미 처리된 메일입니다.');
  const row = findRow(draft.accountId);
  if (!row) throw new Error('메일 계정 연결이 해제됐습니다.');
  try {
    const transport = nodemailer.createTransport({
      host: row.smtpHost,
      port: row.smtpPort,
      secure: row.smtpPort === 465,
      auth: { user: row.email, pass: decrypt(row.secretEnc, serverKey()) },
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: 30_000,
    });
    const from = row.senderName ? `"${row.senderName.replace(/"/g, '')}" <${row.email}>` : row.email;
    await transport.sendMail({
      from,
      to: draft.to.join(', '),
      cc: draft.cc.length ? draft.cc.join(', ') : undefined,
      subject: draft.subject,
      text: draft.text,
    });
    transport.close();
    draft.status = 'sent';
    draft.sentAt = new Date().toISOString();
    draft.error = null;
    addLog('success', `메일을 보냈습니다 · ${draft.to.join(', ')}`);
  } catch (err) {
    draft.status = 'failed';
    draft.error = friendlyError(err);
    writeDrafts(drafts);
    throw new Error(draft.error);
  }
  writeDrafts(drafts);
  return draft;
}

/** 계정 설정 화면에 보여줄 남은 상태(연결 여부만) */
export function mailStatus(): { accounts: MailAccountView[]; presets: (MailPreset & { id: string })[] } {
  return { accounts: listAccounts(), presets: mailPresets() };
}
