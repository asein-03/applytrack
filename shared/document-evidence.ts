import { randomUUID } from 'node:crypto';
import type { Application, ApplicationDocument, CaptureEvent, DocumentFile, Evidence } from './types.ts';
export function sameDocument(left: DocumentFile, right: DocumentFile): boolean {
  if (left.kind !== right.kind) return false;
  if (left.sha256 && right.sha256) return left.sha256 === right.sha256 && left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
  if (!!left.sha256 !== !!right.sha256) return false;
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified && left.mimeType === right.mimeType;
}
export function documentMetadata(file: DocumentFile): DocumentFile {
  return { kind: file.kind, name: file.name, size: file.size, mimeType: file.mimeType, lastModified: file.lastModified, sha256: file.sha256 };
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

