import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { apiErrorHandler, createApp } from '../server/app.js';
import { attachEmailRoutes, extractBody } from '../server/email.js';
import { explicitDeadline } from '../server/email-parser.js';
import type { Application, Evidence } from '../shared/types.js';

async function withEmailServer(run: (api: (path: string, options?: RequestInit) => Promise<Response>, store: ReturnType<typeof createApp>['store']) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'applytrack-email-'));
  const { app, store, close } = createApp({ dbPath: ':memory:' });
  const email = attachEmailRoutes(app, store, { dataDir: directory, poll: false });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, options: RequestInit = {}) => fetch(base + '/api' + path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try { await run(api, store); }
  finally { email.stop(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); close(); rmSync(directory, { recursive: true, force: true }); }
}
const post = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });

test('manual imports queue unmatched mail, support explicit assignment, and deduplicate', async () => {
  await withEmailServer(async api => {
    const text = 'Subject: Assessment invitation\nFrom: recruiting@example.com\nPlease complete your assessment. Deadline: 2026-11-14T23:00:00-05:00';
    const queued = await (await api('/email/import', post({ text }))).json() as { queued: boolean; id: string };
    assert.equal(queued.queued, true);
    assert.equal((await (await api('/email/review')).json()).items.length, 1);
    const application = await (await api('/applications', post({ company: 'Test Employer', role: 'Analyst' }))).json() as Application;
    const assignedResponse = await api(`/email/review/${queued.id}/assign`, post({ applicationId: application.id }));
    assert.equal(assignedResponse.status, 200);
    const assigned = await assignedResponse.json() as { application: Application; evidence: Evidence };
    assert.equal(assigned.application.id, application.id);
    assert.equal(assigned.application.stage, 'assessment');
    assert.equal(assigned.application.tasks.length, 1);
    assert.equal(assigned.application.tasks[0].dueAt, '2026-11-14T23:00:00-05:00');
    assert.equal((await (await api('/email/review')).json()).items.length, 0);
    const duplicate = await (await api('/email/import', post({ text, applicationId: application.id }))).json() as typeof assigned;
    assert.equal(duplicate.evidence.id, assigned.evidence.id);
    assert.equal(duplicate.application.tasks.length, 1);
    assert.equal(duplicate.application.evidence.length, 1);
  });
});

