import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, CaretDown, Check, CheckCircle, Clock, DownloadSimple, EnvelopeSimple, FileText, Flag, LinkSimple, MapPin, Monitor, PencilSimple, Plus, ShieldCheck, Trash, WarningCircle, X } from '@phosphor-icons/react';
import type { Application, ApplicationDocument, Evidence, EvidenceSource, Task } from '../shared/types';
import { STAGES, STAGE_LABELS } from '../shared/types';
import { api, apiBlob, safeUrl } from './api';
import { CompanyMark, dateLabel, Modal, TaskRow } from './ui';
import './details.css';

type DetailTab = 'details' | 'activity' | 'evidence';
const TABS: DetailTab[] = ['details', 'activity', 'evidence'];
const SOURCE_NAMES: Record<EvidenceSource, string> = { browser: 'Browser', visual: 'Screen capture', email: 'Email', manual: 'Manual entry' };

function SourceIcon({ source, size = 17 }: { source: EvidenceSource; size?: number }) {
  if (source === 'email') return <EnvelopeSimple size={size} />;
  if (source === 'visual') return <Monitor size={size} />;
  if (source === 'browser') return <LinkSimple size={size} />;
  return <PencilSimple size={size} />;
}

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Date not provided';
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const unit = bytes < 1024 * 1024 ? 'KB' : 'MB';
  const size = bytes / (unit === 'KB' ? 1024 : 1024 * 1024);
  return `${size.toLocaleString(undefined, { maximumFractionDigits: size < 10 ? 1 : 0 })} ${unit}`;
}

const DOCUMENT_STATES: Record<ApplicationDocument['status'], string> = {
  selected: 'Selected', submitted: 'Detected at submission', replaced: 'Replaced', removed: 'Removed',
};

