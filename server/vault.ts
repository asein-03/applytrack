import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const protectedKeys = new Map<string, Buffer>();
export function registerProtectedVaultKey(directory: string, key: Buffer) {
  if (key.length !== 32) throw new Error('Invalid protected mailbox encryption key.');
  const path = resolve(directory), previous = protectedKeys.get(path);
  if (previous && !previous.equals(key)) throw new Error('The protected mailbox key is already initialized.');
  if (!previous) protectedKeys.set(path, Buffer.from(key));
}
export function createProtectedVault(directory: string) {
  if (!protectedKeys.has(resolve(directory))) throw new Error('Secure runtime storage must be unlocked by the desktop app.');
  return createVault(directory);
}

export function createVault(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('The mailbox storage directory cannot be a symbolic link.');
  chmodSync(directory, 0o700);
  const filename = join(directory, 'mail-key');
  let key = protectedKeys.get(resolve(directory));
  if (!key) {
    if (existsSync(join(directory, 'mail-key.os'))) throw new Error('Open the desktop app to unlock the mailbox encryption key.');
    try {
      const file = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { const stat = fstatSync(file); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32) throw new Error('Invalid local mailbox encryption key.'); key = readFileSync(file); }
      finally { closeSync(file); }
      chmodSync(filename, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = randomBytes(32);
      writeFileSync(filename, key, { mode: 0o600, flag: 'wx' });
    }
  }
  if (key.length !== 32) throw new Error('Invalid local mailbox encryption key.');
  return {
    encrypt(value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt<T>(value: string): T {
      const packed = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
      decipher.setAuthTag(packed.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')) as T;
    },
  };
}
