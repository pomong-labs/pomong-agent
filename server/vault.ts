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
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    });
  }
  return out;
}

export function createItem(input: { title: string; type: VaultType; secret: string; notes?: string; username?: string }): string {
  const key = encryptionKey();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO vault_items(id, title, type, username, secret_enc, notes, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id, input.title, input.type, input.username || null, encrypt(input.secret, key), input.notes || null, now, now);
  addLog('info', `금고에 항목 추가 · ${input.title}`);
  return id;
}

export function updateItem(
  id: string,
  input: { title?: string; type?: VaultType; secret?: string; notes?: string; username?: string }
): void {
  const key = encryptionKey();
  const row = db.prepare('SELECT * FROM vault_items WHERE id = ?').get(id) as VaultItemRow | undefined;
  if (!row) throw new Error('항목을 찾을 수 없습니다.');
  db.prepare(
    'UPDATE vault_items SET title = ?, type = ?, secret_enc = ?, notes = ?, username = ?, updated_at = ? WHERE id = ?'
  ).run(
    input.title ?? row.title,
    input.type ?? row.type,
    input.secret ? encrypt(input.secret, key) : row.secret_enc,
    input.notes ?? row.notes,
    input.username ?? row.username,
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

export function vaultMeta(): { configured: boolean; unlocked: boolean; count: number; autoLockMinutes: number } {
  return {
    configured: vaultConfigured(),
    unlocked: vaultUnlocked(),
    count: vaultCount(),
    autoLockMinutes: AUTO_LOCK_MINUTES,
  };
}
