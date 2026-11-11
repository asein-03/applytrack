import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenCipher, randomSecret, sha256, tokenContext } from '../supabase/functions/gmail/crypto.ts';
import { createGmailHandler, type GmailDependencies } from '../supabase/functions/gmail/handler.ts';
import { boundedJSON, createGmailApi, GMAIL_CALLBACK, GMAIL_SCOPE } from '../supabase/functions/gmail/oauth.ts';
import { GmailHttpError, emptyCursor, type GmailLease } from '../supabase/functions/gmail/shared.ts';
import { GmailStorage } from '../supabase/functions/gmail/storage.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const session = '33333333-3333-4333-8333-333333333333';
const inbox = '44444444-4444-4444-8444-444444444444';
const generation = '55555555-5555-4555-8555-555555555555';
const authPage = 'https://app.example.com/auth/';
const key = () => randomSecret();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function harness(overrides: Partial<GmailDependencies> = {}) {
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  const states = new Map<string, Record<string, unknown>>();
  const saves: Record<string, unknown>[] = [];
  let active = true;
  let selectedUser = owner;
  let saved = false;
  const storage = new GmailStorage({ async rpc(_name, args) {
    const action = args.p_action as string;
    const payload = args.p_payload as Record<string, unknown>;
    calls.push({ action, payload });
    let data: unknown = true;
    if (action === 'create_oauth') states.set(payload.stateHash as string, { ...payload });
    if (action === 'authorize_attempt') data = active && states.has(payload.stateHash as string);
    if (action === 'authorize_oauth') {
      const state = states.get(payload.stateHash as string);
      data = active && state && state.userId === payload.userId && !state.browserHash ? Object.assign(state, { browserHash: payload.browserHash }) : null;
    }
    if (action === 'consume_oauth') {
      const state = states.get(payload.stateHash as string);
      if (active && state && !state.consumed && state.browserHash === payload.browserHash) { state.consumed = true; data = state; }
      else data = null;
    }
    if (action === 'target') data = { id: inbox, existingGeneration: null };
    if (action === 'save_connection') { if (!active) return { data: null, error: { code: '28000' } }; saves.push(payload); saved = true; }
    if (action === 'status') data = saved ? [{ id: inbox, provider: 'gmail', email: 'applicant@example.com', status: 'connected', lastSyncAt: null, connectedAt: new Date().toISOString(), error: null, syncing: true }] : [];
    if (action === 'claim' || action === 'claim_revocation') data = null;
    return { data, error: null };
  } });
  const fetches: string[] = [];
  const cipher = new TokenCipher(key());
  const handler = createGmailHandler({
    config: { clientId: 'test-client', clientSecret: 'synthetic-client-secret', callbackUrl: GMAIL_CALLBACK },
    authPage, authOrigin: new URL(authPage).origin,
    cipher, workerSecret: key(), storage,
    authenticate: async request => request.headers.get('Authorization') === 'Bearer signed-session' && active ? { userId: owner, sessionId: session } : null,
    authenticateBrowser: async () => selectedUser,
    schedule: () => undefined,
    sync: async () => ({ ...emptyCursor(), processed: 0, imported: 0, queued: 0, more: false }),
    fetcher: async input => {
      fetches.push(String(input));
      if (String(input).endsWith('/token')) return json({ access_token: 'synthetic-access-credential', refresh_token: 'synthetic-refresh-credential', expires_in: 3600, scope: GMAIL_SCOPE, token_type: 'Bearer' });
      if (String(input).endsWith('/profile')) return json({ emailAddress: 'applicant@example.com', historyId: '123' });
      throw new Error('Unexpected external request');
    }, ...overrides,
  });
  const post = (body: unknown, authorized = true, origin?: string) => handler(new Request(GMAIL_CALLBACK, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer signed-session' } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }));
  const start = async () => {
    const result = await post({ action: 'connect' });
    assert.equal(result.status, 200);
    return new URL((await result.json()).url).searchParams.get('state')!;
  };
  const authorize = (state: string, origin = new URL(authPage).origin) => handler(new Request(GMAIL_CALLBACK, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: new URLSearchParams({ action: 'browser_authorize', state, email: 'applicant@example.com', password: 'synthetic-password' }) }));
  return { handler, post, start, authorize, calls, fetches, saves, states, cipher, storage, disableSession: () => { active = false; }, chooseOtherUser: () => { selectedUser = other; } };
}

test('token encryption binds owner, connection, generation and purpose', async () => {
  const cipher = new TokenCipher(key());
  const context = tokenContext(owner, inbox, generation);
  const sealed = await cipher.seal({ refreshToken: 'synthetic-refresh-credential' }, context);
  assert(!sealed.includes('synthetic'));
  assert.deepEqual(await cipher.open(sealed, context), { refreshToken: 'synthetic-refresh-credential' });
  for (const changed of [tokenContext(other, inbox, generation), tokenContext(owner, session, generation), tokenContext(owner, inbox, session), ['different-purpose', owner, inbox, generation]]) await assert.rejects(cipher.open(sealed, changed));
  const parts = sealed.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(cipher.open(parts.join('.'), context));
  assert.throws(() => new TokenCipher('short'));
});

test('all inbox operations require an active account session and reject arbitrary origins', async () => {
  const app = harness();
  for (const action of ['connect', 'status', 'sync', 'disconnect']) assert.equal((await app.post({ action, inboxId: inbox }, false)).status, 401);
  assert.equal((await app.post({ action: 'connect' }, true, 'https://untrusted.example.com')).status, 403);
  assert.equal((await app.post({ action: 'work' })).status, 401);
  app.disableSession();
  assert.equal((await app.post({ action: 'status' })).status, 401);
  assert.equal(app.calls.length, 0);
});

test('connection cannot be configured without a trusted browser authentication page', async () => {
  const app = harness({ authPage: null, authOrigin: null });
  assert.equal((await app.post({ action: 'connect' })).status, 503);
  assert.equal((await (await app.post({ action: 'status' })).json()).gmailConfigured, false);
});

test('forwarded authorization links require the same ApplyTrack identity and callback browser', async () => {
  const app = harness();
  const state = await app.start();
  app.chooseOtherUser();
  const mismatch = await app.authorize(state);
  assert.equal(mismatch.status, 303);
  assert.equal(new URL(mismatch.headers.get('Location')!).origin, new URL(authPage).origin);
  assert.equal(mismatch.headers.get('Set-Cookie'), null);
  assert.equal(app.fetches.length, 0);
  const foreignForm = await app.authorize(state, 'https://untrusted.example.com');
  assert.equal(foreignForm.status, 403);
  const nakedCallback = await app.handler(new Request(`${GMAIL_CALLBACK}?state=${state}&code=synthetic-code`));
  assert.equal(nakedCallback.status, 400);
  assert.equal(app.fetches.length, 0);
  assert.equal(app.saves.length, 0);
});

test('valid browser authorization uses PKCE and an HttpOnly cookie; callback is single-use and credential-free', async () => {
  const app = harness();
  const state = await app.start();
  const browser = await app.authorize(state);
  assert.equal(browser.status, 303);
  const google = new URL(browser.headers.get('Location')!);
  assert.equal(google.origin, 'https://accounts.google.com');
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(google.searchParams.get('scope'), GMAIL_SCOPE);
  assert.equal(google.searchParams.get('access_type'), 'offline');
  assert.equal(google.searchParams.get('state'), state);
  assert(!google.href.includes('synthetic-client-secret'));
  const cookie = browser.headers.get('Set-Cookie')!;
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert(cookie.includes(attribute));
  const callbackUrl = `${GMAIL_CALLBACK}?state=${state}&code=synthetic-code`;
  const wrongCookie = await app.handler(new Request(callbackUrl, { headers: { Cookie: cookie.split('=')[0] + '=' + randomSecret() } }));
  assert.equal(wrongCookie.status, 400);
  assert.equal(app.fetches.length, 0);
  const callback = await app.handler(new Request(callbackUrl, { headers: { Cookie: cookie.split(';')[0] } }));
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /Gmail connected/);
  assert.equal(app.saves.length, 1);
  assert.equal(app.saves[0].userId, owner);
  assert(!JSON.stringify(app.saves).includes('synthetic-refresh'));
  assert.equal((await app.handler(new Request(callbackUrl, { headers: { Cookie: cookie.split(';')[0] } }))).status, 400);
  assert.equal(app.saves.length, 1);
  const status = await app.post({ action: 'status' });
  const body = await status.text();
  assert(body.includes('applicant@example.com'));
  assert(!body.includes('tokenCipher'));
  assert(!body.includes('synthetic-refresh'));
});

