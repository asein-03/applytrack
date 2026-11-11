import type { Application, CaptureEvent, Evidence, Workspace } from './types.ts';

export interface EventStore {
  transaction<T>(operation: () => T): T;
  listApplications(workspace?: Workspace): Application[];
  requireApplication(id: string): Application;
  getApplication(id: string): Application | null;
  createApplication(input: Partial<Application> & { company: string; role: string }): Application;
  saveApplication(application: Application): Application;
  getMeta<T = unknown>(key: string): T | null;
  setMeta(key: string, value: unknown): void;
  deleteMeta(key: string): void;
  findProcessedEvent(input: CaptureEvent): { application: Application; evidence: Evidence } | null;
  rememberEvent(input: CaptureEvent, applicationId: string, evidenceId: string): void;
  findEvidence(id: string): { application: Application; evidence: Evidence } | null;
}
