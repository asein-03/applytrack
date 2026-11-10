import { useState, type FormEvent } from 'react';
import type { Application, Workspace } from '../shared/types';
import { STAGES, STAGE_LABELS } from '../shared/types';
import { api } from './api';
import { Modal } from './ui';

const blank = {
  company: '', role: '', stage: 'applied', location: '', workMode: '', salary: '', url: '', jobId: '',
  description: '', email: '', resumeName: '', coverLetterName: '', recruiterName: '', recruiterEmail: '',
  notes: '', priority: 'normal', appliedAt: new Date().toISOString().slice(0, 10),
};

export default function ApplicationEditor({ application, workspace, onClose, onSaved }: {
  application?: Application; workspace: Workspace; onClose: () => void; onSaved: (application: Application) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(application ? {
    ...Object.fromEntries(Object.keys(blank).map(key => [key, String(application[key as keyof Application] ?? '')])),
    appliedAt: application.appliedAt?.slice(0, 10) || '',
  } : blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const update = (key: string, value: string) => setValues(current => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      const body = { ...values, ...(!application ? { workspace } : {}), appliedAt: !application && ['saved', 'in_progress'].includes(values.stage) ? null : values.appliedAt || null };
      const result = await api<Application>(application ? `/applications/${application.id}` : '/applications', { method: application ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      onSaved(result);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save application.'); }
    finally { setSaving(false); }
  }

  function field(key: string, label: string, type = 'text', required = false, placeholder = '') {
    return <label className="field" key={key}><span>{label}{required && <span className="required" aria-hidden="true"> *</span>}</span>
      <input name={key} type={type} value={values[key]} onChange={event => update(key, event.target.value)} required={required} placeholder={placeholder} maxLength={key === 'url' ? 2048 : 500} />
    </label>;
  }

  return <Modal open onClose={onClose} title={application ? 'Edit application' : 'Add application'} description="Save what you know. You can add more details later." wide>
    <form onSubmit={submit}>
      <div className="modal-body form-body">
        <div className="form-grid">{field('company', 'Company', 'text', true, 'Company name')}{field('role', 'Role', 'text', true, 'Job title')}</div>
        {field('url', 'Job link', 'url', false, 'https://')}
        <div className="form-grid">
          <label className="field"><span>Stage</span><select value={values.stage} onChange={event => update('stage', event.target.value)}>{STAGES.map(stage => <option value={stage} key={stage}>{STAGE_LABELS[stage]}</option>)}</select></label>
          {field('appliedAt', 'Date applied', 'date')}
        </div>
        <details className="form-details" open={!!application}><summary>Job and contact details</summary>
          <div className="form-grid">{field('location', 'Location', 'text', false, 'City or country')}
            <label className="field"><span>Work arrangement</span><select value={values.workMode} onChange={event => update('workMode', event.target.value)}><option value="">Not provided</option><option>Remote</option><option>Hybrid</option><option>On-site</option></select></label>
            {field('salary', 'Salary', 'text', false, 'As listed in the posting')}{field('email', 'Application email', 'email')}
            {field('jobId', 'Job reference')}
            <label className="field"><span>Priority</span><select value={values.priority} onChange={event => update('priority', event.target.value)}><option value="normal">Normal</option><option value="high">High</option></select></label>
            {field('recruiterName', 'Recruiter name')}{field('recruiterEmail', 'Recruiter email', 'email')}
            {field('resumeName', 'CV filename')}{field('coverLetterName', 'Cover letter filename')}
          </div>
          <p className="field-help">Document names are references. Files are not uploaded.</p>
          <label className="field"><span>Job description</span><textarea value={values.description} onChange={event => update('description', event.target.value)} rows={5} maxLength={50000} /></label>
        </details>
        <label className="field"><span>Notes</span><textarea value={values.notes} onChange={event => update('notes', event.target.value)} rows={3} placeholder="Anything you want to remember" maxLength={20000} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : application ? 'Save changes' : 'Add application'}</button></div>
    </form>
  </Modal>;
}
