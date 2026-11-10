import { useState, type FormEvent } from 'react';
import { CaretDown, FileText, UserCircle } from '@phosphor-icons/react';
import type { Application, Workspace } from '../shared/types';
import { STAGES, STAGE_LABELS } from '../shared/types';
import { api } from './api';
import { Modal } from './ui';
import './details.css';

function localDate(value?: string | null) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const blank = {
  company: '', role: '', stage: 'applied', location: '', workMode: '', salary: '', url: '', jobId: '',
  description: '', email: '', resumeName: '', coverLetterName: '', recruiterName: '', recruiterEmail: '',
  notes: '', priority: 'normal', appliedAt: '',
};

export default function ApplicationEditor({ application, workspace, onClose, onSaved }: {
  application?: Application; workspace: Workspace; onClose: () => void; onSaved: (application: Application) => void;
}) {
  const initialAppliedDate = application?.appliedAt ? localDate(application.appliedAt) : application ? '' : localDate();
  const [values, setValues] = useState<Record<string, string>>(application ? {
    ...Object.fromEntries(Object.keys(blank).map(key => [key, String(application[key as keyof Application] ?? '')])),
    appliedAt: initialAppliedDate,
  } : { ...blank, appliedAt: initialAppliedDate });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [jobExpanded, setJobExpanded] = useState(!!application && !!(application.location || application.salary || application.description));
  const [contactExpanded, setContactExpanded] = useState(false);
  const [documentsExpanded, setDocumentsExpanded] = useState(false);
  const update = (key: string, value: string) => setValues(current => ({ ...current, [key]: value }));
  const notSubmitted = !application && ['saved', 'in_progress'].includes(values.stage);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!values.company.trim() || !values.role.trim()) { setError('Enter a company name and job title.'); return; }
    setSaving(true);
    try {
      const appliedAt = notSubmitted ? null : application && values.appliedAt === initialAppliedDate ? application.appliedAt : values.appliedAt || null;
      const body = { ...values, company: values.company.trim(), role: values.role.trim(), ...(!application ? { workspace } : {}), appliedAt };
      const result = await api<Application>(application ? `/applications/${application.id}` : '/applications', { method: application ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      onSaved(result);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save application.'); }
    finally { setSaving(false); }
  }

  function field(key: string, label: string, type = 'text', required = false, placeholder = '') {
    return <label className="field" key={key}><span>{label}{required && <span className="required" aria-hidden="true"> *</span>}</span>
      <input name={key} type={type} value={key === 'appliedAt' && notSubmitted ? '' : values[key]} onChange={event => update(key, event.target.value)} required={required} disabled={saving || (key === 'appliedAt' && notSubmitted)} placeholder={placeholder} maxLength={key === 'url' ? 2048 : 500} />
    </label>;
  }

  return <Modal open onClose={() => { if (!saving) onClose(); }} title={application ? 'Edit application' : 'Add application'} description={application ? `${application.company} · ${application.role}` : 'Company and role are required. Everything else can be added later.'} wide>
    <form onSubmit={submit} className="record-editor">
      <div className="modal-body record-editor-body">
        <section className="record-editor-section"><div className="record-editor-section-heading"><h3>Role</h3>{workspace === 'demo' && <span>Demo workspace</span>}</div><div className="form-grid">{field('company', 'Company', 'text', true, 'Company name')}{field('role', 'Role', 'text', true, 'Job title')}</div>{field('url', 'Job link', 'url', false, 'https://')}</section>
        <section className="record-editor-section"><div className="record-editor-section-heading"><h3>Application</h3></div><div className="form-grid"><label className="field"><span>Stage</span><select value={values.stage} onChange={event => update('stage', event.target.value)} disabled={saving}>{STAGES.map(stage => <option value={stage} key={stage}>{STAGE_LABELS[stage]}</option>)}</select></label>{field('appliedAt', 'Date applied', 'date')}{field('email', 'Application email', 'email', false, 'Email used to apply')}<label className="field"><span>Priority</span><select value={values.priority} onChange={event => update('priority', event.target.value)} disabled={saving}><option value="normal">Normal</option><option value="high">High</option></select></label></div>{notSubmitted && <p className="record-form-help">The application date will stay empty until you submit.</p>}</section>
        <details className="record-editor-disclosure" open={jobExpanded} onToggle={event => setJobExpanded(event.currentTarget.open)}><summary><span><FileText size={18} /><strong>Job details</strong></span><span className="record-disclosure-caption">Location, salary and description<CaretDown size={15} /></span></summary><div className="record-disclosure-content"><div className="form-grid">{field('location', 'Location', 'text', false, 'City or country')}<label className="field"><span>Work arrangement</span><select value={values.workMode} onChange={event => update('workMode', event.target.value)} disabled={saving}><option value="">Not provided</option><option>Remote</option><option>Hybrid</option><option>On-site</option></select></label>{field('salary', 'Salary', 'text', false, 'As listed in the posting')}{field('jobId', 'Job reference')}</div><label className="field"><span>Job description</span><textarea value={values.description} onChange={event => update('description', event.target.value)} rows={5} maxLength={50000} disabled={saving} placeholder="Paste the original job description" /></label></div></details>
        <details className="record-editor-disclosure" open={contactExpanded} onToggle={event => setContactExpanded(event.currentTarget.open)}><summary><span><UserCircle size={19} /><strong>Recruiter</strong></span><span className="record-disclosure-caption">Name and contact details<CaretDown size={15} /></span></summary><div className="record-disclosure-content"><div className="form-grid">{field('recruiterName', 'Recruiter name')}{field('recruiterEmail', 'Recruiter email', 'email')}</div></div></details>
        <details className="record-editor-disclosure" open={documentsExpanded} onToggle={event => setDocumentsExpanded(event.currentTarget.open)}><summary><span><FileText size={18} /><strong>Documents</strong></span><span className="record-disclosure-caption">Filename references<CaretDown size={15} /></span></summary><div className="record-disclosure-content"><p className="record-form-help record-document-editor-help">These names are manual references. Editing them does not rename detected files or saved copies.</p><div className="form-grid">{field('resumeName', 'Resume filename reference', 'text', false, 'Resume.pdf')}{field('coverLetterName', 'Cover letter filename reference', 'text', false, 'Cover-letter.pdf')}</div>{!!application?.documents?.length && <p className="record-form-help">Detected files and earlier versions remain in the application record.</p>}</div></details>
        <section className="record-editor-section record-editor-notes"><label className="field"><span>Notes</span><textarea value={values.notes} onChange={event => update('notes', event.target.value)} rows={3} placeholder="Anything you want to remember" maxLength={20000} disabled={saving} /></label></section>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer record-editor-footer"><span>Application record</span><div><button type="button" className="button secondary" onClick={onClose} disabled={saving}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : application ? 'Save changes' : 'Add application'}</button></div></div>
    </form>
  </Modal>;
}
