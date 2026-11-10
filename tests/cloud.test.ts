import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudService, WorkspaceRepository, exportWorkspace } from '../server/cloud.js';
import { Store, HttpError } from '../server/store.js';
import { createApp } from '../server/app.js';
import { cloudFixture, post, MemoryCloudTransport } from './cloud-fixtures.js';
import type { Application } from '../shared/types.js';

const record = { company: 'Example Labs', role: 'Engineer' };

test('cloud personal records and pending inbox review are isolated by verified identity, never local', async () => {
  const f = await cloudFixture();
  try {
    assert.equal((await f.api('/applications', {}, null)).status, 401);
    const application = await (await f.api('/applications', post(record))).json() as Application;
    assert.equal(f.store.listApplications('personal').length, 0);
    assert.equal((await (await f.api('/applications', {}, 'bob')).json()).applications.length, 0);
    assert.equal((await f.api(`/applications/${application.id}`, {}, 'bob')).status, 404);
    assert.equal((await f.api(`/applications/${application.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'Stolen' }) }, 'bob')).status, 404);
    const imported = await (await f.api('/email/import', post({ text: 'Subject: Application received\nThank you for applying.' }))).json();
    assert.equal(imported.queued, true);
    assert.equal(f.store.listMeta('email-review:').length, 0);
    assert.equal((await (await f.api('/email/review', {}, 'bob')).json()).items.length, 0);
    assert.equal((await f.api(`/email/review/${imported.id}/assign`, post({ applicationId: application.id }), 'bob')).status, 404);
    const assigned = await (await f.api(`/email/review/${imported.id}/assign`, post({ applicationId: application.id }))).json();
    assert.equal(assigned.application.id, application.id);
    assert.equal((await (await f.api('/email/review')).json()).items.length, 0);
    const replacementDevice = new Store(':memory:');
    try {
      const next = new WorkspaceRepository(replacementDevice, f.cloud, f.transport);
      assert.equal((await next.run('personal', f.cloud.actors.get('alice')!, false, data => data.listApplications()))[0].id, application.id);
      assert.deepEqual(replacementDevice.listApplications('personal'), []);
    } finally { replacementDevice.close(); }
  } finally { await f.close(); }
});

test('CAS conflicts retry whole mutations and preserve changes from two devices', async () => {
  const f = await cloudFixture();
  try {
    const actor = f.cloud.actors.get('alice')!;
    await Promise.all([
      f.repository.run('personal', actor, true, data => data.createApplication({ ...record, role: 'First role' })),
      f.repository.run('personal', actor, true, data => data.createApplication({ ...record, role: 'Second role' })),
    ]);
    assert.equal(f.transport.attempts, 3);
    assert.deepEqual((await f.repository.run('personal', actor, false, data => data.listApplications())).map(a => a.role).sort(), ['First role', 'Second role']);
    assert.deepEqual(f.store.listApplications(), []);
  } finally { await f.close(); }
});

test('binding a different account and signing out stop tracking and invalidate previous extension tokens', async () => {
  const f = await cloudFixture();
  try {
    assert.equal((await f.api('/cloud/session', post({ accessToken: 'bob' }))).status, 401);
    assert.equal((await f.api('/cloud/session', post({ accessToken: 'alice', refreshToken: 'alice-refresh' }))).status, 200);
    const firstToken = f.store.getMeta<string>('extensionToken')!;
    await f.api('/sessions', post({ browserEnabled: true, screenEnabled: false }));
    f.cloud.runtimeFor(f.cloud.actors.get('alice')!).setMeta('inbox:one', { id: 'one', email: 'alice@example.test' });
    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
    assert.equal((await f.api('/sessions/current', { headers: { Origin: extensionOrigin } }, firstToken)).status, 200);
    await f.api('/cloud/session', post({ accessToken: 'alice' }));
    assert.equal(f.store.getMeta('extensionToken'), firstToken);
    await f.api('/cloud/session', post({ accessToken: 'bob' }), 'bob');
    assert.notEqual(f.store.getMeta('extensionToken'), firstToken);
    assert.equal(f.cloud.runtimeFor(f.cloud.actors.get('alice')!).getSession(), null);
    assert.equal((await (await f.api('/settings', {}, 'bob')).json()).inboxes.length, 0);
    assert.equal((await f.api('/sessions/current', { headers: { Origin: extensionOrigin } }, firstToken)).status, 401);
    assert.equal((await f.api('/cloud/session', { method: 'DELETE' }, 'alice')).status, 409);
    await f.api('/sessions', post({ browserEnabled: true, screenEnabled: false }), 'bob');
    const secondToken = f.store.getMeta<string>('extensionToken')!;
    assert.equal((await f.api('/cloud/session', { method: 'DELETE' }, secondToken)).status, 401);
    assert.equal((await f.api('/cloud/session', { method: 'DELETE' }, 'bob')).status, 204);
    assert.equal(f.cloud.runtimeFor(f.cloud.actors.get('bob')!).getSession(), null);
    assert.notEqual(f.store.getMeta('extensionToken'), secondToken);
    assert.equal(f.store.getMeta('activeCloudUser'), null);
    assert.equal(f.store.getMeta(`cloud-session:${f.cloud.actors.get('bob')!.id}`), null);
  } finally { await f.close(); }
});

test('cloud export contains application evidence but excludes device tokens, inbox credentials and capture sessions', () => {
  const store = new Store(':memory:');
  try {
    store.createApplication(record);
    store.setMeta('inbox-token:one', 'secret'); store.setMeta('cloud-session:one', 'secret'); store.startSession({ screenEnabled: true, browserEnabled: true });
    store.setMeta('email-review:one', { body: 'Review this' });
    const state = exportWorkspace(store);
    assert.equal(state.applications.length, 1);
    assert.deepEqual(state.metadata.map(row => row.key), ['email-review:one']);
    assert.equal(JSON.stringify(state).includes('secret'), false);
  } finally { store.close(); }
});

test('unconfigured cloud refuses personal writes, while explicit demo remains available without creating an encryption key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'apply-unconfigured-'));
  const savedUrl = process.env.SUPABASE_URL; const savedKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_PUBLISHABLE_KEY;
  const store = new Store(':memory:');
  const cloud = new CloudService(store, directory, true);
  const repository = new WorkspaceRepository(store, cloud, new MemoryCloudTransport());
  const { close } = createApp({ cloud, repository });
  try {
    await assert.rejects(repository.run('personal', null, true, data => data.createApplication(record)), { status: 503 });
    assert.deepEqual(store.listApplications(), []);
    assert.equal((await repository.run('demo', null, false, data => data.listApplications('demo'))).length, 9);
    assert.equal(existsSync(join(directory, 'mail-key')), false);
  } finally {
    close(); rmSync(directory, { recursive: true, force: true });
    if (savedUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = savedKey;
  }
});


test('an unrecoverable device authentication failure stops tracking and invalidates pairing without switching accounts', async () => {
  const f = await cloudFixture();
  try {
    await f.cloud.bind('alice');
    const actor = f.cloud.actors.get('alice')!;
    f.cloud.runtimeFor(actor).startSession({ browserEnabled: true, screenEnabled: true });
    const token = f.store.getMeta('extensionToken');
    f.cloud.actors.delete('alice');
    await assert.rejects(f.cloud.activeActor(), { status: 401 });
    assert.equal(f.cloud.runtimeFor(actor).getSession(), null);
    assert.equal(f.store.getMeta('activeCloudUser'), null);
    assert.notEqual(f.store.getMeta('extensionToken'), token);
    assert.equal(f.store.getMeta(`cloud-session:${actor.id}`), null);
  } finally { await f.close(); }
});


test('retrying device signout is idempotent while another active account remains protected', async () => {
  const f = await cloudFixture();
  try {
    await f.api('/cloud/session', post({ accessToken: 'alice' }));
    await f.api('/sessions', post({ browserEnabled: true, screenEnabled: false }));
    assert.equal((await f.api('/cloud/session', { method: 'DELETE' })).status, 204);
    const rotatedToken = f.store.getMeta('extensionToken');
    assert.equal((await f.api('/cloud/session', { method: 'DELETE' })).status, 204);
    assert.equal(f.store.getMeta('extensionToken'), rotatedToken);
    assert.equal(f.store.getMeta('activeCloudUser'), null);
    await f.api('/cloud/session', post({ accessToken: 'bob' }), 'bob');
    assert.equal((await f.api('/cloud/session', { method: 'DELETE' }, 'alice')).status, 409);
    assert.equal(f.store.getMeta('activeCloudUser'), f.cloud.actors.get('bob')!.id);
  } finally { await f.close(); }
});


test('same-user token refresh races keep capture retryable, but a different active account stays terminal', async () => {
  for (const scenario of ['same-user', 'expired-old-token', 'different-user'] as const) {
    const f = await cloudFixture();
    let resume!: () => void;
    const wait = new Promise<void>(resolve => { resume = resolve; });
    try {
      await f.cloud.bind('alice');
      const alice = f.cloud.actors.get('alice')!;
      f.cloud.runtimeFor(alice).startSession({ browserEnabled: true, screenEnabled: false });
      const originalVerify = f.cloud.verify.bind(f.cloud);
      let pauseNext = true;
      f.cloud.verify = async token => {
        if (pauseNext) {
          pauseNext = false;
          await wait;
          if (scenario === 'expired-old-token') throw new HttpError(401, 'Old token expired.');
        }
        return originalVerify(token);
      };
      const pending = assert.rejects(f.cloud.activeActor(), { status: scenario === 'different-user' ? 409 : 503 });
      await f.cloud.bind(scenario === 'different-user' ? 'bob' : 'alice');
      resume(); await pending;
      assert.equal((await f.cloud.activeActor()).id, f.cloud.actors.get(scenario === 'different-user' ? 'bob' : 'alice')!.id);
      assert.equal(!!f.cloud.runtimeFor(alice).getSession(), scenario !== 'different-user');
    } finally { resume?.(); await f.close(); }
  }
});
