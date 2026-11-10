import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Application, CaptureEvent, DocumentFile, Evidence } from '../shared/types.js';
import { Store } from '../server/store.js';
import { ingestEvent, reviewEvidence } from '../server/events.js';
import { MAX_COPY_BYTES, prepareDocumentCapture, attachmentFilename } from '../server/documents.js';
import { cloudFixture, post } from './cloud-fixtures.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const file = (value = 'first resume'): DocumentFile & { contentBase64: string } => ({ kind: 'resume', name: 'Resume.pdf', size: Buffer.byteLength(value), mimeType: 'application/pdf', lastModified: 1000, sha256: sha(value), contentBase64: Buffer.from(value).toString('base64') });
const metadata = (value = 'first resume'): DocumentFile => { const { contentBase64: _, ...rest } = file(value); return rest; };
const capture = (overrides: Partial<CaptureEvent> = {}): CaptureEvent => ({ company: 'Example Labs', role: 'Engineer', source: 'browser', kind: 'document_selected', summary: 'Resume selected', sourceId: 'select-first', document: metadata(), observedAt: '2026-11-10T12:00:00Z', ...overrides });
const result = async (response: Response) => { assert.equal(response.status, 201, await response.clone().text()); return response.json() as Promise<{ application: Application; evidence: Evidence; archiveError?: string }>; };

async function start(f: Awaited<ReturnType<typeof cloudFixture>>) {
  await f.api('/cloud/session', post({ accessToken: 'alice' }));
  await f.api('/sessions', post({ browserEnabled: true, screenEnabled: true }));
}

test('browser selection identifies and archives exact bytes without storing file content in application state', async () => {
  const f = await cloudFixture();
  try {
    assert.equal((await f.api('/events', post(capture({ document: file() })))).status, 409);
    await start(f);
    const selected = await result(await f.api('/events', post(capture({ document: file() }))));
    const document = selected.application.documents![0];
    assert.equal(document.stored, true); assert.equal(document.status, 'selected');
    assert.equal(selected.application.resumeName, 'Resume.pdf'); assert.equal(selected.application.resumeDocumentId, document.id);
    assert.equal(selected.application.stage, 'saved');
    assert.equal(f.files.values.size, 1);
    assert.equal(JSON.stringify(f.transport.states).includes(file().contentBase64), false);
    assert.equal(JSON.stringify([...f.transport.states.values()]).includes('contentBase64'), false);
    assert.deepEqual(f.store.listApplications(), []);
    const duplicate = await result(await f.api('/events', post(capture({ document: file() }))));
    assert.equal(duplicate.evidence.id, selected.evidence.id); assert.equal(duplicate.application.documents?.length, 1); assert.equal(f.files.values.size, 1);
    const download = await f.api(`/applications/${selected.application.id}/documents/${document.id}/file`);
    assert.equal(download.status, 200); assert.equal(await download.text(), 'first resume');
    assert.match(download.headers.get('content-disposition')!, /attachment/);
    assert.equal((await f.api(`/applications/${selected.application.id}/documents/${document.id}/file`, {}, 'bob')).status, 404);
    assert.equal((await f.api(`/applications/${selected.application.id}/documents/missing/file`)).status, 404);
  } finally { await f.close(); }
});

