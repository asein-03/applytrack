import { createHash, randomUUID } from 'node:crypto';
import type { Application, ApplicationDocument, CaptureEvent, DocumentFile, Evidence } from '../shared/types.js';
import { HttpError } from './store.js';
import { DOCUMENT_BUCKET, type CloudActor, type WorkspaceRepository } from './cloud.js';

export const MAX_COPY_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const DOCUMENT_MIMES = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'application/octet-stream', ''];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function sameDocument(left: DocumentFile, right: DocumentFile): boolean {
  if (left.kind !== right.kind) return false;
  if (left.sha256 && right.sha256) return left.sha256 === right.sha256 && left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
  if (!!left.sha256 !== !!right.sha256) return false;
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified && left.mimeType === right.mimeType;
}
export function documentMetadata(file: DocumentFile): DocumentFile {
  return { kind: file.kind, name: file.name, size: file.size, mimeType: file.mimeType, lastModified: file.lastModified, sha256: file.sha256 };
}
export function prepareDocumentCapture(input: CaptureEvent): { input: CaptureEvent; bytes: Buffer | null } {
  const selected = input.document;
  if (!selected) return { input, bytes: null };
  const metadata = documentMetadata(selected);
  if (selected.contentBase64 === undefined) return { input: { ...input, document: metadata }, bytes: null };
  if (input.kind !== 'document_selected') throw new HttpError(422, 'File content is only accepted when a document is selected.');
  if (!/\.(pdf|doc|docx|txt)$/i.test(metadata.name) || !DOCUMENT_MIMES.includes(metadata.mimeType)) throw new HttpError(422, 'Saved copies support PDF, DOC, DOCX and TXT files.');
  if (metadata.size > MAX_COPY_BYTES || selected.contentBase64.length > Math.ceil(MAX_COPY_BYTES / 3) * 4) throw new HttpError(413, 'Document copies must be 10 MB or smaller.');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(selected.contentBase64)) throw new HttpError(422, 'File content must be valid base64.');
  const bytes = Buffer.from(selected.contentBase64, 'base64');
  if (bytes.length !== metadata.size) throw new HttpError(422, 'Document size does not match the uploaded file.');
  const digest = hash(bytes);
  if (metadata.sha256 && metadata.sha256 !== digest) throw new HttpError(422, 'Document fingerprint does not match the uploaded file.');
  metadata.sha256 = digest;
  return { input: { ...input, document: metadata }, bytes };
}

export function applyDocumentEvidence(application: Application, input: CaptureEvent, evidence: Evidence): void {
  if (input.source !== 'browser') return;
  const docs = application.documents ?? (application.documents = []);
  const observedAt = evidence.observedAt;
  if (input.kind === 'document_selected' && input.document) {
    const file = documentMetadata(input.document);
    const current = docs.find(doc => doc.kind === file.kind && doc.status === 'selected');
    const association = file.kind === 'resume' ? 'resumeDocumentId' : 'coverLetterDocumentId';
    const label = file.kind === 'resume' ? 'resumeName' : 'coverLetterName';
    const newest = docs.find(doc => doc.kind === file.kind);
    const stale = !!newest && new Date(newest.detectedAt).getTime() > new Date(observedAt).getTime();
    if (current && sameDocument(current, file) && !stale) {
      evidence.documentId = current.id;
      application[association] = current.id; application[label] = current.name;
      return;
    }
    if (current && !stale) current.status = 'replaced';
    const document: ApplicationDocument = { ...file, id: randomUUID(), detectedAt: observedAt, status: stale ? 'replaced' : 'selected', submittedAt: null, stored: false };
    docs.push(document); docs.sort((a,b) => b.detectedAt.localeCompare(a.detectedAt));
    evidence.documentId = document.id;
    if (!stale) { application[association] = document.id; application[label] = document.name; }
  } else if (input.kind === 'document_removed' && input.document) {
    const file = input.document;
    const association = file.kind === 'resume' ? 'resumeDocumentId' : 'coverLetterDocumentId';
    const label = file.kind === 'resume' ? 'resumeName' : 'coverLetterName';
    const current = docs.find(doc => doc.id === application[association]) ?? docs.find(doc => doc.kind === file.kind && doc.status === 'selected');
    if (current && sameDocument(current, file) && new Date(current.detectedAt).getTime() <= new Date(observedAt).getTime()) {
      current.status = 'removed'; evidence.documentId = current.id;
      if (application[association] === current.id) { application[association] = null; application[label] = ''; }
    }
  } else if (input.kind === 'submission_confirmed' && input.documents) {
    for (const file of input.documents) {
      const candidates = docs.filter(doc => sameDocument(doc, file) && new Date(doc.detectedAt).getTime() <= new Date(observedAt).getTime());
      // Metadata without a fingerprint cannot disambiguate historical versions.
      if (!file.sha256 && candidates.length !== 1) continue;
      const target = candidates[0];
      if (!target) continue;
      target.status = 'submitted'; target.submittedAt ??= observedAt;
    }
  }
}

