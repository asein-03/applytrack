export const STAGES = ['saved', 'in_progress', 'applied', 'assessment', 'interviewing', 'offer', 'rejected', 'withdrawn'] as const;
export type Stage = typeof STAGES[number];
export type Workspace = 'personal' | 'demo';
export type EvidenceSource = 'browser' | 'visual' | 'email' | 'manual';
export type EventKind = 'submission_pending' | 'submission_confirmed' | 'assessment_requested' | 'assessment_completed' | 'interview' | 'offer' | 'rejection' | 'note' | 'document_selected' | 'document_removed';
export interface DocumentFile {
  kind: 'resume' | 'cover_letter'; name: string; size: number; mimeType: string;
  lastModified: number; sha256: string | null;
}
export interface ApplicationDocument extends DocumentFile {
  id: string; detectedAt: string; status: 'selected' | 'submitted' | 'replaced' | 'removed';
  submittedAt: string | null; stored: boolean;
}
export interface Task {
  id: string; applicationId: string; title: string; dueAt: string | null;
  url: string | null; completedAt: string | null; createdAt: string;
}
export interface Evidence {
  id: string; applicationId: string; source: EvidenceSource; kind: EventKind;
  summary: string; excerpt: string | null; url: string | null; observedAt: string;
  snapshot: string | null; review: 'accepted' | 'pending' | 'dismissed'; sourceId: string | null;
  documentId?: string;
}
export interface TimelineEvent { id: string; title: string; detail: string; source: EvidenceSource; createdAt: string; }
export interface Application {
  id: string; workspace: Workspace; company: string; role: string; stage: Stage;
  location: string; workMode: string; salary: string; url: string; jobId: string;
  description: string; email: string; resumeName: string; coverLetterName: string;
  documents?: ApplicationDocument[]; resumeDocumentId?: string | null; coverLetterDocumentId?: string | null;
  recruiterName: string; recruiterEmail: string; notes: string;
  priority: 'normal' | 'high'; appliedAt: string | null; createdAt: string; updatedAt: string;
  tasks: Task[]; evidence: Evidence[]; timeline: TimelineEvent[];
}
export interface CaptureEvent {
  applicationId?: string; workspace?: Workspace; company?: string; role?: string;
  url?: string; jobId?: string; description?: string; location?: string; email?: string;
  source: EvidenceSource; kind: EventKind; summary: string; excerpt?: string;
  observedAt?: string; sourceId?: string; snapshot?: string;
  requiresReview?: boolean; task?: { title: string; dueAt?: string | null; url?: string | null };
  document?: DocumentFile & { contentBase64?: string }; documents?: DocumentFile[];
}
export interface TrackingSession {
  id: string; startedAt: string; stoppedAt: string | null;
  browserEnabled: boolean; screenEnabled: boolean;
}
export interface Inbox {
  id: string; provider: 'gmail'; email: string; status: 'connected' | 'error';
  lastSyncAt: string | null; error: string | null;
}
export interface Settings {
  gmailConfigured: boolean; inboxes: Inbox[]; extensionToken: string;
  session: TrackingSession | null;
  cloud?: { enabled: boolean; configured: boolean; user: { id: string; email: string | null } | null };
}
export const STAGE_LABELS: Record<Stage, string> = {
  saved: 'Saved', in_progress: 'In progress', applied: 'Applied', assessment: 'Assessment',
  interviewing: 'Interviewing', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn',
};
