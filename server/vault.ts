import crypto from 'node:crypto';
import { db, getSetting, setSetting, addLog } from './db';
import { decrypt, encrypt, maskEmail, maskSecret } from './crypto';

export type VaultType = 'apikey' | 'login' | 'memo';

export interface VaultItemRow {
  id: string;
  title: string;
  type: VaultType;
  username: string | null;
  secret_enc: string;
  notes: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface VaultItemView {
  id: string;
  title: string;
  type: VaultType;
  masked: string;
  usernameMasked: string | null;
  hint: string;
  notes: string;
  isDefault: boolean;
  updatedAt: string;
  lastUsedAt: string | null;
}

const AUTO_LOCK_MINUTES = 10;

let masterKey: Buffer | null = null;
let lastActivity = 0;

function deriveKey(pin: string, salt: Buffer): Buffer {
  return crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function vaultConfigured(): boolean {
  return Boolean(getSetting('vault.wrappedKey') && getSetting('vault.salt'));
}

export function vaultUnlocked(): boolean {
  if (!masterKey) return false;
  if (Date.now() - lastActivity > AUTO_LOCK_MINUTES * 60 * 1000) {
    masterKey = null;
    return false;
  }
  return true;
}

export function touchVault(): void {
  lastActivity = Date.now();
}

export function initVault(pin: string): void {
  if (vaultConfigured()) throw new Error('금고가 이미 설정되어 있습니다.');
  if (!/^\d{4,12}$/.test(pin)) throw new Error('PIN은 4~12자리 숫자로 정해 주세요.');
  const salt = crypto.randomBytes(16);
  const key = crypto.randomBytes(32);
  const kek = deriveKey(pin, salt);
  setSetting('vault.salt', salt.toString('base64'));
  setSetting('vault.wrappedKey', encrypt(key.toString('base64'), kek));
  masterKey = key;
  lastActivity = Date.now();
  addLog('success', '금고가 생성되었습니다');
}

export function unlockVault(pin: string): boolean {
  const salt = getSetting('vault.salt');
  const wrapped = getSetting('vault.wrappedKey');
  if (!salt || !wrapped) return false;
  try {
    const kek = deriveKey(pin, Buffer.from(salt, 'base64'));
    const key = Buffer.from(decrypt(wrapped, kek), 'base64');
    if (key.length !== 32) return false;
    masterKey = key;
    lastActivity = Date.now();
    addLog('info', '금고 잠금이 해제되었습니다');
    return true;
  } catch {
    return false;
  }
}

export function lockVault(): void {
  masterKey = null;
  addLog('info', '금고가 잠겼습니다');
}

export function changePin(currentPin: string, nextPin: string): boolean {
  if (!unlockVault(currentPin)) return false;
  if (!/^\d{4,12}$/.test(nextPin)) throw new Error('PIN은 4~12자리 숫자로 정해 주세요.');
  const key = masterKey as unknown as Buffer;
  const salt = crypto.randomBytes(16);
  setSetting('vault.salt', salt.toString('base64'));
  setSetting('vault.wrappedKey', encrypt(key.toString('base64'), deriveKey(nextPin, salt)));
  return true;
}

function encryptionKey(): Buffer {
  if (!vaultUnlocked()) throw new Error('금고가 잠겨 있습니다.');
  touchVault();
  return masterKey as Buffer;
}

function preview(value: string, type: VaultType, username?: string | null): { masked: string; usernameMasked: string | null; hint: string } {
  if (type === 'memo') {
    const firstLine = value.split('\n')[0] || '';
    return { masked: firstLine.slice(0, 42), usernameMasked: null, hint: '메모' };
  }
  const usernameMasked = username ? (username.includes('@') ? maskEmail(username) : maskSecret(username)) : null;
  return { masked: maskSecret(value), usernameMasked, hint: '' };
}

export function vaultCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM vault_items').get() as { n: number };
  return row.n;
}

export function listItems(query = ''): VaultItemView[] {
  const key = encryptionKey();
  const rows = db.prepare('SELECT * FROM vault_items ORDER BY updated_at DESC').all() as VaultItemRow[];
  const out: VaultItemView[] = [];
  for (const row of rows) {
    let secret = '';
    try {
      secret = decrypt(row.secret_enc, key);
    } catch {
      secret = '';
    }
    const { masked, usernameMasked, hint } = preview(secret, row.type, row.username);
    const haystack = `${row.title} ${row.notes || ''} ${row.type} ${row.username || ''} ${masked}`.toLowerCase();
    if (query && !haystack.includes(query.toLowerCase())) continue;
    out.push({
      id: row.id,
      title: row.title,
      type: row.type,
      masked,
      usernameMasked,
      hint: row.notes ? row.notes.slice(0, 48) : hint,
      notes: row.notes || '',
      isDefault: Number(row.is_default) === 1,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    });
  }
  return out;
}

export function createItem(input: {
  title: string;
  type: VaultType;
  secret: string;
  notes?: string;
  username?: string;
  isDefault?: boolean;
}): string {
  const key = encryptionKey();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (input.isDefault) clearDefaultFor(input.title);
  db.prepare(
    'INSERT INTO vault_items(id, title, type, username, secret_enc, notes, is_default, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(
    id,
    input.title,
    input.type,
    input.username || null,
    encrypt(input.secret, key),
    input.notes || null,
    input.isDefault ? 1 : 0,
    now,
    now
  );
  addLog('info', `금고에 항목 추가 · ${input.title}`);
  return id;
}

/** 같은 서비스(제목 앞부분)에 기본 계정이 둘 이상 생기지 않게 이전 기본값을 내린다. */
function clearDefaultFor(title: string): void {
  const key = title.trim().split(/[\s(（·-]/)[0].toLowerCase();
  if (!key) return;
  const rows = db.prepare('SELECT id, title FROM vault_items WHERE is_default = 1').all() as { id: string; title: string }[];
  for (const row of rows) {
    if (row.title.toLowerCase().includes(key)) {
      db.prepare('UPDATE vault_items SET is_default = 0 WHERE id = ?').run(row.id);
    }
  }
}

export function setDefault(id: string, value: boolean): void {
  const row = db.prepare('SELECT id, title FROM vault_items WHERE id = ?').get(id) as { id: string; title: string } | undefined;
  if (!row) throw new Error('항목을 찾을 수 없습니다.');
  if (value) clearDefaultFor(row.title);
  db.prepare('UPDATE vault_items SET is_default = ?, updated_at = ? WHERE id = ?').run(
    value ? 1 : 0,
    new Date().toISOString(),
    id
  );
}

export function updateItem(
  id: string,
  input: { title?: string; type?: VaultType; secret?: string; notes?: string; username?: string; isDefault?: boolean }
): void {
  const key = encryptionKey();
  const row = db.prepare('SELECT * FROM vault_items WHERE id = ?').get(id) as VaultItemRow | undefined;
  if (!row) throw new Error('항목을 찾을 수 없습니다.');
  if (input.isDefault === true) clearDefaultFor(input.title ?? row.title);
  db.prepare(
    'UPDATE vault_items SET title = ?, type = ?, secret_enc = ?, notes = ?, username = ?, is_default = ?, updated_at = ? WHERE id = ?'
  ).run(
    input.title ?? row.title,
    input.type ?? row.type,
    input.secret ? encrypt(input.secret, key) : row.secret_enc,
    input.notes ?? row.notes,
    input.username ?? row.username,
    input.isDefault === undefined ? row.is_default : input.isDefault ? 1 : 0,
    new Date().toISOString(),
    id
  );
}

export function deleteItem(id: string): void {
  const row = db.prepare('SELECT title FROM vault_items WHERE id = ?').get(id) as { title: string } | undefined;
  db.prepare('DELETE FROM vault_items WHERE id = ?').run(id);
  if (row) addLog('info', `금고에서 항목 삭제 · ${row.title}`);
}

export function revealItem(id: string): { title: string; secret: string; username: string } {
  const key = encryptionKey();
  const row = db.prepare('SELECT * FROM vault_items WHERE id = ?').get(id) as VaultItemRow | undefined;
  if (!row) throw new Error('항목을 찾을 수 없습니다.');
  db.prepare('UPDATE vault_items SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return { title: row.title, secret: decrypt(row.secret_enc, key), username: row.username || '' };
}

export interface VaultMatch {
  id: string;
  title: string;
  type: VaultType;
  usernameMasked: string | null;
  isDefault: boolean;
}

/**
 * AI가 사이트 이름으로 금고 계정을 찾을 때 쓴다 (v0.5.0).
 * 비밀번호·아이디 원문은 절대 돌려주지 않는다. 제목·메모·아이디(마스킹)만 보여 준다.
 * 금고가 잠겨 있어도 목록은 볼 수 있다(복호화가 필요 없다).
 */
export function findForSite(term: string): VaultMatch[] {
  const q = String(term || '').trim().toLowerCase();
  const rows = db
    .prepare('SELECT id, title, type, username, notes, is_default FROM vault_items ORDER BY is_default DESC, updated_at DESC')
    .all() as Pick<VaultItemRow, 'id' | 'title' | 'type' | 'username' | 'notes' | 'is_default'>[];
  const hits = rows.filter((row) => {
    if (!q) return true;
    const hay = `${row.title} ${row.notes || ''} ${row.username || ''} ${row.type}`.toLowerCase();
    return q.split(/\s+/).some((word) => word.length >= 2 && hay.includes(word)) || hay.includes(q);
  });
  return hits.slice(0, 12).map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    usernameMasked: row.username
      ? row.username.includes('@')
        ? maskEmail(row.username)
        : maskSecret(row.username)
      : null,
    isDefault: Number(row.is_default) === 1,
  }));
}

/** 자동 입력용: 서버 안에서만 복호화해 쓴다(호출한 쪽이 AI여도 응답에는 넣지 않는다). */
export function secretForFill(id: string): { username: string; secret: string } {
  const key = encryptionKey();
  const row = db.prepare('SELECT * FROM vault_items WHERE id = ?').get(id) as VaultItemRow | undefined;
  if (!row) throw new Error('금고 항목을 찾을 수 없습니다.');
  db.prepare('UPDATE vault_items SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return { username: row.username || '', secret: decrypt(row.secret_enc, key) };
}

export function vaultMeta(): { configured: boolean; unlocked: boolean; count: number; autoLockMinutes: number } {
  return {
    configured: vaultConfigured(),
    unlocked: vaultUnlocked(),
    count: vaultCount(),
    autoLockMinutes: AUTO_LOCK_MINUTES,
  };
}