test('same filename with different bytes creates versions and a frozen submission never promotes the newer selection', () => {
  const store = new Store(':memory:');
  try {
    const first = ingestEvent(store, capture());
    const firstId = first.application.documents![0].id;
    const second = ingestEvent(store, capture({ document: metadata('other resume'), sourceId: 'select-second', observedAt: '2026-11-10T12:02:00Z' }));
    const secondId = second.application.resumeDocumentId;
    assert.notEqual(secondId, firstId); assert.equal(second.application.documents?.length, 2);
    assert.equal(second.application.documents?.find(item => item.id === firstId)?.status, 'replaced');
    const lateRemove = ingestEvent(store, capture({ kind: 'document_removed', sourceId: 'remove-old', observedAt: '2026-11-10T12:03:00Z' }));
    assert.equal(lateRemove.application.resumeDocumentId, secondId);
    const pending = ingestEvent(store, capture({ kind: 'submission_pending', document: undefined, documents: [metadata()], sourceId: 'attempt:pending', observedAt: '2026-11-10T12:01:00Z' }));
    assert.equal(pending.application.documents?.find(item => item.id === firstId)?.submittedAt, null);
    const confirmed = ingestEvent(store, capture({ kind: 'submission_confirmed', document: undefined, documents: [metadata()], sourceId: 'attempt:confirmed', observedAt: '2026-11-10T12:04:00Z' }));
    assert.equal(confirmed.application.documents?.find(item => item.id === firstId)?.status, 'submitted');
    assert.equal(confirmed.application.documents?.find(item => item.id === secondId)?.status, 'selected');
    assert.equal(confirmed.application.resumeDocumentId, secondId);
    const removed = ingestEvent(store, capture({ kind: 'document_removed', document: metadata('other resume'), sourceId: 'remove-second', observedAt: '2026-11-10T12:05:00Z' }));
    assert.equal(removed.application.resumeDocumentId, null); assert.equal(removed.application.resumeName, '');
  } finally { store.close(); }
});

test('email, screen evidence and unverified snapshots cannot silently claim which resume was submitted', () => {
  const store = new Store(':memory:');
  try {
    const selected = ingestEvent(store, capture());
    for (const source of ['email', 'visual'] as const) {
      const incoming = ingestEvent(store, capture({ source, kind: 'submission_confirmed', document: undefined, documents: [metadata()], sourceId: source }));
      assert.equal(incoming.application.documents![0].status, 'selected');
    }
    const ambiguous = ingestEvent(store, capture({ kind: 'submission_confirmed', document: undefined, documents: [{ ...metadata(), sha256: null }], requiresReview: true, sourceId: 'missing-fingerprint' }));
    assert.equal(ambiguous.evidence.review, 'pending');
    const reviewed = reviewEvidence(store, ambiguous.evidence.id, 'accept');
    assert.equal(reviewed.documents![0].status, 'selected');
    assert.equal(reviewed.documents![0].id, selected.application.resumeDocumentId);
  } finally { store.close(); }
});

test('manual filename edits detach captured file association and keep historical copies accurate', () => {
  const store = new Store(':memory:');
  try {
    const selected = ingestEvent(store, capture());
    const id = selected.application.documents![0].id;
    const changed = store.updateApplication(selected.application.id, { resumeName: 'Manually entered.pdf' });
    assert.equal(changed.resumeDocumentId, null); assert.equal(changed.documents![0].name, 'Resume.pdf');
    assert.equal(changed.documents![0].id, id);
    const removed = ingestEvent(store, capture({ kind: 'document_removed', sourceId: 'remove' }));
    assert.equal(removed.application.resumeName, 'Manually entered.pdf');
    assert.equal(removed.application.resumeDocumentId, null);
  } finally { store.close(); }
});

test('pending review stores only document metadata, and accepted review attaches the original selection', () => {
  const store = new Store(':memory:');
  try {
    const pending = ingestEvent(store, capture({ document: file(), requiresReview: true }));
    assert.equal(pending.application.documents?.length, 0);
    assert.equal(JSON.stringify(store.listMeta('evidence-document:')).includes('contentBase64'), false);
    const accepted = reviewEvidence(store, pending.evidence.id, 'accept');
    assert.equal(accepted.documents?.length, 1); assert.equal(accepted.documents![0].sha256, file().sha256);
    assert.equal(store.listMeta('evidence-document:').length, 0);
  } finally { store.close(); }
});

