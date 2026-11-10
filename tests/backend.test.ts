import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Application, CaptureEvent, Evidence, Task } from '../shared/types.js';

async function withServer(run: (api: (path: string, options?: RequestInit) => Promise<Response>, base: string) => Promise<void>, dbPath = ':memory:') {
  const { app, close } = createApp({ dbPath });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, options: RequestInit = {}) => fetch(base + '/api' + path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  try { await run(api, base); } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); close(); }
}
const body = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
const appInput = { company: 'Test Company', role: 'Test Analyst', email: 'person@example.com' };
const event = (overrides: Partial<CaptureEvent> = {}): CaptureEvent => ({ ...appInput, source: 'browser', kind: 'submission_confirmed', summary: 'Application received', sourceId: 'test-confirmation', ...overrides });

test('personal workspace starts empty and is isolated from fictional demo data', async () => {
  await withServer(async api => {
    assert.deepEqual((await (await api('/applications')).json()).applications, []);
    const demo = (await (await api('/applications?workspace=demo')).json()).applications as Application[];
    assert.equal(demo.length, 9);
    assert.ok(demo.every(record => record.workspace === 'demo'));
    assert.equal((await api('/applications?workspace=unknown')).status, 422);
  });
});

test('applications, tasks and edits survive a complete store restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'applytrack-'));
  const dbPath = join(directory, 'test.sqlite');
  let applicationId = '';
  let taskId = '';
  try {
    await withServer(async api => {
      const response = await api('/applications', body(appInput));
      assert.equal(response.status, 201);
      const application = await response.json() as Application;
      applicationId = application.id;
      const task = await (await api(`/applications/${applicationId}/tasks`, body({ title: 'Complete assessment', dueAt: '2026-11-14T17:00:00-05:00' }))).json() as Task;
      taskId = task.id;
      assert.equal(task.dueAt, '2026-11-14T17:00:00-05:00');
      assert.equal((await api(`/applications/${applicationId}`, { method: 'PATCH', body: JSON.stringify({ notes: 'Remember the role details', stage: 'applied' }) })).status, 200);
      assert.equal((await api(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ completedAt: '2026-11-12T15:00:00Z' }) })).status, 200);
      await api('/sessions', body({ browserEnabled: true, screenEnabled: true }));
    }, dbPath);
    await withServer(async api => {
      const application = await (await api(`/applications/${applicationId}`)).json() as Application;
      assert.equal(application.notes, 'Remember the role details');
      assert.equal(application.stage, 'applied');
      assert.equal(application.tasks[0].id, taskId);
      assert.equal(application.tasks[0].completedAt, '2026-11-12T15:00:00Z');
      assert.equal((await (await api('/sessions/current')).json()).session, null);
    }, dbPath);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('capture requires a session, clicks remain pending, confirmation deduplicates and does not regress', async () => {
  await withServer(async api => {
    assert.equal((await api('/events', body(event()))).status, 409);
    await api('/sessions', body({ browserEnabled: true, screenEnabled: false }));
    const pending = await (await api('/events', body(event({ kind: 'submission_pending', sourceId: 'click' })))).json() as { application: Application };
    assert.equal(pending.application.stage, 'in_progress');
    assert.equal(pending.application.appliedAt, null);
    const confirmed = await (await api('/events', body(event()))).json() as { application: Application; evidence: Evidence };
    assert.equal(confirmed.application.id, pending.application.id);
    assert.equal(confirmed.application.stage, 'applied');
    const repeat = await (await api('/events', body(event()))).json() as typeof confirmed;
    assert.equal(repeat.evidence.id, confirmed.evidence.id);
    assert.equal(repeat.application.evidence.length, 2);
    await api('/events', body(event({ source: 'email', kind: 'interview', sourceId: 'email-interview' })));
    const late = await (await api('/events', body(event({ source: 'email', sourceId: 'email-late-confirmation' })))).json() as typeof confirmed;
    assert.equal(late.application.stage, 'interviewing');
    assert.equal(late.application.evidence.filter(item => item.source === 'email').length, 2);
    assert.equal((await api('/events', body(event({ source: 'visual', sourceId: 'visual' })))).status, 409);
  });
});

