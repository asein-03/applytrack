import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudFixture } from './cloud-fixtures.js';

const endpoint = 'https://synthetic.supabase.co/functions/v1/account';
const deletion = { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE', password: 'synthetic-password' }) };

test('account deletion requires confirmation and the active owner; failures preserve local account state', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ headers: Headers; body: unknown }> = [];
  let response = () => Response.json({ error: 'private-upstream-value' }, { status: 403 });
  globalThis.fetch = async (input, init) => {
    if (String(input) !== endpoint) return original(input, init);
    calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }); return response();
  };
  const f = await cloudFixture();
  Object.defineProperty(f.cloud, 'url', { value: 'https://synthetic.supabase.co' });
  const alice = f.cloud.actors.get('alice')!.id;
  f.store.setMeta('activeCloudUser', alice); f.store.setMeta(`user:${alice}:keep`, 'private-runtime');
  try {
    assert.equal((await f.api('/cloud/account', deletion, null)).status, 401);
    assert.equal((await f.api('/cloud/account', deletion, 'bob')).status, 409);
    assert.equal((await f.api('/cloud/account', { method: 'DELETE', body: JSON.stringify({ confirmation: 'delete', password: 'synthetic-password' }) })).status, 422);
    assert.equal(calls.length, 0);
    const rejected = await f.api('/cloud/account', deletion);
    assert.equal(rejected.status, 403); assert.equal((await rejected.text()).includes('private-upstream-value'), false);
    assert.equal(f.store.getMeta('activeCloudUser'), alice);
    assert.equal(f.store.getMeta(`user:${alice}:keep`), 'private-runtime');
    response = () => Response.json({ deleted: false });
    assert.equal((await f.api('/cloud/account', deletion)).status, 502);
    assert.equal(f.store.getMeta(`user:${alice}:keep`), 'private-runtime');
    assert.equal(calls[0].headers.get('authorization'), 'Bearer alice');
    assert.deepEqual(calls[0].body, { action: 'delete', confirmation: 'DELETE', password: 'synthetic-password' });
  } finally { await f.close(); globalThis.fetch = original; }
});

test('confirmed cloud deletion clears only its owner runtime and invalidates device pairing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input) === endpoint ? Response.json({ deleted: true, revocationPending: true, secret: 'never-return' }) : original(input, init);
  const f = await cloudFixture();
  Object.defineProperty(f.cloud, 'url', { value: 'https://synthetic.supabase.co' });
  const alice = f.cloud.actors.get('alice')!.id, bob = f.cloud.actors.get('bob')!.id;
  f.store.setMeta('activeCloudUser', alice); f.store.setMeta('extensionToken', 'old-pairing');
  for (const id of [alice, bob]) { f.store.setMeta(`user:${id}:runtime`, 'private-runtime'); f.store.setMeta(`cloud-session:${id}`, 'private-session'); }
  try {
    const response = await f.api('/cloud/account', deletion);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true, revocationPending: true });
    assert.equal(f.store.getMeta('activeCloudUser'), null);
    assert.notEqual(f.store.getMeta('extensionToken'), 'old-pairing');
    assert.deepEqual(f.store.listMeta(`user:${alice}:`), []); assert.equal(f.store.getMeta(`cloud-session:${alice}`), null);
    assert.equal(f.store.getMeta(`user:${bob}:runtime`), 'private-runtime'); assert.equal(f.store.getMeta(`cloud-session:${bob}`), 'private-session');
  } finally { await f.close(); globalThis.fetch = original; }
});

test('a completed deletion cannot unbind a different account selected while the request was pending', async () => {
  const original = globalThis.fetch;
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async (input, init) => {
    if (String(input) !== endpoint) return original(input, init);
    started(); await gate; return Response.json({ deleted: true, revocationPending: false });
  };
  const f = await cloudFixture();
  Object.defineProperty(f.cloud, 'url', { value: 'https://synthetic.supabase.co' });
  const alice = f.cloud.actors.get('alice')!.id, bob = f.cloud.actors.get('bob')!.id;
  f.store.setMeta('activeCloudUser', alice); f.store.setMeta(`user:${alice}:runtime`, 'old');
  try {
    const pending = f.api('/cloud/account', deletion); await ready;
    f.store.setMeta('activeCloudUser', bob); f.store.setMeta(`user:${bob}:runtime`, 'current'); f.store.setMeta('extensionToken', 'new-owner-pairing');
    release(); assert.equal((await pending).status, 200);
    assert.equal(f.store.getMeta('activeCloudUser'), bob); assert.equal(f.store.getMeta('extensionToken'), 'new-owner-pairing');
    assert.equal(f.store.getMeta(`user:${bob}:runtime`), 'current'); assert.deepEqual(f.store.listMeta(`user:${alice}:`), []);
  } finally { release(); await f.close(); globalThis.fetch = original; }
});
