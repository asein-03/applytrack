import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeCredentialStorage, type OSStringProtection } from '../desktop/secure-storage.js';
import { createVault } from '../server/vault.js';

const project = 'https://project.supabase.co';
const storageKey = 'sb-project-auth-token';
function testProtection(): OSStringProtection {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptStringAsync: async packed => {
      const cipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12)); cipher.setAuthTag(packed.subarray(12, 28));
      return { result: Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}
const directory = () => mkdtempSync(join(tmpdir(), 'apply-secure-storage-'));

test('native credentials and the vault key survive restart without plaintext files', async () => {
  const dir = directory(), restarted = directory(), protection = testProtection();
  try {
    const oldVault = createVault(dir), originalKey = readFileSync(join(dir, 'mail-key'));
    const ciphertext = oldVault.encrypt({ refresh_token: 'synthetic-mail-token' });
    const storage = await createNativeCredentialStorage(dir, project, { protection });
    assert.equal(existsSync(join(dir, 'mail-key')), false);
    assert.equal(readFileSync(join(dir, 'mail-key.os')).includes(originalKey), false);
    assert.equal(lstatSync(join(dir, 'mail-key.os')).mode & 0o777, 0o600);
    assert.deepEqual(createVault(dir).decrypt(ciphertext), { refresh_token: 'synthetic-mail-token' });
    await Promise.all([storage.setItem(storageKey, 'synthetic-account-token'), storage.setItem(`${storageKey}-code-verifier`, 'synthetic-verifier')]);
    const accountFile = readFileSync(join(dir, 'account-session.os'));
    assert.equal(accountFile.includes('synthetic-account-token'), false);
    assert.equal(accountFile.includes('synthetic-verifier'), false);
    cpSync(dir, restarted, { recursive: true });
    assert.throws(() => createVault(restarted), /desktop app/);
    const restored = await createNativeCredentialStorage(restarted, project, { protection });
    assert.equal(await restored.getItem(storageKey), 'synthetic-account-token');
    assert.equal(await restored.getItem(`${storageKey}-code-verifier`), 'synthetic-verifier');
    assert.deepEqual(createVault(restarted).decrypt(ciphertext), { refresh_token: 'synthetic-mail-token' });
    await restored.removeItem(storageKey);
    assert.equal(await restored.getItem(storageKey), null);
    assert.equal(await restored.getItem(`${storageKey}-code-verifier`), 'synthetic-verifier');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(restarted, { recursive: true, force: true }); }
});

test('native storage fails closed for unavailable encryption and Linux plaintext fallback', async () => {
  const dir = directory();
  try {
    await assert.rejects(createNativeCredentialStorage(dir, project, { protection: { ...testProtection(), isAsyncEncryptionAvailable: async () => false } }), /unavailable/);
    await assert.rejects(createNativeCredentialStorage(dir, project, { platform: 'linux', protection: { ...testProtection(), getSelectedStorageBackend: () => 'basic_text' } }), /unavailable/);
    assert.equal(existsSync(join(dir, 'mail-key')), false);
    assert.equal(existsSync(join(dir, 'mail-key.os')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('credential IPC storage accepts only project keys and bounded strings', async () => {
  const dir = directory();
  try {
    const storage = await createNativeCredentialStorage(dir, project, { protection: testProtection() });
    for (const key of ['../../outside', 'sb-other-auth-token', '__proto__', null, {}]) {
      await assert.rejects(storage.getItem(key), /not available/);
      await assert.rejects(storage.setItem(key, 'value'), /not available/);
      await assert.rejects(storage.removeItem(key), /not available/);
    }
    await assert.rejects(storage.setItem(storageKey, 'a'.repeat(256 * 1024 + 1)), /invalid/);
    await assert.rejects(storage.setItem(storageKey, {}), /invalid/);
    await storage.setItem(storageKey, 'valid-synthetic-value');
    assert.equal(await storage.getItem(storageKey), 'valid-synthetic-value');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed key wrapping preserves the old key and refuses credential symlinks', async () => {
  const dir = directory(), target = directory();
  try {
    const original = randomBytes(32); writeFileSync(join(dir, 'mail-key'), original, { mode: 0o600 });
    const failing = { ...testProtection(), encryptStringAsync: async () => { throw new Error('OS keychain locked.'); } };
    await assert.rejects(createNativeCredentialStorage(dir, project, { protection: failing }), /locked/);
    assert.deepEqual(readFileSync(join(dir, 'mail-key')), original);
    assert.equal(existsSync(join(dir, 'mail-key.os')), false);
    symlinkSync(join(target, 'external'), join(dir, 'account-session.os'));
    await assert.rejects(createNativeCredentialStorage(dir, project, { protection: testProtection() }), /symbolic/);
    assert.equal(existsSync(join(target, 'external')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test('tampered OS-protected credentials never silently replace a saved session', async () => {
  const dir = directory(), protection = testProtection();
  try {
    const storage = await createNativeCredentialStorage(dir, project, { protection });
    await storage.setItem(storageKey, 'original-synthetic-session');
    const path = join(dir, 'account-session.os'), bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes);
    await assert.rejects(createNativeCredentialStorage(dir, project, { protection }));
    assert.deepEqual(readFileSync(path), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
