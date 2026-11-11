import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { registerProtectedVaultKey } from '../server/vault.js';

export interface OSStringProtection {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}
const maximumBytes = 1024 * 1024;

function readPrivateFile(filename: string): Buffer | null {
  try {
    if (lstatSync(filename).isSymbolicLink()) throw new Error('Credential files cannot be symbolic links.');
    const file = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximumBytes) throw new Error('Invalid credential file.');
      fchmodSync(file, 0o600);
      return readFileSync(file);
    } finally { closeSync(file); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const file = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(file); } finally { closeSync(file); }
}
function writePrivateFile(filename: string, bytes: Buffer) {
  readPrivateFile(filename);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, filename); syncDirectory(dirname(filename));
  } finally { rmSync(temporary, { force: true }); }
}
function decodeVaultKey(value: string) {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('The protected mailbox key is invalid.');
  return key;
}

export async function createNativeCredentialStorage(directory: string, cloudUrl: string, options: { protection?: OSStringProtection; platform?: NodeJS.Platform } = {}) {
  const protection = options.protection ?? (await import('electron')).safeStorage;
  const platform = options.platform ?? process.platform;
  if (!await protection.isAsyncEncryptionAvailable() || (platform === 'linux' && (!protection.getSelectedStorageBackend || ['basic_text', 'unknown'].includes(protection.getSelectedStorageBackend())))) throw new Error('Secure system credential storage is unavailable. Unlock your keychain and reopen ApplyTrack.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('The credential directory cannot be a symbolic link.');
  chmodSync(directory, 0o700);
  const keyFilename = join(directory, 'mail-key.os'), legacyFilename = join(directory, 'mail-key');
  const savedKey = readPrivateFile(keyFilename), legacyKey = readPrivateFile(legacyFilename);
  let key: Buffer;
  if (savedKey) {
    const decrypted = await protection.decryptStringAsync(savedKey); key = decodeVaultKey(decrypted.result);
    if (legacyKey && !key.equals(legacyKey)) throw new Error('The saved mailbox keys do not match.');
    if (decrypted.shouldReEncrypt) writePrivateFile(keyFilename, await protection.encryptStringAsync(key.toString('base64')));
  } else {
    key = legacyKey ?? randomBytes(32);
    if (key.length !== 32) throw new Error('The mailbox encryption key is invalid.');
    const encrypted = await protection.encryptStringAsync(key.toString('base64'));
    if (!decodeVaultKey((await protection.decryptStringAsync(encrypted)).result).equals(key)) throw new Error('The mailbox key could not be protected.');
    writePrivateFile(keyFilename, encrypted);
  }
  if (legacyKey) { unlinkSync(legacyFilename); syncDirectory(directory); }
  registerProtectedVaultKey(directory, key); key.fill(0);

  const storageKey = cloudUrl ? `sb-${new URL(cloudUrl).hostname.split('.')[0]}-auth-token` : null;
  const allowedKeys = new Set(storageKey ? [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`] : []);
  const filename = join(directory, 'account-session.os');
  const encrypted = readPrivateFile(filename);
  let values: Record<string, string> = Object.create(null);
  const validateKey = (key: unknown): string => {
    if (typeof key !== 'string' || !allowedKeys.has(key)) throw new Error('This credential key is not available.');
    return key;
  };
  if (encrypted) {
    const decrypted = await protection.decryptStringAsync(encrypted);
    const saved: unknown = JSON.parse(decrypted.result);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('The saved account credentials are invalid.');
    for (const [key, value] of Object.entries(saved)) {
      validateKey(key);
      if (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024) throw new Error('The saved account credentials are invalid.');
      values[key] = value;
    }
    if (decrypted.shouldReEncrypt) writePrivateFile(filename, await protection.encryptStringAsync(JSON.stringify(values)));
  }
  let pending: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation); pending = result.catch(() => undefined); return result;
  }
  async function save(next: Record<string, string>) {
    writePrivateFile(filename, await protection.encryptStringAsync(JSON.stringify(next))); values = next;
  }
  return {
    getItem(key: unknown): Promise<string | null> { return serialized(async () => values[validateKey(key)] ?? null); },
    setItem(key: unknown, value: unknown): Promise<void> {
      return serialized(async () => {
        const name = validateKey(key);
        if (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024) throw new Error('The account credential value is invalid.');
        await save({ ...values, [name]: value });
      });
    },
    removeItem(key: unknown): Promise<void> { return serialized(async () => { const name = validateKey(key); const next = { ...values }; delete next[name]; await save(next); }); },
  };
}
