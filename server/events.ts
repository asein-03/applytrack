import { randomUUID } from 'node:crypto';
import type { Application, CaptureEvent, Evidence, EventKind, Stage } from '../shared/types.js';
import { HttpError, Store } from './store.js';

const normalized = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|source$|ref$|referrer$)/i.test(key)) url.searchParams.delete(key);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}
const stageByKind: Partial<Record<EventKind, Stage>> = {
  submission_pending: 'in_progress', submission_confirmed: 'applied', assessment_requested: 'assessment', interview: 'interviewing', offer: 'offer', rejection: 'rejected',
};
const stageRank: Record<Stage, number> = { saved: 0, in_progress: 1, applied: 2, assessment: 3, interviewing: 4, offer: 5, rejected: 6, withdrawn: 6 };

function needsReview(application: Application, input: CaptureEvent): boolean {
  if (input.requiresReview) return true;
  const stage = stageByKind[input.kind];
  if (!stage || stage === application.stage) return false;
  // Outcomes and user withdrawal are not silently overwritten by a contradictory message.
  if (['rejected', 'withdrawn'].includes(application.stage) && !['submission_confirmed', 'submission_pending', 'note'].includes(input.kind)) return true;
  if (application.stage === 'offer' && input.kind === 'rejection') return true;
  return false;
}

export function applyAcceptedEvidence(application: Application, evidence: Evidence, input?: CaptureEvent): void {
  const target = stageByKind[evidence.kind];
  if (target && (target === 'rejected' || stageRank[target] > stageRank[application.stage])) {
    application.stage = target;
  }
  if (!application.appliedAt && evidence.kind === 'submission_confirmed') application.appliedAt = evidence.observedAt;
  if (input?.task && !application.tasks.some(task => task.title === input.task!.title && task.dueAt === (input.task!.dueAt ?? null) && !task.completedAt)) {
    application.tasks.push({ id: randomUUID(), applicationId: application.id, title: input.task.title, dueAt: input.task.dueAt ?? null, url: input.task.url ?? null, completedAt: null, createdAt: new Date().toISOString() });
  }
  // Completion evidence is retained, but ambiguous task identity cannot complete arbitrary tasks.
}

function matchApplication(store: Store, input: CaptureEvent): Application {
  const workspace = input.workspace ?? 'personal';
  if (input.applicationId) {
    const found = store.requireApplication(input.applicationId);
    if (found.workspace !== workspace) throw new HttpError(409, 'The application belongs to a different workspace.');
    return found;
  }
  const records = store.listApplications(workspace);
  let candidates: Application[] = [];
  if (input.jobId && input.company) candidates = records.filter(record => record.jobId === input.jobId && normalized(record.company) === normalized(input.company!));
  if (!candidates.length && input.url) {
    const url = canonicalUrl(input.url);
    if (url) candidates = records.filter(record => record.url && canonicalUrl(record.url) === url);
  }
  if (!candidates.length && input.company && input.role) candidates = records.filter(record => normalized(record.company) === normalized(input.company!) && normalized(record.role) === normalized(input.role!));
  // A shared careers URL or role title must not merge distinct applications.
  candidates = candidates.filter(record =>
    (!input.company || normalized(record.company) === normalized(input.company)) &&
    (!input.role || normalized(record.role) === normalized(input.role)) &&
    (!input.jobId || !record.jobId || record.jobId === input.jobId) &&
    (!input.email || !record.email || normalized(record.email) === normalized(input.email))
  );
  if (candidates.length > 1) throw new HttpError(409, 'This evidence matches multiple applications. Choose the correct application.');
  if (candidates.length === 1) return candidates[0];
  if (!input.company?.trim() || !input.role?.trim()) throw new HttpError(422, 'Choose an application or provide both a company and role.');
  return store.createApplication({ company: input.company, role: input.role, workspace, url: input.url, jobId: input.jobId, description: input.description, location: input.location, email: input.email });
}

export function ingestEvent(store: Store, input: CaptureEvent): { application: Application; evidence: Evidence } {
  return store.transaction(() => {
    const existing = store.findProcessedEvent(input);
    if (existing) return existing;
    const application = matchApplication(store, input);
    const now = new Date().toISOString();
    const review = needsReview(application, input) ? 'pending' : 'accepted';
    const evidence: Evidence = {
      id: randomUUID(), applicationId: application.id, source: input.source, kind: input.kind,
      summary: input.summary, excerpt: input.excerpt ?? null, url: input.url ?? null,
      observedAt: input.observedAt ?? now, snapshot: input.snapshot ?? null,
      review, sourceId: input.sourceId ?? null,
    };
    application.evidence.unshift(evidence);
    if (review === 'accepted') applyAcceptedEvidence(application, evidence, input);
    else if (input.task) store.setMeta(`evidence-task:${evidence.id}`, input.task);
    application.timeline.unshift({ id: randomUUID(), title: review === 'pending' ? 'Evidence needs review' : evidence.summary, detail: review === 'pending' ? evidence.summary : (input.excerpt ?? ''), source: input.source, createdAt: evidence.observedAt });
    application.updatedAt = now;
    store.saveApplication(application);
    store.rememberEvent(input, application.id, evidence.id);
    return { application, evidence };
  });
}

export function reviewEvidence(store: Store, evidenceId: string, action: 'accept' | 'dismiss'): Application {
  return store.transaction(() => {
    const found = store.findEvidence(evidenceId);
    if (!found) throw new HttpError(404, 'Evidence not found.');
    const { application, evidence } = found;
    if (evidence.review !== 'pending') throw new HttpError(409, 'This evidence has already been reviewed.');
    evidence.review = action === 'accept' ? 'accepted' : 'dismissed';
    if (action === 'accept') {
      const task = store.getMeta<CaptureEvent['task']>(`evidence-task:${evidenceId}`) ?? undefined;
      // Explicit user approval can replace conflicting terminal stages.
      if (stageByKind[evidence.kind] && ['offer', 'rejected', 'withdrawn'].includes(application.stage)) application.stage = stageByKind[evidence.kind]!;
      applyAcceptedEvidence(application, evidence, task ? { source: evidence.source, kind: evidence.kind, summary: evidence.summary, task } : undefined);
    }
    store.deleteMeta(`evidence-task:${evidenceId}`);
    application.updatedAt = new Date().toISOString();
    application.timeline.unshift({ id: randomUUID(), title: action === 'accept' ? 'Evidence accepted' : 'Evidence dismissed', detail: evidence.summary, source: 'manual', createdAt: application.updatedAt });
    return store.saveApplication(application);
  });
}