export function documentPath(actor: CloudActor, applicationId: string, sha256: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(applicationId) || !/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(422, 'Invalid document identity.');
  return `${actor.id}/${applicationId}/${sha256}`;
}
export async function archiveDocument(actor: CloudActor, applicationId: string, document: ApplicationDocument, bytes: Buffer): Promise<void> {
  if (!document.sha256 || hash(bytes) !== document.sha256) throw new HttpError(422, 'Document fingerprint does not match.');
  const path = documentPath(actor, applicationId, document.sha256);
  const bucket = actor.client.storage.from(DOCUMENT_BUCKET);
  const { error } = await bucket.upload(path, bytes, { contentType: document.mimeType || 'application/octet-stream', upsert: false });
  if (error) {
    if (String(error.statusCode) !== '409' && !/already exists|duplicate/i.test(error.message)) throw new HttpError(502, 'The document name was recorded, but the cloud copy could not be saved. Retry the file selection.');
    const existing = await bucket.download(path);
    if (existing.error || !existing.data || hash(new Uint8Array(await existing.data.arrayBuffer())) !== document.sha256) throw new HttpError(502, 'The existing cloud copy could not be verified.');
  }
}
export async function downloadDocument(actor: CloudActor, application: Application, documentId: string): Promise<{ bytes: Buffer; document: ApplicationDocument }> {
  const document = application.documents?.find(item => item.id === documentId);
  if (!document || !document.stored || !document.sha256) throw new HttpError(404, 'No saved copy is available for this document.');
  const { data, error } = await actor.client.storage.from(DOCUMENT_BUCKET).download(documentPath(actor, application.id, document.sha256));
  if (error || !data) throw new HttpError(502, 'The saved document could not be downloaded.');
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length !== document.size || hash(bytes) !== document.sha256) throw new HttpError(502, 'The downloaded document failed its integrity check.');
  return { bytes, document };
}
export function attachmentFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f/\\]/g, '_').replace(/^[. ]+/, '').slice(0, 240) || 'document';
}

export async function drainDocumentDeletions(repository: WorkspaceRepository, actor: CloudActor, applicationId?: string): Promise<void> {
  const pending = await repository.run('personal', actor, false, data => data.listMeta<{ applicationId: string; hashes: string[] }>('document-deletion:'));
  for (const item of pending) {
    if (applicationId && item.value.applicationId !== applicationId) continue;
    const paths = item.value.hashes.map(digest => documentPath(actor, item.value.applicationId, digest));
    if (paths.length) {
      const { error } = await actor.client.storage.from(DOCUMENT_BUCKET).remove(paths);
      if (error) throw new HttpError(502, 'The application was deleted. Its file deletion is queued and will retry when you reload your applications.');
    }
    await repository.run('personal', actor, true, data => {
      if (JSON.stringify(data.getMeta(item.key)) === JSON.stringify(item.value)) data.deleteMeta(item.key);
    });
  }
}
