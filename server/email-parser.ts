import type { Application, CaptureEvent, EventKind, Workspace } from '../shared/types.js';

export interface IncomingEmail {
  id: string; subject: string; from: string; body: string; receivedAt: string;
  workspace: Workspace; inboxId?: string; recipient?: string;
}
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const contains = (haystack: string, needle: string) => needle.length > 2 && (` ${haystack} `).includes(` ${normalize(needle)} `);

export function newestEmailText(body: string): string {
  return body.split(/\nOn [^\n]+wrote:\s*\n|\n_{5,}\s*\n|\n-{3,}\s*Original Message\s*-{3,}/i)[0]
    .split('\n').filter(line => !line.trimStart().startsWith('>')).join('\n').slice(0, 50000);
}

export function explicitDeadline(text: string): string | null {
  const match = text.match(/\b(?:deadline(?:\s+is)?|due(?:\s+on)?|complete.{0,35}?by|by)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))?)(?![\dT])/i);
  if (!match) return null;
  const date = match[1];
  const parsed = new Date(date);
  // Validate the written calendar date separately: a valid offset may put the
  // instant on the previous or following UTC day.
  const calendarDate = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== date.slice(0, 10)) return null;
  return date;
}

export function classifyEmail(mail: IncomingEmail): Pick<CaptureEvent, 'kind' | 'summary' | 'requiresReview' | 'task'> {
  const text = `${mail.subject}\n${newestEmailText(mail.body)}`;
  // Instructional and hypothetical copy is not a delivered hiring decision.
  // Ambiguous cases stay reviewable even if a familiar keyword is present.
  if (/\b(?:if|when|once|after|unless|whether)\b[^.!?\n]{0,80}(?:application.{0,35}(?:received|submitted)|(?:not (?:be )?)?(?:moving|proceeding) forward|offer (?:you|is|will))/i.test(text)) {
    return { kind: 'note', summary: 'Recruiting email needs review', requiresReview: true };
  }
  let kind: EventKind = 'note';
  let summary = 'Recruiting email needs review';
  let requiresReview = true;
  if (/not (?:be )?(?:moving|proceeding) forward|will not be (?:moving|proceeding)|(?:application|candidacy) (?:was|has been|is) unsuccessful|decided to (?:pursue|move forward with) other candidates|unable to offer you (?:the|a) (?:position|role)/i.test(text)) {
    kind = 'rejection'; summary = 'Application declined'; requiresReview = false;
  } else if (/(?:pleased|delighted|excited) to (?:extend|offer you)|(?:formal|written) (?:job |employment )?offer (?:is attached|for)/i.test(text)) {
    kind = 'offer'; summary = 'Offer received'; requiresReview = false;
  } else if (/(?:you have|you've|successfully) completed (?:the |your )?(?:assessment|test|coding challenge)|assessment (?:has been |was )?(?:successfully )?submitted/i.test(text)) {
    kind = 'assessment_completed'; summary = 'Assessment completion received'; requiresReview = false;
  } else if (/(?:please|invite you to|required to|next step.{0,20}) (?:complete|take|start).{0,80}(?:assessment|test|coding challenge)|(?:assessment|coding challenge) invitation/i.test(text)) {
    kind = 'assessment_requested'; summary = 'Assessment requested'; requiresReview = false;
  } else if (/(?:invite you|invitation|schedule|arrange|book|confirm).{0,60}(?:interview)|interview.{0,40}(?:scheduled|confirmed|invitation)/i.test(text)) {
    kind = 'interview'; summary = 'Interview requested'; requiresReview = false;
  } else if (/(?:we (?:have |have successfully )?received|we've received|thank you for submitting|thanks for submitting).{0,50}application|application (?:has been |was )?(?:successfully )?(?:received|submitted)|thank you for applying|thanks for applying/i.test(text)) {
    kind = 'submission_confirmed'; summary = 'Application confirmed by email'; requiresReview = false;
  }
  const links = newestEmailText(mail.body).match(/https:\/\/[^\s<>"')]+/g) ?? [];
  const task = kind === 'assessment_requested' || kind === 'interview'
    ? { title: kind === 'assessment_requested' ? 'Complete assessment' : 'Review interview invitation', dueAt: explicitDeadline(text), url: links[0] ?? null }
    : undefined;
  return { kind, summary, requiresReview, task };
}

export function matchEmail(mail: IncomingEmail, applications: Application[]): Application | null {
  const text = normalize(`${mail.subject}\n${newestEmailText(mail.body)}`);
  const eligible = applications.filter(app => app.workspace === mail.workspace && (!mail.recipient || !app.email || app.email.toLowerCase() === mail.recipient.toLowerCase()));
  // Job IDs are often short numbers shared by unrelated employers. Corroborate
  // the employer instead of attaching mail solely because a number appears.
  const employerText = normalize(`${mail.from}\n${mail.subject}\n${newestEmailText(mail.body)}`);
  const byReference = eligible.filter(app => app.jobId.length >= 4 && contains(text, app.jobId) && contains(employerText, app.company));
  if (byReference.length === 1) return byReference[0];
  const matches = eligible.filter(app => contains(text, app.company) && contains(text, app.role));
  return matches.length === 1 ? matches[0] : null;
}

export function emailEvent(mail: IncomingEmail, application: Application, options: { reviewedByUser?: boolean } = {}): CaptureEvent {
  const classified = classifyEmail(mail);
  return {
    ...classified,
    // Message wording and sender headers are not proof of employer identity.
    requiresReview: classified.requiresReview || (!!mail.inboxId && !options.reviewedByUser),
    applicationId: application.id, workspace: application.workspace,
    source: 'email', sourceId: `email:${mail.inboxId ?? 'import'}:${mail.id}`,
    observedAt: mail.receivedAt, excerpt: `${mail.inboxId ? `From: ${mail.from}\n` : ''}${mail.subject}\n${newestEmailText(mail.body)}`.slice(0, 8000),
    url: mail.inboxId ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mail.recipient ?? '')}#all/${encodeURIComponent(mail.id)}` : undefined,
  };
}
