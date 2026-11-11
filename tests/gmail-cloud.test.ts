import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudGmail } from '../server/gmail-cloud.js';
import type { CloudActor } from '../server/cloud.js';
import { cloudFixture, post } from './cloud-fixtures.js';

const cloud = { url: 'https://synthetic.supabase.co', publishableKey: 'sb_publishable_synthetic' };
const inbox = { id: 'inbox-one', provider: 'gmail', email: 'applicant@example.invalid', status: 'connected', lastSyncAt: null, connectedAt: '2026-11-10T16:00:00Z', syncing: false };
const actor = { id: 'alice', accessToken: 'alice-test-token' } as CloudActor;

test('cloud Gmail exposes only safe connection fields and forwards the authenticated user token', async () => {
  const requests: Array<{ token: string | null; action: string }> = [];
  const client = new CloudGmail(cloud, async (_url, init) => {
    requests.push({ token: new Headers(init?.headers).get('authorization'), action: JSON.parse(String(init?.body)).action });
    return Response.json({ gmailConfigured: true, secret: 'must-not-leak', inboxes: [{ ...inbox, access_token: 'must-not-leak', refresh_token: 'must-not-leak' }] });
  });
  const status = await client.status(actor);
  assert.equal(status.inboxes[0].email, inbox.email); assert.equal(status.gmailSyncMode, 'cloud');
  assert.equal(JSON.stringify(status).includes('must-not-leak'), false);
  assert.deepEqual(requests, [{ token: 'Bearer alice-test-token', action: 'status' }]);
  await client.status(actor); assert.equal(requests.length, 1, 'settings reuse a short account-scoped status cache');
  await client.status({ ...actor, id: 'bob', accessToken: 'bob-test-token' }); assert.equal(requests[1].token, 'Bearer bob-test-token');
});

test('upstream errors are sanitized and do not break ordinary workspace settings', async () => {
  const client = new CloudGmail(cloud, async () => Response.json({ error: 'secret-token-value' }, { status: 503 }));
  const status = await client.status(actor);
  assert.match(status.gmailStatusError!, /status is unavailable/); assert.equal(status.gmailConfigured, false);
  await assert.rejects(client.connect(actor), error => error instanceof Error && /not available/.test(error.message) && !error.message.includes('secret-token-value'));
  for (const url of ['javascript:alert(1)', 'https://accounts.google.com.evil.test/o/oauth2/v2/auth', 'https://user' + '@accounts.google.com/o/oauth2/v2/auth', 'invalid']) {
    const unsafe = new CloudGmail(cloud, async () => Response.json({ url }));
    await assert.rejects(unsafe.connect(actor), /invalid connection link/);
  }
});

test('cloud Gmail routes use hosted OAuth without cookies and preserve per-account access', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ token: string | null; action: string; inboxId?: string }> = [];
  let unavailable = false;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== `${cloud.url}/functions/v1/gmail`) return originalFetch(input, init);
    const token = new Headers(init?.headers).get('authorization'), body = JSON.parse(String(init?.body));
    calls.push({ token, ...body });
    if (unavailable) return Response.json({ error: 'upstream-private-detail' }, { status: 503 });
    if (body.inboxId && token !== 'Bearer alice') return Response.json({ error: 'not owned' }, { status: 404 });
    if (body.action === 'connect') return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' });
    if (body.action === 'sync') return Response.json({ syncing: true, token: 'must-not-leak' });
    if (body.action === 'disconnect') return Response.json({ disconnected: true });
    return Response.json({ gmailConfigured: true, inboxes: token === 'Bearer alice' ? [inbox] : [] });
  };
  const f = await cloudFixture();
  Object.defineProperty(f.cloud, 'url', { value: cloud.url });
  try {
    f.store.setMeta('activeCloudUser', f.cloud.actors.get('alice')!.id);
    assert.equal((await f.api('/inboxes', {}, null)).status, 401);
    const connected = await f.api('/inboxes/google/connect', post({}));
    assert.equal(connected.status, 200); assert.equal(connected.headers.get('set-cookie'), null);
    assert.match((await connected.json()).url, /^https:\/\/accounts\.google\.com\//);
    assert.equal((await f.api('/inboxes/google/callback?state=legacy&code=legacy')).status, 410);
    assert.deepEqual((await (await f.api('/inboxes', {}, 'bob')).json()).inboxes, []);
    assert.equal((await f.api('/inboxes/inbox-one/sync', post({}), 'bob')).status, 404);
    assert.deepEqual(await (await f.api('/inboxes/inbox-one/sync', post({}))).json(), { syncing: true });
    assert.equal((await f.api('/inboxes/inbox-one', { method: 'DELETE' })).status, 204);
    assert.equal(f.store.listMeta('inbox-token:').length, 0);
    unavailable = true;
    const status = await f.api('/inboxes'); assert.equal(status.status, 200); assert.match((await status.json()).gmailStatusError, /unavailable/);
    const settings = await f.api('/settings'); assert.equal(settings.status, 200);
    const body = await settings.json(); assert(body.extensionToken); assert.equal(body.cloud.user.id, f.cloud.actors.get('alice')!.id);
    assert.equal(JSON.stringify(body).includes('upstream-private-detail'), false);
    assert(calls.every(call => ['Bearer alice', 'Bearer bob'].includes(call.token!)));
  } finally { await f.close(); globalThis.fetch = originalFetch; }
});