test('hash, byte size, copy bounds and event sources are enforced before a cloud record is created', async () => {
  const f = await cloudFixture();
  try {
    await start(f);
    for (const document of [{ ...file(), sha256: 'a'.repeat(64) }, { ...file(), size: 1 }, { ...file(), contentBase64: '**invalid**' }, { ...file(), name: 'run.exe' }]) assert.equal((await f.api('/events', post(capture({ document })))).status, 422);
    assert.equal((await f.api('/events', post(capture({ document: { ...metadata(), size: 26 * 1024 * 1024 } })))).status, 422);
    assert.equal((await f.api('/events', post(capture({ source: 'email' })))).status, 422);
    assert.equal((await f.api('/events', post(capture({ kind: 'document_removed', document: file() })))).status, 422);
    assert.throws(() => prepareDocumentCapture(capture({ document: { ...file(), size: MAX_COPY_BYTES + 1 } })), { status: 413 });
    assert.equal((await (await f.api('/applications')).json()).applications.length, 0);
    assert.equal(f.files.values.size, 0);
    assert.equal(attachmentFilename('../bad\r\nfile.pdf'), '_bad__file.pdf');
  } finally { await f.close(); }
});

test('failed cloud copy is reported honestly and a duplicate delivery can retry it without duplicating evidence', async () => {
  const f = await cloudFixture();
  try {
    await start(f); f.files.failUpload = true;
    const failed = await result(await f.api('/events', post(capture({ document: file() }))));
    assert.equal(failed.application.documents![0].stored, false); assert.ok(failed.archiveError);
    f.files.failUpload = false;
    const retried = await result(await f.api('/events', post(capture({ document: file() }))));
    assert.equal(retried.evidence.id, failed.evidence.id); assert.equal(retried.application.documents![0].stored, true);
    assert.equal(retried.application.evidence.length, 1); assert.equal(f.files.values.size, 1);
  } finally { await f.close(); }
});

test('application deletion removes private copies and retries failed cleanup without losing the deletion request', async () => {
  const f = await cloudFixture();
  try {
    await start(f);
    const selected = await result(await f.api('/events', post(capture({ document: file() }))));
    f.files.failRemove = true;
    assert.equal((await f.api(`/applications/${selected.application.id}`, { method: 'DELETE' })).status, 502);
    assert.equal((await (await f.api('/applications')).json()).applications.length, 0);
    assert.equal(f.files.values.size, 1);
    assert.ok(f.transport.states.get(f.cloud.actors.get('alice')!.id)!.state.metadata.some(row => row.key.startsWith('document-deletion:')));
    f.files.failRemove = false;
    assert.equal((await f.api(`/applications/${selected.application.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(f.files.values.size, 0);
    assert.equal(f.transport.states.get(f.cloud.actors.get('alice')!.id)!.state.metadata.some(row => row.key.startsWith('document-deletion:')), false);
  } finally { await f.close(); }
});


test('an upload finishing after concurrent application deletion cannot leave an orphaned private copy', async () => {
  const f = await cloudFixture();
  let releaseUpload!: () => void;
  let uploadStarted!: () => void;
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  const wait = new Promise<void>(resolve => { releaseUpload = resolve; });
  try {
    await start(f);
    f.files.beforeUpload = async () => { uploadStarted(); await wait; };
    const uploading = f.api('/events', post(capture({ document: file() })));
    await started;
    const app = f.transport.states.get(f.cloud.actors.get('alice')!.id)!.state.applications[0];
    assert.equal((await f.api(`/applications/${app.id}`, { method: 'DELETE' })).status, 204);
    releaseUpload();
    const finished = await result(await uploading);
    assert.ok(finished.archiveError);
    assert.equal((await f.api('/events', post(capture({ document: file() })))).status, 410);
    assert.equal(f.files.values.size, 0);
    assert.equal((await (await f.api('/applications')).json()).applications.length, 0);
  } finally { releaseUpload?.(); await f.close(); }
});
