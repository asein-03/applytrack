import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createVault(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, 'mail-key');
  let key: Buffer;
  try { key = readFileSync(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = randomBytes(32);
    writeFileSync(filename, key, { mode: 0o600, flag: 'wx' });
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
