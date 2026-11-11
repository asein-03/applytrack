import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ApplicationDocument, Workspace } from '../shared/types.js';
import type { LibraryDocument } from '../shared/library.js';
import { Store } from '../server/store.js';
import { libraryDocumentId, listLibraryDocuments } from '../server/library.js';
import { cloudFixture } from './cloud-fixtures.js';

const file = (overrides: Partial<ApplicationDocument> = {}): ApplicationDocument => ({ id: randomUUID(), kind: 'resume', name: 'Resume.pdf', size: 2048, mimeType: 'application/pdf', lastModified: 1000, sha256: 'a'.repeat(64), detectedAt: '2026-11-10T12:00:00Z', status: 'selected', submittedAt: null, stored: true, ...overrides });
function record(store: Store, company: string, documents: ApplicationDocument[], workspace: Workspace = 'personal') {
  const application = store.createApplication({ company, role: 'Designer', workspace, notes: 'Private note, excluded from library' });
  application.documents = documents;
  application.resumeDocumentId = documents.find(document => document.kind === 'resume')?.id ?? null;
  store.saveApplication(application);
  return application;
}

test('library groups exact versions across applications without merging unknown fingerprints or different document kinds', () => {
  const store = new Store(':memory:');
  try {
    const first = file({ status: 'submitted', submittedAt: '2026-11-10T12:05:00Z' });
    const reselected = file({ stored: false, detectedAt: '2026-11-10T12:10:00Z' });
    const renamed = file({ name: 'Product-design.pdf', detectedAt: '2026-11-10T13:00:00Z' });
    const changed = file({ sha256: 'b'.repeat(64), detectedAt: '2026-11-10T14:00:00Z' });
    const metadata = file({ sha256: null, stored: false });
    const a = record(store, 'Acme', [first, reselected, changed, metadata]);
    const b = record(store, 'Studio', [renamed, file({ ...metadata, id: randomUUID() }), file({ kind: 'cover_letter' })]);
    const documents = listLibraryDocuments(store, 'personal');
    assert.equal(documents.length, 5);
    const grouped = documents.find(document => document.id === libraryDocumentId(a.id, first))!;
    assert.deepEqual(grouped.names, ['Product-design.pdf', 'Resume.pdf']);
    assert.equal(grouped.usages.length, 2);
    assert.equal(grouped.usages.find(usage => usage.applicationId === a.id)?.documentId, first.id);
    assert.equal(grouped.usages.find(usage => usage.applicationId === a.id)?.submittedAt, first.submittedAt);
    assert.equal(grouped.usages.find(usage => usage.applicationId === b.id)?.documentId, renamed.id);
    assert.equal(grouped.firstDetectedAt, first.detectedAt);
    assert.equal(grouped.lastDetectedAt, renamed.detectedAt);
    assert.equal(documents[0].sha256, changed.sha256);
    assert.equal(documents.filter(document => !document.sha256).length, 2);
    assert.equal(JSON.stringify(documents).includes('Private note'), false);
  } finally { store.close(); }
});

test('library labels live in the account workspace and never rename captured files or cross users', async () => {
  const f = await cloudFixture();
  try {
    const actor = await f.cloud.verify('alice');
    let applicationId = '';
    const captured = file();
    await f.repository.run('personal', actor, true, data => { applicationId = record(data, 'Private Company', [captured]).id; });
    const response = await f.api('/documents?workspace=personal');
    assert.equal(response.status, 200);
    const { documents } = await response.json() as { documents: LibraryDocument[] };
    assert.equal(documents.length, 1);
    const id = documents[0].id;
    const updated = await f.api(`/documents/${id}?workspace=personal`, { method: 'PATCH', body: JSON.stringify({ label: '  Product design  ' }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).label, 'Product design');
    assert.equal((await (await f.api('/documents')).json()).documents[0].label, 'Product design');
    const application = await f.repository.run('personal', actor, false, data => data.requireApplication(applicationId));
    assert.equal(application.documents![0].name, 'Resume.pdf');
    assert.equal(application.documents![0].sha256, captured.sha256);
    assert.equal(application.resumeDocumentId, captured.id);
    assert.equal(f.store.listMeta('document-label:').length, 0);
    assert.equal((await f.api('/documents', {}, null)).status, 401);
    assert.deepEqual((await (await f.api('/documents', {}, 'bob')).json()).documents, []);
    assert.equal((await f.api(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ label: 'Wrong owner' }) }, 'bob')).status, 404);
    const cleared = await f.api(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ label: '' }) });
    assert.equal(cleared.status, 200);
    assert.equal((await (await f.api('/documents')).json()).documents[0].label, '');
  } finally { await f.close(); }
});

test('library demo labels and personal labels remain separate even when the file fingerprint matches', async () => {
  const f = await cloudFixture();
  try {
    const captured = file();
    const actor = await f.cloud.verify('alice');
    const demo = record(f.store, 'Demo document', [captured], 'demo');
    await f.repository.run('personal', actor, true, data => record(data, 'Personal document', [captured]));
    const id = libraryDocumentId(demo.id, captured);
    assert.equal((await f.api(`/documents/${id}?workspace=demo`, { method: 'PATCH', body: JSON.stringify({ label: 'Sample only' }) })).status, 200);
    assert.equal((await (await f.api('/documents?workspace=demo')).json()).documents[0].label, 'Sample only');
    assert.equal((await (await f.api('/documents?workspace=personal')).json()).documents[0].label, '');
  } finally { await f.close(); }
});

test('label updates reject malformed input and missing documents without accepting new application data', async () => {
  const f = await cloudFixture();
  try {
    const actor = await f.cloud.verify('alice');
    const captured = file();
    const application = await f.repository.run('personal', actor, true, data => record(data, 'Label validation', [captured]));
    const path = `/documents/${libraryDocumentId(application.id, captured)}`;
    for (const label of ['a'.repeat(121), 'Label\nControl', 42]) assert.equal((await f.api(path, { method: 'PATCH', body: JSON.stringify({ label }) })).status, 422);
    assert.equal((await f.api(path, { method: 'PATCH', body: JSON.stringify({ label: 'Valid', name: 'Renamed.pdf' }) })).status, 422);
    assert.equal((await f.api('/documents?workspace=other')).status, 422);
    assert.equal((await f.api('/documents/not-an-id', { method: 'PATCH', body: JSON.stringify({ label: 'Missing' }) })).status, 404);
    assert.equal((await f.api(`/applications/${application.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await f.api(path, { method: 'PATCH', body: JSON.stringify({ label: 'Gone' }) })).status, 404);
  } finally { await f.close(); }
});
