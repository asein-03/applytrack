import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { createProtectedVault, registerProtectedVaultKey } from '../server/vault.js';

const directory = () => mkdtempSync(join(tmpdir(), 'apply-metadata-test-'));
const rawDatabase = (path: string) => Buffer.concat([path, `${path}-wal`, `${path}-shm`].filter(existsSync).map(name => readFileSync(name)));
function codec(directory: string) { registerProtectedVaultKey(directory, randomBytes(32)); return createProtectedVault(directory); }

test('native metadata migration removes token, email, and deleted-page plaintext and survives restart', () => {
  const dir = directory(), path = join(dir, 'apply.sqlite');
  const token = 'synthetic-private-pairing-token', email = 'candidate@northstar.example', deleted = 'deleted-private-inbox-fragment';
  try {
    const legacy = new Store(path);
    legacy.db.exec('PRAGMA secure_delete = OFF');
    legacy.setMeta('extensionToken', token);
    legacy.setMeta('user:owner:inbox:mail', { email, status: 'connected' });
    legacy.setMeta('removed', { payload: 'x'.repeat(5000) + deleted + 'x'.repeat(5000) });
    legacy.deleteMeta('removed'); legacy.close();
    assert.equal(rawDatabase(path).includes(token), true);
    assert.equal(rawDatabase(path).includes(email), true);
    assert.equal(rawDatabase(path).includes(deleted), true);
    const protection = codec(dir), protectedStore = new Store(path, protection);
    assert.equal(protectedStore.getMeta('extensionToken'), token);
    assert.deepEqual(protectedStore.listMeta('user:owner:inbox:').map(row => row.value), [{ email, status: 'connected' }]);
    for (const value of [token, email, deleted]) assert.equal(rawDatabase(path).includes(value), false);
    assert.equal(protectedStore.db.prepare("SELECT value FROM store_settings WHERE key = 'metadata_cleanup_pending'").get(), undefined);
    protectedStore.close();
    assert.throws(() => new Store(path), /unlock protected runtime data/);
    const reopened = new Store(path, protection);
    assert.equal(reopened.getMeta('extensionToken'), token);
    reopened.setMeta('user:owner:inbox:mail', { email: 'updated@northstar.example' });
    reopened.close();
    assert.equal(rawDatabase(path).includes('updated@northstar.example'), false);
    assert.equal(existsSync(join(dir, 'mail-key')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('protected metadata rejects row substitution and never falls back to plaintext', () => {
  const dir = directory(), path = join(dir, 'apply.sqlite');
  try {
    const protection = codec(dir), store = new Store(path, protection);
    store.setMeta('first', { private: 'first-value' }); store.setMeta('second', { private: 'second-value' });
    store.db.prepare("UPDATE metadata SET value = (SELECT value FROM metadata WHERE key = 'first') WHERE key = 'second'").run();
    assert.throws(() => store.getMeta('second'), /invalid/);
    store.close();
    assert.throws(() => new Store(path, protection), /invalid/);
    assert.throws(() => new Store(path), /unlock/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed migration preserves legacy metadata atomically', () => {
  const dir = directory(), path = join(dir, 'apply.sqlite');
  try {
    const legacy = new Store(path); legacy.setMeta('first', 'original-value'); legacy.close();
    const protection = codec(dir); let calls = 0;
    assert.throws(() => new Store(path, { ...protection, encrypt(value) { if (++calls === 2) throw new Error('Synthetic encryption failure.'); return protection.encrypt(value); } }), /Synthetic/);
    const db = new DatabaseSync(path);
    assert.equal((db.prepare("SELECT value FROM metadata WHERE key = 'first'").get() as { value: string }).value, JSON.stringify('original-value'));
    assert.equal(db.prepare("SELECT value FROM store_settings WHERE key = 'metadata_encryption'").get(), undefined);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an encrypted store rejects plaintext row substitution on restart', () => {
  const dir = directory(), path = join(dir, 'apply.sqlite');
  try {
    const protection = codec(dir), store = new Store(path, protection);
    store.setMeta('private-row', { state: 'original' });
    store.db.prepare("UPDATE metadata SET value = ? WHERE key = 'private-row'").run(JSON.stringify({ state: 'substituted' }));
    store.close();
    assert.throws(() => new Store(path, protection), /unencrypted value/);
    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM store_settings WHERE key = 'metadata_encryption'").run(); db.close();
    assert.throws(() => new Store(path, protection), /unencrypted value/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native createApp requires an OS-unlocked key and encrypts its runtime pairing token', () => {
  const dir = directory(), previousDir = process.env.DATA_DIR, previousMode = process.env.APP_STORAGE_MODE;
  process.env.DATA_DIR = dir; process.env.APP_STORAGE_MODE = 'local';
  try {
    assert.throws(() => createApp({ protectRuntime: true }), /unlocked by the desktop app/);
    assert.equal(existsSync(join(dir, 'mail-key')), false);
    codec(dir);
    const app = createApp({ protectRuntime: true }); const token = app.store.getMeta<string>('extensionToken')!;
    app.close();
    assert.equal(rawDatabase(join(dir, 'apply.sqlite')).includes(token), false);
  } finally {
    if (previousDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
    if (previousMode === undefined) delete process.env.APP_STORAGE_MODE; else process.env.APP_STORAGE_MODE = previousMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
