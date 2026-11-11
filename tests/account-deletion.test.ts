import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountError, createAccountHandler, type AccountActor, type AccountDeletionBackend } from '../supabase/functions/account/handler.ts';
const actor: AccountActor = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222', email: 'person@candidate.example' };
const lease = { userId: actor.userId, leaseId: '33333333-3333-4333-8333-333333333333' };
const input = { action: 'delete', confirmation: 'DELETE', password: 'synthetic password' };
function setup() {
  const calls: string[] = []; let names = [`${actor.userId}/application/resume.pdf`];
  const backend: AccountDeletionBackend = {
    async begin(owner) { assert.deepEqual(owner, actor); calls.push('queue-revocations-and-disconnect'); return lease; },
    async files() { calls.push('list'); return names; },
    async removeFiles(paths) { calls.push('remove-storage'); assert.deepEqual(paths, names); names = []; },
    async purgeWorkspace() { calls.push('purge-workspace'); },
    async deleteAuthUser(id) { assert.equal(id, actor.userId); calls.push('delete-auth'); },
    async finish() { calls.push('finish'); return { revocationPending: true }; },
    async release() { calls.push('release'); },
  };
  const dependencies = { authenticate: async () => actor as AccountActor | null, verifyPassword: async (owner: AccountActor, password: string) => { assert.deepEqual(owner, actor); calls.push('password'); return password === input.password; }, backend };
  return { calls, backend, dependencies, handler: createAccountHandler(dependencies) };
}
const request = (body: unknown = input, headers: Record<string, string> = {}) => new Request('https://project.example/functions/v1/account', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
test('deletion confirms the current password then removes storage and workspace before the Auth identity', async () => {
  const { handler, calls } = setup(); const response = await handler(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true, revocationPending: true });
  assert.deepEqual(calls, ['password', 'queue-revocations-and-disconnect', 'list', 'remove-storage', 'list', 'purge-workspace', 'delete-auth', 'finish']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('expired identity, wrong password, missing confirmation, foreign target and untrusted origin cannot start cleanup', async () => {
  const scenarios = [
    { body: { ...input, password: 'wrong password' }, status: 403 },
    { body: { ...input, confirmation: 'delete' }, status: 400 },
    { body: { ...input, userId: 'another-owner' }, status: 400 },
    { body: { ...input, password: 'x'.repeat(9000) }, status: 400 },
    { body: input, status: 403, headers: { Origin: 'https://attacker.example' } },
  ];
  for (const scenario of scenarios) {
    const { handler, calls } = setup(); const response = await handler(request(scenario.body, scenario.headers));
    assert.equal(response.status, scenario.status); assert.equal(calls.includes('queue-revocations-and-disconnect'), false);
    assert.equal((await response.text()).includes('synthetic password'), false);
  }
  const { dependencies, calls } = setup(); dependencies.authenticate = async () => null;
  assert.equal((await createAccountHandler(dependencies)(request())).status, 401); assert.deepEqual(calls, []);
});
test('failed storage or Auth cleanup never claims completion and preserves retryable intent', async () => {
  for (const failure of ['removeFiles', 'purgeWorkspace', 'deleteAuthUser'] as const) {
    const { backend, dependencies, calls } = setup(); backend[failure] = async () => { throw new Error('private provider payload'); };
    const response = await createAccountHandler(dependencies)(request());
    assert.equal(response.status, 503); const body = await response.json(); assert.equal(body.code, 'deletion_incomplete'); assert.equal(body.deleted, undefined);
    assert.equal(JSON.stringify(body).includes('private provider payload'), false); assert.equal(calls.at(-1), 'release');
    if (failure === 'removeFiles' || failure === 'purgeWorkspace') assert.equal(calls.includes('delete-auth'), false);
  }
});
test('cleanup refuses another owner’s files and bounds unproductive providers', async () => {
  const { backend, dependencies, calls } = setup(); backend.files = async () => ['another-owner/private.pdf'];
  const response = await createAccountHandler(dependencies)(request()); assert.equal(response.status, 503);
  assert.equal(calls.includes('remove-storage'), false); assert.equal(calls.includes('delete-auth'), false);
  const stalled = setup(); stalled.backend.files = async () => [`${actor.userId}/same-file`]; stalled.backend.removeFiles = async () => { stalled.calls.push('remove'); };
  assert.equal((await createAccountHandler(stalled.dependencies)(request())).status, 503);
  assert.equal(stalled.calls.filter(call => call === 'remove').length, 40); assert.equal(stalled.calls.includes('delete-auth'), false);
});
test('password throttling is explicit and request errors expose no credentials', async () => {
  const { dependencies, calls } = setup(); dependencies.verifyPassword = async () => { throw new AccountError(429, 'rate_limited'); };
  const response = await createAccountHandler(dependencies)(request()); assert.equal(response.status, 429); assert.equal((await response.json()).code, 'rate_limited'); assert.deepEqual(calls, []);
});

import { accountAuthentication, type AccountAuthClient } from '../supabase/functions/account/auth.ts';
test('password reauthentication uses the verified account email and requires the same confirmed owner', async () => {
  const calls: unknown[] = [];
  const user = { id: actor.userId, email: actor.email, email_confirmed_at: '2026-01-01', is_anonymous: false };
  let returned = user;
  const client: AccountAuthClient = {
    auth: { getUser: async () => ({ data: { user }, error: null }), signInWithPassword: async input => { calls.push(input); return { data: { user: returned }, error: null }; }, signOut: async input => { calls.push(input); } },
    rpc: async () => ({ data: true, error: null }),
  };
  const auth = accountAuthentication(header => { calls.push(header ?? 'fresh-client'); return client; });
  assert.equal(await auth.verifyPassword(actor, 'synthetic'), true);
  assert.deepEqual(calls, ['fresh-client', { email: actor.email, password: 'synthetic' }, { scope: 'local' }]);
  returned = { ...user, id: 'another-owner' }; assert.equal(await auth.verifyPassword(actor, 'synthetic'), false);
  returned = { ...user, email_confirmed_at: '' }; assert.equal(await auth.verifyPassword(actor, 'synthetic'), false);
  returned = { ...user, is_anonymous: true }; assert.equal(await auth.verifyPassword(actor, 'synthetic'), false);
});
test('account deletion authenticates the JWT before reading claims and rejects inactive or mismatched sessions', async () => {
  const user = { id: actor.userId, email: actor.email, email_confirmed_at: '2026-01-01' };
  let active = true; let valid = true; let lookups = 0;
  const client: AccountAuthClient = { auth: {
    getUser: async () => { lookups++; return { data: { user: valid ? user : null }, error: valid ? null : { status: 401 } }; },
    signInWithPassword: async () => ({ data: { user }, error: null }), signOut: async () => undefined,
  }, rpc: async () => ({ data: active, error: null }) };
  const auth = accountAuthentication(() => client);
  const bearer = (sub = actor.userId) => `header.${Buffer.from(JSON.stringify({ sub, session_id: actor.sessionId })).toString('base64url')}.signature`;
  const authorized = (sub?: string) => new Request('https://project.example', { headers: { Authorization: `Bearer ${bearer(sub)}` } });
  assert.deepEqual(await auth.authenticate(authorized()), actor);
  assert.equal(await auth.authenticate(authorized('another-owner')), null);
  active = false; assert.equal(await auth.authenticate(authorized()), null);
  active = true; valid = false; assert.equal(await auth.authenticate(authorized()), null);
  assert.equal(lookups, 4);
});

test('a failed final revocation lookup cannot turn completed account deletion into an impossible sign-in retry', async () => {
  const { dependencies, backend, calls } = setup(); backend.finish = async () => { throw new Error('provider unavailable'); };
  const response = await createAccountHandler(dependencies)(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true, revocationPending: true });
  assert.equal(calls.includes('delete-auth'), true); assert.equal(calls.includes('release'), false);
});