test('cancel and inactive originating sessions cannot exchange Google credentials', async () => {
  const app = harness();
  const state = await app.start();
  const authorized = await app.authorize(state);
  const cookie = authorized.headers.get('Set-Cookie')!.split(';')[0];
  const canceled = await app.handler(new Request(`${GMAIL_CALLBACK}?state=${state}&error=access_denied&error_description=private-data`, { headers: { Cookie: cookie } }));
  assert.equal(canceled.status, 200);
  assert(!(await canceled.text()).includes('private-data'));
  assert.equal(app.fetches.length, 0);
  const secondState = await app.start();
  const second = await app.authorize(secondState);
  app.disableSession();
  assert.equal((await app.handler(new Request(`${GMAIL_CALLBACK}?state=${secondState}&code=synthetic-code`, { headers: { Cookie: second.headers.get('Set-Cookie')!.split(';')[0] } }))).status, 400);
  assert.equal(app.fetches.length, 0);
});

test('unknown inbox disconnect does not claim another owner revocation', async () => {
  const actions: string[] = [];
  const storage = new GmailStorage({ async rpc(_name, args) { actions.push(args.p_action as string); return { data: null, error: null }; } });
  const app = harness({ storage });
  assert.equal((await app.post({ action: 'disconnect', inboxId: inbox })).status, 404);
  assert.deepEqual(actions, ['disconnect']);
});

