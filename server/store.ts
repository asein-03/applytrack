import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Application, CaptureEvent, Evidence, Inbox, Task, TrackingSession, Workspace } from '../shared/types.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type ApplicationInput = Partial<Omit<Application, 'id' | 'createdAt' | 'updatedAt' | 'tasks' | 'evidence' | 'timeline'>> & { company: string; role: string };
export type ApplicationPatch = Partial<Omit<Application, 'id' | 'workspace' | 'createdAt' | 'updatedAt' | 'tasks' | 'evidence' | 'timeline'>>;
export type TaskInput = { title: string; dueAt?: string | null; url?: string | null };
export type TaskPatch = Partial<TaskInput & { completedAt: string | null }>;

/** Single-user local store. Entire record mutations are atomic and kept in SQLite. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS applications_workspace ON applications(workspace);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processed_events (source TEXT NOT NULL, workspace TEXT NOT NULL, source_id TEXT NOT NULL, application_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(source, workspace, source_id), FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE);
    `);
    if (!this.getMeta('extensionToken')) this.setMeta('extensionToken', randomBytes(32).toString('hex'));
    // A process restart cannot keep an actual screen stream alive.
    if (this.getSession()) this.stopSession();
  }

  close() { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getMeta<T = unknown>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }
  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  deleteMeta(key: string): void { this.db.prepare('DELETE FROM metadata WHERE key = ?').run(key); }
  listMeta<T = unknown>(prefix: string): Array<{ key: string; value: T }> {
    const rows = this.db.prepare('SELECT key,value FROM metadata WHERE substr(key,1,?) = ? ORDER BY key').all(prefix.length, prefix) as Array<{ key: string; value: string }>;
    return rows.map(row => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }
  listInboxes(): Inbox[] { return this.listMeta<Inbox>('inbox:').map(row => row.value); }

  listApplications(workspace: Workspace = 'personal'): Application[] {
    const rows = this.db.prepare('SELECT data FROM applications WHERE workspace = ?').all(workspace) as Array<{ data: string }>;
    return rows.map(row => JSON.parse(row.data) as Application).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  getApplication(id: string): Application | null {
    const row = this.db.prepare('SELECT data FROM applications WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Application : null;
  }
  requireApplication(id: string): Application {
    const record = this.getApplication(id);
    if (!record) throw new HttpError(404, 'Application not found.');
    return record;
  }
  saveApplication(record: Application): Application {
    this.db.prepare('INSERT INTO applications(id,workspace,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,data=excluded.data').run(record.id, record.workspace, JSON.stringify(record));
    return record;
  }
  createApplication(input: ApplicationInput): Application {
    const now = new Date().toISOString();
    const record: Application = {
      id: randomUUID(), workspace: input.workspace ?? 'personal', company: input.company, role: input.role,
      stage: input.stage ?? 'saved', location: input.location ?? '', workMode: input.workMode ?? '', salary: input.salary ?? '',
      url: input.url ?? '', jobId: input.jobId ?? '', description: input.description ?? '', email: input.email ?? '',
      resumeName: input.resumeName ?? '', coverLetterName: input.coverLetterName ?? '', recruiterName: input.recruiterName ?? '',
      recruiterEmail: input.recruiterEmail ?? '', notes: input.notes ?? '', priority: input.priority ?? 'normal',
      appliedAt: input.appliedAt ?? null, createdAt: now, updatedAt: now, tasks: [], evidence: [],
      timeline: [{ id: randomUUID(), title: 'Application added', detail: 'Added to your tracker.', source: 'manual', createdAt: now }],
    };
    return this.saveApplication(record);
  }
  updateApplication(id: string, patch: ApplicationPatch): Application {
    const record = this.requireApplication(id);
    const now = new Date().toISOString();
    const next = { ...record, ...patch, updatedAt: now };
    if (patch.stage && patch.stage !== record.stage) {
      next.timeline = [{ id: randomUUID(), title: 'Stage updated', detail: `Changed from ${record.stage.replaceAll('_', ' ')} to ${patch.stage.replaceAll('_', ' ')}.`, source: 'manual', createdAt: now }, ...record.timeline];
      if (!next.appliedAt && !['saved', 'in_progress'].includes(patch.stage)) next.appliedAt = now;
    }
    return this.saveApplication(next);
  }
  deleteApplication(id: string): void {
    this.requireApplication(id);
    this.db.prepare('DELETE FROM applications WHERE id = ?').run(id);
  }

  createTask(applicationId: string, input: TaskInput): Task {
    const record = this.requireApplication(applicationId);
    const task: Task = { id: randomUUID(), applicationId, title: input.title, dueAt: input.dueAt ?? null, url: input.url ?? null, completedAt: null, createdAt: new Date().toISOString() };
    record.tasks.push(task);
    record.updatedAt = new Date().toISOString();
    this.saveApplication(record);
    return task;
  }
  updateTask(id: string, patch: TaskPatch): Task {
    const rows = this.db.prepare('SELECT data FROM applications').all() as Array<{ data: string }>;
    for (const row of rows) {
      const record = JSON.parse(row.data) as Application;
      const index = record.tasks.findIndex(task => task.id === id);
      if (index < 0) continue;
      const task = { ...record.tasks[index], ...patch };
      record.tasks[index] = task;
      record.updatedAt = new Date().toISOString();
      this.saveApplication(record);
      return task;
    }
    throw new HttpError(404, 'Task not found.');
  }

  findEvidence(id: string): { application: Application; evidence: Evidence } | null {
    const rows = this.db.prepare('SELECT data FROM applications').all() as Array<{ data: string }>;
    for (const row of rows) {
      const application = JSON.parse(row.data) as Application;
      const evidence = application.evidence.find(item => item.id === id);
      if (evidence) return { application, evidence };
    }
    return null;
  }
  rememberEvent(input: CaptureEvent, applicationId: string, evidenceId: string): void {
    if (!input.sourceId) return;
    this.db.prepare('INSERT OR IGNORE INTO processed_events(source,workspace,source_id,application_id,evidence_id) VALUES (?,?,?,?,?)').run(input.source, input.workspace ?? 'personal', input.sourceId, applicationId, evidenceId);
  }
  findProcessedEvent(input: CaptureEvent): { application: Application; evidence: Evidence } | null {
    if (!input.sourceId) return null;
    const row = this.db.prepare('SELECT application_id,evidence_id FROM processed_events WHERE source=? AND workspace=? AND source_id=?').get(input.source, input.workspace ?? 'personal', input.sourceId) as { application_id: string; evidence_id: string } | undefined;
    if (!row) return null;
    const application = this.getApplication(row.application_id);
    const evidence = application?.evidence.find(item => item.id === row.evidence_id);
    return application && evidence ? { application, evidence } : null;
  }

  getSession(): TrackingSession | null {
    const session = this.getMeta<TrackingSession>('currentSession');
    return session && !session.stoppedAt ? session : null;
  }
  startSession(options: Pick<TrackingSession, 'screenEnabled' | 'browserEnabled'>): TrackingSession {
    const current = this.getSession();
    const session = { id: current?.id ?? randomUUID(), startedAt: current?.startedAt ?? new Date().toISOString(), stoppedAt: null, ...options };
    this.setMeta('currentSession', session);
    this.setMeta(`session:${session.id}`, session);
    return session;
  }
  stopSession(): void {
    const current = this.getSession();
    if (!current) return;
    const stopped = { ...current, stoppedAt: new Date().toISOString(), screenEnabled: false, browserEnabled: false };
    this.setMeta('currentSession', stopped);
    this.setMeta(`session:${stopped.id}`, stopped);
  }
}