function DocumentRecord({ applicationId, document, versions }: {
  applicationId: string; document: ApplicationDocument; versions: ApplicationDocument[];
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const sameName = versions.filter(item => item.name === document.name);
  const distinctVersions = new Set(sameName.map(item => item.sha256 || item.id));
  const versionLabel = distinctVersions.size > 1 ? (document.sha256 || document.id).slice(0, 8) : null;
  async function downloadCopy() {
    setDownloading(true); setDownloadError('');
    try {
      const blob = await apiBlob(`/applications/${encodeURIComponent(applicationId)}/documents/${encodeURIComponent(document.id)}/file`);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url; link.download = document.name;
      window.document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setDownloadError(error instanceof Error ? error.message : 'Could not download this file. Try again.'); }
    finally { setDownloading(false); }
  }
  return <article className="record-file" aria-label={document.name}>
    <FileText className="record-file-icon" size={21} />
    <div className="record-file-body">
      <strong className="record-file-name">{document.name}</strong>
      <div className="record-file-meta"><span>{fileSize(document.size)}</span><span>{DOCUMENT_STATES[document.status]}</span>{versionLabel && <span className="record-file-version">Version {versionLabel}</span>}</div>
      <div className="record-file-date"><span>Detected <time dateTime={document.detectedAt}>{timestamp(document.detectedAt)}</time></span>{document.submittedAt && <span>At submission <time dateTime={document.submittedAt}>{timestamp(document.submittedAt)}</time></span>}</div>
      <div className="record-file-actions">{document.stored ? <button className="text-button" disabled={downloading} onClick={() => void downloadCopy()} aria-label={`Download ${document.name}${versionLabel ? `, version ${versionLabel}` : ''}`}><DownloadSimple size={14} />{downloading ? 'Downloading…' : 'Download copy'}</button> : <span>No saved copy</span>}</div>
      {downloadError && <p className="record-file-error" role="alert">{downloadError}</p>}
    </div>
  </article>;
}

function ApplicationDocuments({ application }: { application: Application }) {
  const documents = [...(application.documents || [])].sort((left, right) => right.detectedAt.localeCompare(left.detectedAt));
  const groups = [
    { kind: 'resume', label: 'Resume', name: application.resumeName, currentId: application.resumeDocumentId },
    { kind: 'cover_letter', label: 'Cover letter', name: application.coverLetterName, currentId: application.coverLetterDocumentId },
  ] as const;
  return <section className="record-section record-documents" aria-label="Documents"><div className="record-section-heading"><h3>Documents</h3></div>
    <div className="record-document-groups">{groups.map(group => {
      const versions = documents.filter(document => document.kind === group.kind);
      const current = versions.find(document => document.id === group.currentId);
      const visible = current ? [current] : group.currentId === undefined ? versions.filter(document => document.status === 'selected' || document.status === 'submitted') : [];
      const previous = versions.filter(document => !visible.includes(document));
      return <div className="record-document-group" key={group.kind}>
        <h4>{group.label}</h4>
        {!current && group.name && <div className="record-file record-file-reference"><FileText className="record-file-icon" size={21} /><div className="record-file-body"><strong className="record-file-name">{group.name}</strong><div className="record-file-meta"><span>Filename reference</span><span>No saved copy</span></div></div></div>}
        {visible.map(document => <DocumentRecord key={document.id} applicationId={application.id} document={document} versions={versions} />)}
        {!group.name && visible.length === 0 && <p className="record-file-empty">No file detected</p>}
        {previous.length > 0 && <details className="record-file-history"><summary><span>{previous.length} previous {previous.length === 1 ? 'file' : 'files'}</span><CaretDown size={14} /></summary><div>{previous.map(document => <DocumentRecord key={document.id} applicationId={application.id} document={document} versions={versions} />)}</div></details>}
      </div>;
    })}</div>
    <p className="record-document-help">With browser tracking on, the extension detects files you choose on supported application pages. Detection does not confirm the employer received the file.</p>
  </section>;
}

export default function ApplicationDetail({ application, onClose, onChange, onEdit, onDelete, onTaskToggle, onError, onRestoreFocus }: {
  application: Application; onClose: () => void; onChange: () => void; onEdit: () => void;
  onDelete: () => void; onTaskToggle: (task: Task) => void; onError: (message: string) => void;
  onRestoreFocus?: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('details');
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDate, setTaskDate] = useState('');
  const [taskTime, setTaskTime] = useState('');
  const [taskUrl, setTaskUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [taskBusy, setTaskBusy] = useState('');
  const [taskError, setTaskError] = useState('');
  const [noteDraft, setNoteDraft] = useState(application.notes);
  const [noteDirty, setNoteDirty] = useState(false);
  const incomingNotes = useRef(application.notes);
  const [noteStatus, setNoteStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showCompleted, setShowCompleted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Evidence | null>(null);
  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(new Set());
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});
  const tabPrefix = useId();
  const pending = application.evidence.filter(item => item.review === 'pending').length;
  const jobLink = safeUrl(application.url);
  const incompleteTasks = application.tasks.filter(task => !task.completedAt);
  const completedTasks = application.tasks.filter(task => !!task.completedAt);
  const acceptedSources = new Set(application.evidence.filter(item => item.kind === 'submission_confirmed' && item.review === 'accepted').map(item => item.source));
  const confirmation = acceptedSources.has('email') ? 'Email confirmed' : acceptedSources.has('browser') ? 'Browser confirmed' : acceptedSources.has('visual') ? 'Screen confirmed' : acceptedSources.has('manual') ? 'Manually recorded' : 'Not recorded';
  const hasConfirmation = acceptedSources.size > 0;

  useEffect(() => { if (incomingNotes.current !== application.notes) { incomingNotes.current = application.notes; if (!noteDirty) setNoteDraft(application.notes); } }, [application.notes, noteDirty]);

  function closeDetail() {
    if (noteDirty) setDiscardOpen(true);
    else onClose();
  }
  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, value: DetailTab) {
    let next = TABS.indexOf(value);
    if (event.key === 'ArrowRight') next = (next + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (next - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault(); setTab(TABS[next]); tabRefs.current[TABS[next]]?.focus();
  }
  async function patch(body: Record<string, unknown>, action: string) {
    setBusy(action);
    try { await api(`/applications/${application.id}`, { method: 'PATCH', body: JSON.stringify(body) }); onChange(); return true; }
    catch (error) { onError(error instanceof Error ? error.message : 'Could not save changes.'); return false; }
    finally { setBusy(''); }
  }
  async function saveNotes() {
    setNoteStatus('saving');
    if (await patch({ notes: noteDraft }, 'notes')) { setNoteDirty(false); setNoteStatus('saved'); }
    else setNoteStatus('error');
  }
  async function addTask(event: FormEvent) {
    event.preventDefault(); setBusy('task'); setTaskError('');
    try {
      const dueAt = taskDate ? taskTime ? new Date(`${taskDate}T${taskTime}`).toISOString() : taskDate : null;
      await api(`/applications/${application.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: taskTitle.trim(), dueAt, url: taskUrl || null }) });
      setAddingTask(false); setTaskTitle(''); setTaskDate(''); setTaskTime(''); setTaskUrl(''); onChange();
    } catch (error) { setTaskError(error instanceof Error ? error.message : 'Could not add task.'); }
    finally { setBusy(''); }
  }
  async function toggleTask(task: Task) {
    setTaskBusy(task.id);
    try { await onTaskToggle(task); }
    finally { setTaskBusy(''); }
  }
  async function review(id: string, action: 'accept' | 'dismiss') {
    setBusy(id);
    try { await api(`/evidence/${id}/review`, { method: 'POST', body: JSON.stringify({ action }) }); onChange(); }
    catch (error) { onError(error instanceof Error ? error.message : 'Could not review evidence.'); }
    finally { setBusy(''); }
  }
  function metadata(label: string, value: ReactNode, missing = false) {
    return <div className="record-data-row"><dt>{label}</dt><dd className={missing ? 'record-missing' : undefined}>{missing ? 'Not provided' : value}</dd></div>;
  }
  function toggleExcerpt(id: string) {
    setExpandedEvidence(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  return <>
    <Dialog.Root open onOpenChange={value => { if (!value) closeDetail(); }}>
      <Dialog.Portal><Dialog.Overlay className="drawer-overlay" /><Dialog.Content className="detail-drawer record-pane" aria-describedby={undefined} onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus(); } }}>
        <div className="record-toolbar"><span>Application record</span><div><button className="button quiet small" aria-label="Edit application" onClick={onEdit}><PencilSimple size={16} />Edit</button><button className="icon-button" aria-label="Close application" onClick={closeDetail}><X size={20} /></button></div></div>
        <header className="record-header">
          <div className="record-company"><CompanyMark company={application.company} small /><span>{application.company}</span><button className={`record-priority${application.priority === 'high' ? ' selected' : ''}`} onClick={() => void patch({ priority: application.priority === 'high' ? 'normal' : 'high' }, 'priority')} disabled={!!busy} aria-pressed={application.priority === 'high'} aria-label={application.priority === 'high' ? 'Remove high priority' : 'Mark as high priority'} title={application.priority === 'high' ? 'High priority' : 'Mark as high priority'}><Flag size={17} weight={application.priority === 'high' ? 'fill' : 'regular'} /></button></div>
          <Dialog.Title title={application.role} tabIndex={application.role.length > 120 ? 0 : undefined}>{application.role}</Dialog.Title>
          <div className="record-subtitle">{application.location && <span><MapPin size={14} />{application.location}</span>}{application.workMode && <span>{application.workMode}</span>}{jobLink && <a href={jobLink} target="_blank" rel="noreferrer">View job posting<ArrowUpRight size={14} /></a>}</div>
          <div className="record-summary"><div><span>Stage</span><label className="sr-only" htmlFor={`${tabPrefix}-stage`}>Application stage</label><select id={`${tabPrefix}-stage`} value={application.stage} onChange={event => void patch({ stage: event.target.value }, 'stage')} disabled={!!busy}>{STAGES.map(stage => <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>)}</select></div><div><span>Applied</span><strong>{application.appliedAt ? dateLabel(application.appliedAt, true) : 'Not provided'}</strong></div><div><span>Confirmation</span><button className="record-confirmation" onClick={() => setTab('evidence')}>{hasConfirmation ? <ShieldCheck size={15} /> : <Clock size={15} />}{confirmation}<CaretDown size={12} /></button></div></div>
        </header>
        <div className="record-tab-bar"><div className="record-tabs" role="tablist" aria-label="Application information">{TABS.map(value => <button key={value} ref={node => { tabRefs.current[value] = node; }} id={`${tabPrefix}-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls={`${tabPrefix}-panel-${value}`} tabIndex={tab === value ? 0 : -1} onKeyDown={event => handleTabKey(event, value)} onClick={() => setTab(value)} className={tab === value ? 'selected' : ''}>{value.charAt(0).toUpperCase() + value.slice(1)}{value === 'evidence' && pending > 0 && <span className="record-tab-count">{pending}</span>}</button>)}</div></div>
        <div className="record-content" role="tabpanel" id={`${tabPrefix}-panel-${tab}`} aria-labelledby={`${tabPrefix}-tab-${tab}`} tabIndex={0}>
          {tab === 'details' && <>
            <section className="record-section"><div className="record-section-heading"><h3>Next steps{incompleteTasks.length > 0 && <span>{incompleteTasks.length}</span>}</h3><button className="text-button" onClick={() => setAddingTask(value => !value)} aria-expanded={addingTask} aria-controls={`${tabPrefix}-task-form`}><Plus size={15} />Add task</button></div>
              {incompleteTasks.length ? <div className="record-tasks">{incompleteTasks.map(task => <TaskRow key={task.id} task={task} application={application} onToggle={toggleTask} busy={taskBusy === task.id} />)}</div> : !addingTask && <div className="record-inline-empty"><CheckCircle size={20} /><div><strong>No outstanding tasks</strong><p>Add an assessment, interview or follow-up.</p></div></div>}
              {completedTasks.length > 0 && <details className="record-completed" open={showCompleted} onToggle={event => setShowCompleted(event.currentTarget.open)}><summary>{completedTasks.length} completed {completedTasks.length === 1 ? 'task' : 'tasks'}<CaretDown size={14} /></summary><div className="record-tasks">{completedTasks.map(task => <TaskRow key={task.id} task={task} application={application} onToggle={toggleTask} busy={taskBusy === task.id} />)}</div></details>}
              {addingTask && <form id={`${tabPrefix}-task-form`} className="inline-task-form record-task-form" onSubmit={addTask}><label className="field"><span>Task</span><input autoFocus value={taskTitle} onChange={event => setTaskTitle(event.target.value)} required placeholder="Complete assessment" maxLength={300} /></label><div className="form-grid"><label className="field"><span>Due date</span><input type="date" value={taskDate} onChange={event => setTaskDate(event.target.value)} /></label><label className="field"><span>Time <span className="record-optional">optional</span></span><input type="time" value={taskTime} onChange={event => setTaskTime(event.target.value)} disabled={!taskDate} /></label></div>{taskTime && taskDate && <p className="record-form-help">Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>}<label className="field"><span>Link <span className="record-optional">optional</span></span><input type="url" value={taskUrl} onChange={event => setTaskUrl(event.target.value)} placeholder="https://" /></label>{taskError && <p className="form-error" role="alert">{taskError}</p>}<div className="record-form-actions"><button type="button" className="button secondary small" onClick={() => setAddingTask(false)} disabled={busy === 'task'}>Cancel</button><button className="button primary small" disabled={busy === 'task' || !taskTitle.trim()}>{busy === 'task' ? 'Saving…' : 'Add task'}</button></div></form>}
            </section>
            <section className="record-section"><div className="record-section-heading"><h3>Application</h3><button className="text-button" onClick={onEdit}>Edit details<ArrowUpRight size={14} /></button></div><dl className="record-data">{metadata('Email used', application.email, !application.email)}{metadata('Job reference', application.jobId, !application.jobId)}{metadata('Salary', application.salary, !application.salary)}{metadata('Location', application.location, !application.location)}{metadata('Work arrangement', application.workMode, !application.workMode)}</dl></section>
            <section className="record-section"><div className="record-section-heading"><h3>Recruiter</h3></div>{application.recruiterName || application.recruiterEmail ? <dl className="record-data">{metadata('Name', application.recruiterName, !application.recruiterName)}{metadata('Email', safeUrl(`mailto:${application.recruiterEmail}`) && application.recruiterEmail ? <a href={`mailto:${application.recruiterEmail}`}>{application.recruiterEmail}<ArrowUpRight size={13} /></a> : null, !application.recruiterEmail)}</dl> : <p className="record-empty-copy">No recruiter details added.</p>}</section>
            <ApplicationDocuments application={application} />
            <section className="record-section record-notes"><div className="record-section-heading"><h3>Notes</h3><span className={`record-note-status${noteStatus === 'error' ? ' error' : ''}`} role="status">{noteStatus === 'saving' ? 'Saving…' : noteDirty ? noteStatus === 'error' ? 'Could not save' : 'Unsaved changes' : noteStatus === 'saved' ? <><Check size={13} />Saved</> : ''}</span></div><textarea className="notes-input" aria-label="Application notes" value={noteDraft} onChange={event => { setNoteDraft(event.target.value); setNoteDirty(event.target.value !== application.notes); setNoteStatus('idle'); }} placeholder="Preparation notes, questions or anything to remember." rows={4} maxLength={20000} /><div className="record-note-actions"><span>Only visible in your workspace</span><button className="button primary small" disabled={!noteDirty || !!busy} onClick={() => void saveNotes()}>{noteStatus === 'saving' ? 'Saving…' : 'Save notes'}</button></div></section>
            <section className="record-section"><details className="record-description"><summary><span>Saved job description</span><CaretDown size={16} /></summary>{application.description ? <p>{application.description}</p> : <p className="record-empty-copy">No job description saved. Add it in Edit application.</p>}</details></section>
            <footer className="record-footer"><span>Added {dateLabel(application.createdAt, true)}</span><button className="text-button danger-text" onClick={() => setDeleteOpen(true)}><Trash size={15} />Delete application</button></footer>
          </>}
          {tab === 'activity' && <section className="record-history"><div className="record-section-heading"><h3>Application timeline</h3><span className="record-section-note">{application.timeline.length} updates</span></div>{application.timeline.length ? <ol>{application.timeline.map(item => <li key={item.id}><span className="record-event-icon"><SourceIcon source={item.source} size={16} /></span><div><div className="record-event-top"><strong>{item.title}</strong><time dateTime={item.createdAt}>{timestamp(item.createdAt)}</time></div><p>{item.detail}</p><span className="record-event-source">{SOURCE_NAMES[item.source]}</span></div></li>)}</ol> : <div className="record-panel-empty"><Clock size={27} /><h4>No activity yet</h4><p>Stage changes, messages and completed tasks will appear here.</p></div>}</section>}
          {tab === 'evidence' && <section className="record-evidence"><div className="record-section-heading"><h3>Confirmation sources</h3><span className="record-section-note">{application.evidence.length} {application.evidence.length === 1 ? 'record' : 'records'}</span></div><p className="record-evidence-explainer">Browser and screen capture can show the same confirmation. A matching email is a separate source.</p>{pending > 0 && <div className="record-review-notice"><WarningCircle size={18} /><span>{pending} {pending === 1 ? 'update needs' : 'updates need'} your review.</span></div>}{application.evidence.length ? <div className="record-evidence-list">{application.evidence.map(item => { const expanded = expandedEvidence.has(item.id); const isLong = !!item.excerpt && item.excerpt.length > 340; return <article className={`record-evidence-item ${item.review}`} key={item.id}><div className="record-evidence-heading"><span><SourceIcon source={item.source} /><strong>{SOURCE_NAMES[item.source]}</strong></span><span className="record-evidence-state">{item.review === 'accepted' ? <><Check size={12} />Recorded</> : item.review === 'pending' ? 'Needs review' : 'Dismissed'}</span></div><h4>{item.summary}</h4><time dateTime={item.observedAt}>{timestamp(item.observedAt)}</time>{item.excerpt && <div className="record-excerpt"><blockquote id={`${tabPrefix}-excerpt-${item.id}`} className={expanded ? 'expanded' : ''}>{isLong && !expanded ? `${item.excerpt.slice(0, 340).trimEnd()}…` : item.excerpt}</blockquote>{isLong && <button className="text-button" aria-expanded={expanded} aria-controls={`${tabPrefix}-excerpt-${item.id}`} onClick={() => toggleExcerpt(item.id)}>{expanded ? 'Show less' : 'Show full message'}<CaretDown size={13} /></button>}</div>}<div className="record-evidence-links">{safeUrl(item.url) && <a href={safeUrl(item.url)} target="_blank" rel="noreferrer">View source<ArrowUpRight size={14} /></a>}{item.snapshot && <button className="text-button" onClick={() => setSnapshot(item)}><Monitor size={14} />View capture</button>}</div>{item.review === 'pending' && <div className="record-evidence-actions"><button className="button primary small" disabled={!!busy} onClick={() => void review(item.id, 'accept')}>{busy === item.id ? 'Saving…' : 'Accept update'}</button><button className="button secondary small" disabled={!!busy} onClick={() => void review(item.id, 'dismiss')}>Dismiss</button></div>}</article>; })}</div> : <div className="record-panel-empty"><ShieldCheck size={27} /><h4>No confirmation evidence</h4><p>Captured submission messages and matched emails will appear here.</p></div>}</section>}
        </div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete application?" description={`This removes the ${application.role} application at ${application.company}, including its tasks and evidence.`}><div className="modal-footer"><button className="button secondary" onClick={() => setDeleteOpen(false)}>Keep application</button><button className="button danger" onClick={() => { setDeleteOpen(false); onDelete(); }}>Delete application</button></div></Modal>
    <Modal open={discardOpen} onClose={() => setDiscardOpen(false)} title="Discard unsaved notes?" description="Your latest notes have not been saved."><div className="modal-footer"><button className="button secondary" onClick={() => setDiscardOpen(false)}>Keep editing</button><button className="button danger" onClick={() => { setDiscardOpen(false); onClose(); }}>Discard notes</button></div></Modal>
    <Modal open={!!snapshot} onClose={() => setSnapshot(null)} title="Confirmation capture" description={snapshot?.summary} wide><div className="modal-body">{snapshot?.snapshot && <img className="evidence-snapshot" src={snapshot.snapshot} alt="Captured application confirmation" />}</div></Modal>
  </>;
}