test('request streams are bounded before JSON parsing and responses omit raw errors', async () => {
  const app = harness();
  const oversized = await app.post({ action: 'connect', extra: 'x'.repeat(9000) });
  assert.equal(oversized.status, 413);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(8193))); controller.close(); } });
  await assert.rejects(boundedJSON(new Response(stream), 8192), (error: unknown) => error instanceof GmailHttpError && error.code === 'response_too_large');
  const broken = harness({ authenticate: async () => { throw new Error('synthetic-secret-and-private-email'); } });
  assert(!(await (await broken.post({ action: 'status' })).text()).includes('synthetic-secret'));
});

test('Gmail request helper restricts credentials to fixed Google paths and preserves typed 404/oversize errors', async () => {
  const cipher = new TokenCipher(key());
  const lease: GmailLease = { leaseId: session, connection: { ...emptyCursor(), id: inbox, userId: owner, generation, email: 'applicant@example.com', connectedAt: new Date().toISOString(), lastSyncAt: null, syncAfter: new Date().toISOString() }, tokenCipher: '' };
  lease.tokenCipher = await cipher.seal({ accessToken: 'synthetic-access-credential', refreshToken: 'synthetic-refresh-credential', expiresAt: Date.now() + 3600_000, scope: GMAIL_SCOPE }, tokenContext(owner, inbox, generation));
  const calls: string[] = [];
  const storage = new GmailStorage({ async rpc() { return { data: true, error: null }; } });
  const gmail = await createGmailApi({ config: { clientId: 'test', clientSecret: 'synthetic-secret', callbackUrl: GMAIL_CALLBACK }, cipher, storage, lease, signal: AbortSignal.timeout(10_000), fetcher: async input => { calls.push(String(input)); return new Response(null, { status: 404 }); } });
  for (const path of ['https://untrusted.example.com', '//untrusted.example.com', '../messages', 'messages/../../profile', 'messages/a?url=x']) await assert.rejects(gmail.request(path));
  assert.equal(calls.length, 0);
  await assert.rejects(gmail.request('history'), (error: unknown) => error instanceof GmailHttpError && error.status === 404 && error.code === 'unavailable');
  assert.equal(new URL(calls[0]).origin, 'https://gmail.googleapis.com');
  assert.equal((await sha256('same')).length, 64);
});
