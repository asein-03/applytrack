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

async function withEmailServer(run: (api: (path: string, options?: RequestInit) => Promise<Response>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'applytrack-email-'));
  const { app, store, close } = createApp({ dbPath: ':memory:' });
  const email = attachEmailRoutes(app, store, { dataDir: directory, poll: false });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, options: RequestInit = {}) => fetch(base + '/api' + path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try { await run(api); }
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
});

test('deadline extraction preserves explicit timezones across UTC day boundaries', () => {
  assert.equal(explicitDeadline('Deadline: 2026-11-14T23:00:00-05:00'), '2026-11-14T23:00:00-05:00');
  assert.equal(explicitDeadline('Due: 2026-11-14T01:00:00+09:00'), '2026-11-14T01:00:00+09:00');
  assert.equal(explicitDeadline('Due: 2026-02-30T23:00:00-05:00'), null);
  assert.equal(explicitDeadline('Due: 2026-11-14T17:00:00'), null);
});