test('uncertain evidence does not change state until reviewed; review is idempotence-safe', async () => {
  await withServer(async api => {
    const response = await api('/events', body(event({ source: 'email', kind: 'assessment_requested', requiresReview: true, task: { title: 'Complete test', dueAt: '2026-11-20T17:00:00Z' } })));
    assert.equal(response.status, 201);
    const { application, evidence } = await response.json() as { application: Application; evidence: Evidence };
    assert.equal(application.stage, 'saved');
    assert.equal(application.tasks.length, 0);
    assert.equal(evidence.review, 'pending');
    const accepted = await (await api(`/evidence/${evidence.id}/review`, body({ action: 'accept' }))).json() as Application;
    assert.equal(accepted.stage, 'assessment');
    assert.equal(accepted.tasks.length, 1);
    assert.equal((await api(`/evidence/${evidence.id}/review`, body({ action: 'accept' }))).status, 409);
    assert.equal((await api(`/evidence/${evidence.id}/review`, body({ action: 'dismiss' }))).status, 409);
  });
});

test('conflicting terminal outcomes require review and explicit approval can correct them', async () => {
  await withServer(async api => {
    const offer = await (await api('/events', body(event({ source: 'email', kind: 'offer', sourceId: 'offer' })))).json() as { application: Application };
    assert.equal(offer.application.stage, 'offer');
    const conflict = await (await api('/events', body(event({ source: 'email', kind: 'rejection', sourceId: 'rejected' })))).json() as { application: Application; evidence: Evidence };
    assert.equal(conflict.application.stage, 'offer');
    assert.equal(conflict.evidence.review, 'pending');
    const corrected = await (await api(`/evidence/${conflict.evidence.id}/review`, body({ action: 'accept' }))).json() as Application;
    assert.equal(corrected.stage, 'rejected');
  });
});

test('ambiguous roles require assignment and distinct job IDs never merge', async () => {
  await withServer(async api => {
    for (const jobId of ['role-a', 'role-b']) await api('/applications', body({ ...appInput, jobId }));
    assert.equal((await api('/events', body(event({ source: 'email' })))).status, 409);
    const exact = await (await api('/events', body(event({ source: 'email', jobId: 'role-b' })))).json() as { application: Application };
    assert.equal(exact.application.jobId, 'role-b');
    assert.equal(exact.application.stage, 'applied');
    const different = await (await api('/events', body(event({ source: 'email', jobId: 'role-c', sourceId: 'third' })))).json() as { application: Application };
    assert.equal(different.application.jobId, 'role-c');
    assert.equal((await (await api('/applications')).json()).applications.length, 3);
    assert.equal((await api('/events', body({ source: 'email', kind: 'interview', summary: 'Interview request', company: 'Test Company' }))).status, 422);
  });
});

test('workspace cannot be crossed through an explicit evidence application ID', async () => {
  await withServer(async api => {
    const demo = (await (await api('/applications?workspace=demo')).json()).applications as Application[];
    assert.equal((await api('/events', body(event({ applicationId: demo[0].id, source: 'email' })))).status, 409);
  });
});

test('local origin, host, JSON and extension pairing boundaries are enforced', async () => {
  await withServer(async (api, base) => {
    assert.equal((await api('/settings', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await api('/settings', { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await api('/applications', { method: 'POST', body: JSON.stringify(appInput), headers: { 'Content-Type': 'text/plain' } })).status, 415);
    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
    assert.equal((await api('/pairing', { headers: { Origin: extensionOrigin } })).status, 401);
    const { token } = await (await api('/pairing')).json();
    assert.equal((await api('/settings', { headers: { Origin: extensionOrigin, Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await api('/settings', { headers: { Origin: extensionOrigin, Authorization: `Bearer ${'é'.repeat(64)}` } })).status, 401);
    const preflight = await fetch(base + '/api/events', { method: 'OPTIONS', headers: { Origin: extensionOrigin, 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), extensionOrigin);
  });
});

test('CSV export escapes formulas and quoting; unsafe links and images are rejected', async () => {
  await withServer(async api => {
    await api('/applications', body({ company: '=HYPERLINK("https://evil.example")', role: 'Analyst, "Research"', notes: '+SUM(1,1)' }));
    const csv = await (await api('/export')).text();
    assert.ok(csv.includes('"\'=HYPERLINK(""https://evil.example"")"'));
    assert.ok(csv.includes('"Analyst, ""Research"""'));
    assert.ok(csv.includes('"\'+SUM(1,1)"'));
    assert.equal((await api('/applications', body({ ...appInput, url: 'javascript:alert(1)' }))).status, 422);
    assert.equal((await api('/events', body(event({ source: 'email', snapshot: 'data:image/svg+xml;base64,PHN2Zz4=' })))).status, 422);
    assert.equal((await api('/applications', body({ ...appInput, unexpectedField: 'secret' }))).status, 422);
    assert.equal((await api('/applications', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  });
});
