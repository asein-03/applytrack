import { createHash } from 'node:crypto';
import type { Application, CaptureEvent, Evidence, Workspace } from '../../../shared/types.ts';
import type { EventStore } from '../../../shared/event-store.ts';
import { HttpError } from '../../../shared/errors.ts';
import type { WorkspaceState } from './shared.ts';

export class MemoryWorkspace implements EventStore {
  state: WorkspaceState;
  constructor(value: WorkspaceState) {
    if (value?.version !== 1 || !Array.isArray(value.applications) || !Array.isArray(value.metadata) || !Array.isArray(value.processed) || value.applications.some(app => app.workspace !== 'personal')) throw new HttpError(502, 'The cloud workspace has an invalid format.');
    this.state = structuredClone(value);
  }
  transaction<T>(operation: () => T): T {
    const previous = structuredClone(this.state);
    try { return operation(); } catch (error) { this.state = previous; throw error; }
  }
  listApplications(workspace: Workspace = 'personal') { return structuredClone(this.state.applications.filter(app => app.workspace === workspace)); }
  getApplication(id: string) { return structuredClone(this.state.applications.find(app => app.id === id) ?? null); }
  requireApplication(id: string) { const app = this.getApplication(id); if (!app) throw new HttpError(404, 'Application not found.'); return app; }
  createApplication(): Application { throw new HttpError(422, 'An email must match an existing application.'); }
  saveApplication(application: Application) {
    const index = this.state.applications.findIndex(app => app.id === application.id);
    if (index < 0) throw new HttpError(404, 'Application not found.');
    this.state.applications[index] = structuredClone(application); return application;
  }
  getMeta<T = unknown>(key: string): T | null { return structuredClone(this.state.metadata.find(item => item.key === key)?.value ?? null) as T | null; }
  setMeta(key: string, value: unknown) {
    const index = this.state.metadata.findIndex(item => item.key === key);
    const item = { key, value: structuredClone(value) };
    if (index < 0) this.state.metadata.push(item); else this.state.metadata[index] = item;
  }
  deleteMeta(key: string) { this.state.metadata = this.state.metadata.filter(item => item.key !== key); }
  findProcessedEvent(input: CaptureEvent) {
    if (!input.sourceId) return null;
    const workspace = input.workspace ?? 'personal';
    const deletedKey = `deleted-event:${workspace}:${createHash('sha256').update(JSON.stringify([input.source, workspace, input.sourceId])).digest('hex')}`;
    if (this.getMeta(deletedKey)) throw new HttpError(410, 'This evidence belongs to a deleted application.');
    const item = this.state.processed.find(row => row.source === input.source && row.workspace === workspace && row.source_id === input.sourceId);
    const application = item && this.getApplication(item.application_id);
    const evidence = application?.evidence.find(entry => entry.id === item!.evidence_id);
    return application && evidence ? { application, evidence } : null;
  }
  rememberEvent(input: CaptureEvent, applicationId: string, evidenceId: string) {
    if (input.sourceId && !this.state.processed.some(row => row.source === input.source && row.workspace === (input.workspace ?? 'personal') && row.source_id === input.sourceId)) this.state.processed.push({ source: input.source, workspace: input.workspace ?? 'personal', source_id: input.sourceId, application_id: applicationId, evidence_id: evidenceId });
  }
  findEvidence(id: string): { application: Application; evidence: Evidence } | null {
    for (const application of this.listApplications()) { const evidence = application.evidence.find(item => item.id === id); if (evidence) return { application, evidence }; }
    return null;
  }
}
