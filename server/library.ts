import type { Express, Request } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApplicationDocument, Workspace } from '../shared/types.js';
import type { LibraryDocument } from '../shared/library.js';
import type { CloudActor, CloudService, WorkspaceRepository } from './cloud.js';
import { HttpError, type Store } from './store.js';

const workspaceSchema = z.enum(['personal', 'demo']);
const labelSchema = z.object({ label: z.string().trim().max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Use a label without control characters.') }).strict();

export function libraryDocumentId(applicationId: string, document: ApplicationDocument): string {
  const identity = document.sha256 && /^[a-f0-9]{64}$/.test(document.sha256) ? document.sha256 : createHash('sha256').update(JSON.stringify([applicationId, document.id])).digest('hex');
  return `${document.kind}-${document.sha256 ? 'file' : 'record'}-${identity}`;
}

export function listLibraryDocuments(store: Store, workspace: Workspace): LibraryDocument[] {
  const groups = new Map<string, LibraryDocument>();
  for (const application of store.listApplications(workspace)) {
    for (const document of application.documents ?? []) {
      const id = libraryDocumentId(application.id, document);
      let group = groups.get(id);
      if (!group) {
        const savedLabel = store.getMeta<unknown>(`document-label:${workspace}:${id}`);
        group = { id, kind: document.kind, label: typeof savedLabel === 'string' ? savedLabel.slice(0, 120) : '', name: document.name, names: [], size: document.size, mimeType: document.mimeType, sha256: document.sha256, firstDetectedAt: document.detectedAt, lastDetectedAt: document.detectedAt, stored: false, usages: [] };
        groups.set(id, group);
      }
      if (!group.names.includes(document.name)) group.names.push(document.name);
      group.firstDetectedAt = group.firstDetectedAt < document.detectedAt ? group.firstDetectedAt : document.detectedAt;
      if (group.lastDetectedAt < document.detectedAt) {
        group.lastDetectedAt = document.detectedAt;
        group.name = document.name;
        group.mimeType = document.mimeType;
      }
      group.stored ||= document.stored;
      const existing = group.usages.find(usage => usage.applicationId === application.id);
      const current = (document.kind === 'resume' ? application.resumeDocumentId : application.coverLetterDocumentId) === document.id;
      if (!existing) {
        group.usages.push({ applicationId: application.id, documentId: document.id, company: application.company, role: application.role, name: document.name, status: document.status, detectedAt: document.detectedAt, submittedAt: document.submittedAt, stored: document.stored, current });
      } else {
        if ((!existing.stored && document.stored) || (existing.stored === document.stored && existing.detectedAt < document.detectedAt)) {
          existing.documentId = document.id; existing.name = document.name;
        }
        if (existing.detectedAt < document.detectedAt) { existing.detectedAt = document.detectedAt; existing.status = document.status; }
        if (document.submittedAt && (!existing.submittedAt || existing.submittedAt < document.submittedAt)) existing.submittedAt = document.submittedAt;
        existing.current ||= current;
        existing.stored ||= document.stored;
      }
    }
  }
  return [...groups.values()].map(group => ({ ...group, names: group.names.sort(), usages: group.usages.sort((a,b) => b.detectedAt.localeCompare(a.detectedAt) || a.company.localeCompare(b.company)) })).sort((a,b) => b.lastDetectedAt.localeCompare(a.lastDetectedAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function attachLibraryRoutes(app: Express, _store: Store, options: { cloud: CloudService; repository: WorkspaceRepository }) {
  const actorFor = (request: Request, workspace: Workspace): Promise<CloudActor | null> => options.cloud.enabled && workspace === 'personal' ? options.cloud.authenticate(request) : Promise.resolve(null);
  app.get('/api/documents', async (req, res) => {
    const workspace = workspaceSchema.parse(req.query.workspace ?? 'personal');
    const actor = await actorFor(req, workspace);
    const documents = await options.repository.run(workspace, actor, false, data => listLibraryDocuments(data, workspace));
    res.json({ documents });
  });
  app.patch('/api/documents/:id', async (req, res) => {
    const workspace = workspaceSchema.parse(req.query.workspace ?? 'personal');
    const { label } = labelSchema.parse(req.body);
    const id = String(req.params.id);
    if (!/^(resume|cover_letter)-(file|record)-[a-f0-9]{64}$/.test(id)) throw new HttpError(404, 'Document not found.');
    const actor = await actorFor(req, workspace);
    const document = await options.repository.run(workspace, actor, true, data => {
      const entry = listLibraryDocuments(data, workspace).find(item => item.id === id);
      if (!entry) throw new HttpError(404, 'Document not found.');
      const key = `document-label:${workspace}:${id}`;
      if (label) data.setMeta(key, label); else data.deleteMeta(key);
      return { ...entry, label };
    });
    res.json(document);
  });
}
