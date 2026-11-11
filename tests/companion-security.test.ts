import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudFixture, post } from './cloud-fixtures.js';

test('companion tokens cannot export personal records, read email or files, or mutate dashboard data', async () => {
  const f = await cloudFixture();
  try {
    await f.api('/cloud/session', post({ accessToken: 'alice' }));
    const token = f.store.getMeta<string>('extensionToken')!;
    const application = await (await f.api('/applications', post({ company: 'Example', role: 'Engineer', notes: 'Private interview notes', email: 'private@example.test' }))).json();
    for (const origin of [undefined, `chrome-extension://${'a'.repeat(32)}`, 'http://localhost:5173']) {
      const headers: Record<string, string> = origin ? { Origin: origin } : {};
      for (const path of ['/export', '/applications', `/applications/${application.id}`, '/email/review', '/settings', '/pairing', '/documents', '/reminders', `/applications/${application.id}/documents/unknown/file`]) assert.equal((await f.api(path, { headers }, token)).status, 403, path);
      assert.equal((await f.api(`/applications/${application.id}`, { method: 'DELETE', headers }, token)).status, 403);
      assert.equal((await f.api('/reminders/preferences', { method: 'PATCH', headers, body: JSON.stringify({ enabled: true }) }, token)).status, 403);
    }
    assert.equal((await f.api('/sessions', post({ browserEnabled: true, screenEnabled: true }), token)).status, 403);
    assert.equal((await f.api('/sessions', post({ browserEnabled: true, screenEnabled: false }), token)).status, 201);
    const event = { company: 'Example', role: 'Engineer', summary: 'Application submitted', sourceId: 'synthetic-confirmation', source: 'browser', kind: 'submission_confirmed' };
    const result = await f.api('/events', post(event), token);
    assert.equal(result.status, 201);
    const capture = await result.json();
    assert.deepEqual(Object.keys(capture.application).sort(), ['documents', 'id']);
    assert(!JSON.stringify(capture).includes('Private interview notes'));
    assert(!JSON.stringify(capture).includes('private@example.test'));
    for (const patch of [{ source: 'email' }, { source: 'visual' }, { kind: 'offer' }, { applicationId: application.id }, { workspace: 'demo' }]) assert.equal((await f.api('/events', post({ ...event, ...patch }), token)).status, 403);
    assert.equal((await f.api('/events', post({ company: 'Saved company', role: 'Analyst', source: 'manual', kind: 'note', summary: 'Job saved from the browser' }), token)).status, 201);
    assert.equal((await f.api('/sessions/current', { method: 'DELETE' }, token)).status, 204);
    assert.equal((await f.api(`/applications/${application.id}`)).status, 200);
  } finally { await f.close(); }
});
