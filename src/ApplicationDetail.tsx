import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, Check, Clock, EnvelopeSimple, FileText, Flag, Monitor, PencilSimple, Plus, Trash, X } from '@phosphor-icons/react';
import type { Application, Evidence, Task } from '../shared/types';
import { STAGES, STAGE_LABELS } from '../shared/types';
import { api, safeUrl } from './api';
import { CompanyMark, dateLabel, Modal, StageBadge, TaskRow } from './ui';

export default function ApplicationDetail({ application, onClose, onChange, onEdit, onDelete, onTaskToggle, onError }: {
  application: Application; onClose: () => void; onChange: () => void; onEdit: () => void;
  onDelete: () => void; onTaskToggle: (task: Task) => void; onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<'details' | 'activity' | 'evidence'>('details');
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDate, setTaskDate] = useState('');
  const [taskUrl, setTaskUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [noteDraft, setNoteDraft] = useState(application.notes);
  const [noteDirty, setNoteDirty] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Evidence | null>(null);
  const pending = application.evidence.filter(e => e.review === 'pending').length;
  const jobLink = safeUrl(application.url);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try { await api(`/applications/${application.id}`, { method: 'PATCH', body: JSON.stringify(body) }); onChange(); return true; }
    catch (error) { onError(error instanceof Error ? error.message : 'Could not save changes.'); return false; }
    finally { setSaving(false); }
  }
  async function addTask(event: React.FormEvent) {
    event.preventDefault(); setSaving(true);
    try {
      await api(`/applications/${application.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: taskTitle, dueAt: taskDate ? new Date(taskDate).toISOString() : null, url: taskUrl || null }) });
      setAddingTask(false); setTaskTitle(''); setTaskDate(''); setTaskUrl(''); onChange();
    } catch (error) { onError(error instanceof Error ? error.message : 'Could not add task.'); }
    finally { setSaving(false); }
  }
  async function review(id: string, action: 'accept' | 'dismiss') {
    setSaving(true);
    try { await api(`/evidence/${id}/review`, { method: 'POST', body: JSON.stringify({ action }) }); onChange(); }
    catch (error) { onError(error instanceof Error ? error.message : 'Could not review evidence.'); }
    finally { setSaving(false); }
  }
  function meta(label: string, value: string | null | undefined) { return <div className="metadata-item"><dt>{label}</dt><dd>{value || <span className="not-provided">Not provided</span>}</dd></div>; }

  return <>
    <Dialog.Root open onOpenChange={value => { if (!value) onClose(); }}>
      <Dialog.Portal><Dialog.Overlay className="drawer-overlay" /><Dialog.Content className="detail-drawer" aria-describedby={undefined}>
        <div className="drawer-toolbar"><span>Application details</span><div className="toolbar-actions"><button className="icon-button" aria-label="Edit application" onClick={onEdit}><PencilSimple size={19} /></button><Dialog.Close className="icon-button" aria-label="Close application"><X size={20} /></Dialog.Close></div></div>
        <div className="drawer-intro"><CompanyMark company={application.company} /><div><p>{application.company}</p><Dialog.Title>{application.role}</Dialog.Title><div className="drawer-location">{[application.location, application.workMode].filter(Boolean).join(' · ') || 'Location not provided'}</div></div></div>
        <div className="drawer-status-row"><label className="sr-only" htmlFor="detail-stage">Application stage</label><select id="detail-stage" value={application.stage} onChange={event => void patch({ stage: event.target.value })} disabled={saving}>{STAGES.map(stage => <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>)}</select>
          <button className={`button quiet small${application.priority === 'high' ? ' priority-selected' : ''}`} onClick={() => void patch({ priority: application.priority === 'high' ? 'normal' : 'high' })} aria-pressed={application.priority === 'high'}><Flag size={15} weight={application.priority === 'high' ? 'fill' : 'regular'} />High priority</button>
          {jobLink && <a className="button quiet small" href={jobLink} target="_blank" rel="noreferrer">Job posting<ArrowUpRight size={15} /></a>}
        </div>
        <div className="detail-tabs" role="tablist" aria-label="Application information">{(['details', 'activity', 'evidence'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={tab === value ? 'selected' : ''}>{value.charAt(0).toUpperCase() + value.slice(1)}{value === 'evidence' && pending > 0 && <span className="count-pill">{pending}</span>}</button>)}</div>
        <div className="drawer-body">
          {tab === 'details' && <>
            <section className="detail-section"><div className="section-heading compact"><h3>Next steps</h3><button className="text-button" onClick={() => setAddingTask(value => !value)}><Plus size={15} />Add task</button></div>
              {application.tasks.length ? <div className="detail-tasks">{application.tasks.map(task => <TaskRow key={task.id} task={task} application={application} onToggle={onTaskToggle} />)}</div> : !addingTask && <p className="section-empty">No tasks yet. Add an assessment, interview or follow-up.</p>}
              {addingTask && <form className="inline-task-form" onSubmit={addTask}><label className="field"><span>Task</span><input autoFocus value={taskTitle} onChange={event => setTaskTitle(event.target.value)} required placeholder="Complete assessment" maxLength={300} /></label><div className="form-grid"><label className="field"><span>Deadline</span><input type="datetime-local" value={taskDate} onChange={event => setTaskDate(event.target.value)} /></label><label className="field"><span>Link</span><input type="url" value={taskUrl} onChange={event => setTaskUrl(event.target.value)} placeholder="https://" /></label></div><div className="inline-form-actions"><button type="button" className="button secondary small" onClick={() => setAddingTask(false)}>Cancel</button><button className="button primary small" disabled={saving}>{saving ? 'Saving…' : 'Add task'}</button></div></form>}
            </section>
            <section className="detail-section"><div className="section-heading compact"><h3>Application</h3></div><dl className="metadata-grid">{meta('Date applied', application.appliedAt ? dateLabel(application.appliedAt, true) : null)}{meta('Salary', application.salary)}{meta('Email used', application.email)}{meta('Job reference', application.jobId)}{meta('Recruiter', application.recruiterName)}{meta('Recruiter email', application.recruiterEmail)}</dl></section>
            <section className="detail-section"><div className="section-heading compact"><h3>Documents</h3></div><div className="document-reference"><FileText size={20} /><div><strong>CV</strong><span>{application.resumeName || 'Not provided'}</span></div></div><div className="document-reference"><FileText size={20} /><div><strong>Cover letter</strong><span>{application.coverLetterName || 'Not provided'}</span></div></div></section>
            <section className="detail-section"><div className="section-heading compact"><h3>Notes</h3>{noteDirty && <button className="text-button" disabled={saving} onClick={async () => { if (await patch({ notes: noteDraft })) setNoteDirty(false); }}>{saving ? 'Saving…' : 'Save notes'}</button>}</div><textarea className="notes-input" aria-label="Application notes" value={noteDraft} onChange={event => { setNoteDraft(event.target.value); setNoteDirty(true); }} placeholder="Add preparation notes or anything to remember." rows={4} maxLength={20000} /></section>
            {application.description && <section className="detail-section"><details className="description-details"><summary>Saved job description</summary><p>{application.description}</p></details></section>}
            <button className="text-button danger-text" onClick={() => setDeleteOpen(true)}><Trash size={15} />Delete application</button>
          </>}
          {tab === 'activity' && <section><h3 className="detail-tab-heading">Application timeline</h3>{application.timeline.length ? <ol className="timeline">{application.timeline.map(item => <li key={item.id}><span className="timeline-mark"><Clock size={14} /></span><div><strong>{item.title}</strong><p>{item.detail}</p><span>{dateLabel(item.createdAt, true)} · {item.source}</span></div></li>)}</ol> : <p className="section-empty">Updates will appear here as your application progresses.</p>}</section>}
          {tab === 'evidence' && <section><h3 className="detail-tab-heading">Confirmation sources</h3><p className="section-explainer">Browser and screen evidence may show the same confirmation. Email provides a separate source.</p>{application.evidence.length ? <div className="evidence-list">{application.evidence.map(item => <article className={`evidence-item ${item.review}`} key={item.id}><div className="evidence-heading"><span>{item.source === 'email' ? <EnvelopeSimple size={17} /> : item.source === 'visual' ? <Monitor size={17} /> : <Check size={17} />}<strong>{item.source === 'visual' ? 'Screen capture' : item.source === 'email' ? 'Email' : item.source === 'browser' ? 'Browser' : 'Manual'}</strong></span><span className="evidence-state">{item.review === 'accepted' ? 'Recorded' : item.review === 'pending' ? 'Needs review' : 'Dismissed'}</span></div><p>{item.summary}</p>{item.excerpt && <blockquote>{item.excerpt}</blockquote>}<div className="evidence-meta"><span>{dateLabel(item.observedAt, true)}</span>{safeUrl(item.url) && <a href={safeUrl(item.url)} target="_blank" rel="noreferrer">View source<ArrowUpRight size={13} /></a>}{item.snapshot && <button className="text-button" onClick={() => setSnapshot(item)}>View capture</button>}</div>{item.review === 'pending' && <div className="evidence-actions"><button className="button primary small" disabled={saving} onClick={() => void review(item.id, 'accept')}>Accept update</button><button className="button secondary small" disabled={saving} onClick={() => void review(item.id, 'dismiss')}>Dismiss</button></div>}</article>)}</div> : <p className="section-empty">No confirmation evidence has been captured for this application.</p>}</section>}
        </div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete application?" description={`This removes ${application.company}'s ${application.role} application and its saved tasks and evidence.`}><div className="modal-footer"><button className="button secondary" onClick={() => setDeleteOpen(false)}>Keep application</button><button className="button danger" onClick={onDelete}>Delete application</button></div></Modal>
    <Modal open={!!snapshot} onClose={() => setSnapshot(null)} title="Confirmation capture" description={snapshot?.summary} wide><div className="modal-body">{snapshot?.snapshot && <img className="evidence-snapshot" src={snapshot.snapshot} alt="Captured application confirmation" />}</div></Modal>
  </>;
}