test('identical imported emails remain isolated in personal and demo review queues', async () => {
  await withEmailServer(async api => {
    const text = 'Subject: Next steps\nPlease complete your assessment.';
    const personal = await (await api('/email/import', post({ text, workspace: 'personal' }))).json();
    const demo = await (await api('/email/import', post({ text, workspace: 'demo' }))).json();
    assert.notEqual(personal.id, demo.id);
    assert.equal((await (await api('/email/review?workspace=personal')).json()).items.length, 1);
    assert.equal((await (await api('/email/review?workspace=demo')).json()).items.length, 1);
    const records = (await (await api('/applications?workspace=demo')).json()).applications as Application[];
    assert.equal((await api(`/email/review/${personal.id}/assign`, post({ applicationId: records[0].id }))).status, 409);
    assert.equal((await (await api('/email/review?workspace=personal')).json()).items.length, 1);
    assert.equal((await api(`/email/review/${personal.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await (await api('/email/review?workspace=demo')).json()).items.length, 1);
  });
});

test('explicit assignment applies a queued remote message once', async () => {
  await withEmailServer(async (api, store) => {
    const application = await (await api('/applications', post({ company: 'Northstar', role: 'Analyst' }))).json() as Application;
    store.setMeta('email-review:remote-review', { id: 'remote-review', originalId: 'remote-message', subject: 'Assessment invitation', from: 'unverified@example.test', body: 'Please complete your assessment. Deadline: 2026-11-14', receivedAt: new Date().toISOString(), workspace: 'personal', inboxId: 'synthetic-inbox' });
    assert.equal((await (await api(`/applications/${application.id}`)).json()).stage, 'saved');
    const response = await api('/email/review/remote-review/assign', post({ applicationId: application.id }));
    assert.equal(response.status, 200);
    const accepted = await response.json();
    assert.equal(accepted.evidence.review, 'accepted');
    assert.equal(accepted.application.stage, 'assessment');
    assert.equal(accepted.application.tasks.length, 1);
    assert.equal((await api('/email/review/remote-review/assign', post({ applicationId: application.id }))).status, 404);
    assert.equal((await (await api(`/applications/${application.id}`)).json()).tasks.length, 1);
  });
});

test('Gmail setup state is honest and callback requires the state cookie', async () => {
  const previousId = process.env.GOOGLE_CLIENT_ID;
  const previousSecret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    await withEmailServer(async api => {
      assert.deepEqual(await (await api('/inboxes')).json(), { inboxes: [], gmailConfigured: false });
      assert.equal((await api('/inboxes/google/connect', post({}))).status, 503);
      const invalidCallback = await api('/inboxes/google/callback?state=invalid&code=invalid', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(invalidCallback.status, 400);
      assert.match((await invalidCallback.json()).error, /expired/i);
      assert.equal((await api('/settings', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      assert.equal((await api('/inboxes/google/callback?state=invalid', { headers: { Origin: 'https://evil.example' } })).status, 403);
    });
  } finally {
    if (previousId !== undefined) process.env.GOOGLE_CLIENT_ID = previousId;
    if (previousSecret !== undefined) process.env.GOOGLE_CLIENT_SECRET = previousSecret;
  }
});

test('MIME alternatives prefer plain text once, HTML is a fallback, attachments are excluded', () => {
  const encode = (value: string) => Buffer.from(value).toString('base64url');
  assert.equal(extractBody({ mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { data: encode('Your application was received.') } },
    { mimeType: 'text/html', body: { data: encode('<p>Your application was received.</p>') } },
  ] }), 'Your application was received.');
  assert.match(extractBody({ mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: {} },
    { mimeType: 'text/html', body: { data: encode('<p>Please complete your assessment.</p>') } },
  ] }), /Please complete your assessment/);
  assert.equal(extractBody({ mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { data: encode('Thanks for applying.') } },
    { mimeType: 'text/plain', filename: 'old-email.txt', body: { data: encode('We are not moving forward.') } },
  ] }), 'Thanks for applying.');
  assert.equal(extractBody({ mimeType: 'text/html', body: { data: encode('Please confirm your availability.<blockquote>We are not moving forward.<blockquote>Earlier history.</blockquote>More quoted history.</blockquote>') } }).trim(), 'Please confirm your availability.');
});

test('deadline extraction preserves explicit timezones across UTC day boundaries', () => {
  assert.equal(explicitDeadline('Deadline: 2026-11-14T23:00:00-05:00'), '2026-11-14T23:00:00-05:00');
  assert.equal(explicitDeadline('Due: 2026-11-14T01:00:00+09:00'), '2026-11-14T01:00:00+09:00');
  assert.equal(explicitDeadline('Due: 2026-02-30T23:00:00-05:00'), null);
  assert.equal(explicitDeadline('Due: 2026-11-14T17:00:00'), null);
});

test('remote MIME and HTML parsing stops at bounded bytes and part counts', () => {
  const encode = (value: string) => Buffer.from(value).toString('base64url');
  const plain = { mimeType: 'text/plain', body: { data: encode('a'.repeat(80_000) + 'OUTSIDE_LIMIT') } };
  assert.equal(extractBody(plain).length, 64_000);
  assert.equal(extractBody({ mimeType: 'multipart/mixed', parts: Array.from({ length: 300 }, () => plain) }).length, 64_000);
  const parts = Array.from({ length: 300 }, () => ({ mimeType: 'text/plain', body: { data: '' } }));
  Object.defineProperty(parts[250], 'body', { get() { throw new Error('Visited a MIME part beyond the limit.'); } });
  assert.equal(extractBody({ mimeType: 'multipart/mixed', parts }), '');
  const malformed = '<script>'.repeat(48_000) + 'OUTSIDE_LIMIT';
  assert.equal(extractBody({ mimeType: 'text/html', body: { data: encode(malformed) } }), '');
});

test('HTML extraction preserves useful links but excludes executable and quoted text', () => {
  const html = '<p>Current message.</p><script>application rejected</script><style>application rejected</style><!-- application rejected --><blockquote>Old outcome<blockquote>Older outcome</blockquote></blockquote><a title="value > text" href="https://assessment.example.test/?a=1&amp;b=2">Assessment</a><a href="javascript:alert(1)">Unsafe link</a><p>End.</p>';
  const text = extractBody({ mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } });
  assert.match(text, /Current message\./);
  assert.match(text, /Assessment https:\/\/assessment\.example\.test\/\?a=1&b=2/);
  assert.match(text, /End\./);
  assert.doesNotMatch(text, /rejected|Old outcome|Older outcome|javascript|alert\(1\)/);
  assert.equal(extractBody({ mimeType: 'text/html', body: { data: Buffer.from('<script>inert</scripture>Also inert').toString('base64url') } }), '');
});

test('oversized and malformed Google responses stop safely without exposing response content', async () => {
  const priorId = process.env.GOOGLE_CLIENT_ID; const priorSecret = process.env.GOOGLE_CLIENT_SECRET;
  const originalFetch = globalThis.fetch;
  process.env.GOOGLE_CLIENT_ID = 'synthetic-client'; process.env.GOOGLE_CLIENT_SECRET = 'synthetic-client-secret';
  try {
    for (const body of ['x'.repeat(2 * 1024 * 1024 + 1), '{"access_token":"private-synthetic-token"']) {
      globalThis.fetch = async (input, init) => String(input) === 'https://oauth2.googleapis.com/token' ? new Response(body, { status: 200 }) : originalFetch(input, init);
      await withEmailServer(async api => {
        const connected = await api('/inboxes/google/connect', post({}));
        const { url } = await connected.json();
        const state = new URL(url).searchParams.get('state');
        const cookie = connected.headers.get('set-cookie')!.split(';')[0];
        const response = await api(`/inboxes/google/callback?state=${state}&code=synthetic-code`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 502);
        const error = await response.text();
        assert.match(error, /larger than 2 MB|invalid response/);
        assert.doesNotMatch(error, /private-synthetic-token|synthetic-client-secret/);
        assert.deepEqual((await (await api('/inboxes')).json()).inboxes, []);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (priorId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = priorId;
    if (priorSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = priorSecret;
  }
});
