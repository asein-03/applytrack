import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { signDispatch, verifyDispatch } from '../supabase/functions/gmail/dispatch.ts';
import { randomSecret, sha256, TokenCipher } from '../supabase/functions/gmail/crypto.ts';
import { createGmailHandler } from '../supabase/functions/gmail/handler.ts';
import { GmailStorage } from '../supabase/functions/gmail/storage.ts';
import { emptyCursor } from '../supabase/functions/gmail/shared.ts';
import { GMAIL_CALLBACK } from '../supabase/functions/gmail/oauth.ts';

const secret = randomSecret();
const nonce = () => randomBytes(32).toString('hex');
async function signedHeaders(issuedAt: number, ticket: string) {
  return { 'Content-Type': 'application/json', 'X-Apply-Gmail-Dispatch-Version': '1', 'X-Apply-Gmail-Timestamp': String(issuedAt), 'X-Apply-Gmail-Nonce': ticket, 'X-Apply-Gmail-Signature': await signDispatch(secret, issuedAt, ticket) };
}
const request = (headers: Record<string, string>, path = GMAIL_CALLBACK) => new Request(path, { method: 'POST', headers, body: JSON.stringify({ action: 'work' }) });

test('dispatch uses HMAC over a fixed purpose, method, path, action, timestamp and nonce', async () => {
  const issuedAt = 1_800_000_000;
  const ticket = nonce();
  const expected = createHmac('sha256', secret).update(`applytrack-gmail-dispatch-v1\nPOST\n/functions/v1/gmail\nwork\n${issuedAt}\n${ticket}`).digest('hex');
  assert.equal(await signDispatch(secret, issuedAt, ticket), expected);
  assert(!JSON.stringify(await signedHeaders(issuedAt, ticket)).includes(secret));
});

test('only fresh, signed, one-use tickets reach the atomic database consume', async () => {
  const now = Date.now();
  const issuedAt = Math.floor(now / 1000);
  const ticket = nonce();
  const headers = await signedHeaders(issuedAt, ticket);
  let used = false;
  let calls = 0;
  const consume = async (hash: string, time: number) => {
    calls++;
    assert.equal(hash, await sha256(ticket));
    assert.equal(time, issuedAt);
    if (used) return false;
    used = true;
    return true;
  };
  for (const malformed of [
    { ...headers, 'X-Apply-Gmail-Nonce': nonce() },
    { ...headers, 'X-Apply-Gmail-Timestamp': String(issuedAt - 1) },
    { ...headers, 'X-Apply-Gmail-Signature': '0'.repeat(64) },
    { ...headers, 'X-Apply-Gmail-Dispatch-Version': '2' },
    { ...headers, 'X-Apply-Gmail-Worker': secret },
  ]) assert.equal(await verifyDispatch(request(malformed), secret, consume, now), false);
  assert.equal(await verifyDispatch(request(headers, `${GMAIL_CALLBACK}/other`), secret, consume, now), false);
  assert.equal(await verifyDispatch(request(await signedHeaders(issuedAt - 91, ticket)), secret, consume, now), false);
  assert.equal(await verifyDispatch(request(await signedHeaders(issuedAt + 16, ticket)), secret, consume, now), false);
  assert.equal(calls, 0);
  assert.equal(await verifyDispatch(request(headers, 'https://edge.example.com/gmail'), secret, consume, now), true);
  assert.equal(await verifyDispatch(request(headers), secret, consume, now), false);
  assert.equal(calls, 2);
});

test('the hosted worker retires reusable-secret headers and accepts each dispatch once', async () => {
  const pending = new Set<string>();
  const work: Promise<unknown>[] = [];
  const storage = new GmailStorage({ async rpc(name, args) {
    if (name === 'apply_gmail_consume_dispatch') return { data: pending.delete(args.p_nonce_hash as string), error: null };
    return { data: null, error: null };
  } });
  const handler = createGmailHandler({ config: { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret', callbackUrl: GMAIL_CALLBACK }, authPage: 'https://app.example.com/auth/', authOrigin: 'https://app.example.com', workerSecret: secret, cipher: new TokenCipher(randomSecret()), storage,
    authenticate: async () => null, authenticateBrowser: async () => null,
    sync: async () => ({ ...emptyCursor(), processed: 0, imported: 0, queued: 0, more: false }), schedule: promise => work.push(promise),
  });
  assert.equal((await handler(request({ 'Content-Type': 'application/json', 'X-Apply-Gmail-Worker': secret }))).status, 401);
  const ticket = nonce();
  const headers = await signedHeaders(Math.floor(Date.now() / 1000), ticket);
  pending.add(await sha256(ticket));
  const response = await handler(request(headers));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal((await handler(request(headers))).status, 401);
  await Promise.all(work);
});
