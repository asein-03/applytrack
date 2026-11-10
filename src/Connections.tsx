import { useEffect, useState, type FormEvent } from 'react';
import { ArrowClockwise, ArrowUpRight, Check, Copy, DownloadSimple, EnvelopeSimple, FileText, LinkSimple, Plus, ShieldCheck, Trash } from '@phosphor-icons/react';
import type { Application, Settings, Workspace } from '../shared/types';
import { api } from './api';
import { dateLabel, Modal } from './ui';

interface ReviewItem { id: string; subject: string; from: string; body: string; receivedAt: string; workspace: Workspace; kind: string; }

export default function Connections({ settings, applications, workspace, onChange, notify }: {
  settings: Settings | null; applications: Application[]; workspace: Workspace;
  onChange: () => void; notify: (message: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [text, setText] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [selected, setSelected] = useState<ReviewItem | null>(null);
  const [selectedApplication, setSelectedApplication] = useState('');
  const [importError, setImportError] = useState('');
  const [reviewError, setReviewError] = useState('');

  async function loadReview() {
    try { const result = await api<{ items: ReviewItem[] }>(`/email/review?workspace=${workspace}`); setItems(result.items.filter(item => item.workspace === workspace)); setReviewError(''); }
    catch (error) { setReviewError(error instanceof Error ? error.message : 'Could not load emails awaiting review.'); }
  }
  useEffect(() => { void loadReview(); }, [workspace]);

  async function connect() {
    setBusy('connect');
    try { const result = await api<{ url: string }>('/inboxes/google/connect', { method: 'POST' }); window.location.assign(result.url); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not connect Gmail.', true); }
    finally { setBusy(''); }
  }
  async function inboxAction(id: string, action: 'sync' | 'disconnect') {
    setBusy(id);
    try {
      await api(`/inboxes/${id}${action === 'sync' ? '/sync' : ''}`, { method: action === 'sync' ? 'POST' : 'DELETE' });
      notify(action === 'sync' ? 'Inbox checked for updates.' : 'Inbox disconnected.'); onChange(); await loadReview();
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not update inbox.', true); }
    finally { setBusy(''); }
  }
  async function importEmail(event: FormEvent) {
    event.preventDefault(); setBusy('import'); setImportError('');
    try {
      const result = await api<{ queued?: boolean; message?: string }>('/email/import', { method: 'POST', body: JSON.stringify({ text, workspace, ...(applicationId ? { applicationId } : {}) }) });
      notify(result.message || (result.queued ? 'Email saved for review.' : 'Email added to the application.')); setImportOpen(false); setText(''); setApplicationId(''); onChange(); await loadReview();
    } catch (error) { setImportError(error instanceof Error ? error.message : 'Could not import email.'); }
    finally { setBusy(''); }
  }
  async function resolveReview(action: 'assign' | 'dismiss') {
    if (!selected) return; setBusy('review');
    try {
      await api(`/email/review/${selected.id}${action === 'assign' ? '/assign' : ''}`, { method: action === 'assign' ? 'POST' : 'DELETE', ...(action === 'assign' ? { body: JSON.stringify({ applicationId: selectedApplication }) } : {}) });
      setSelected(null); setSelectedApplication(''); await loadReview(); onChange(); notify(action === 'assign' ? 'Email assigned to application.' : 'Email dismissed.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not resolve email.', true); }
    finally { setBusy(''); }
  }

  return <div className="connections-layout">
    {reviewError && <div className="error-banner" role="alert"><span>{reviewError}</span><button className="button secondary small" onClick={() => void loadReview()}>Try again</button></div>}
    <section className="connection-section"><div className="connection-section-title"><span className="connection-icon"><EnvelopeSimple size={23} /></span><div><h2>Email accounts</h2><p>Bring application confirmations and next steps into your tracker.</p></div></div>
      {settings?.inboxes?.length ? <div className="inbox-list">{settings.inboxes.map(inbox => <div className="inbox-row" key={inbox.id}><div className="inbox-avatar">G</div><div className="inbox-copy"><strong>{inbox.email}</strong><span className={inbox.status === 'error' ? 'danger-text' : ''}>{inbox.status === 'error' ? inbox.error || 'Connection needs attention' : inbox.lastSyncAt ? `Last checked ${dateLabel(inbox.lastSyncAt)}` : 'Connected, waiting for first sync'}</span></div><button className="button secondary small" onClick={() => void inboxAction(inbox.id, 'sync')} disabled={busy === inbox.id}><ArrowClockwise size={15} />{busy === inbox.id ? 'Working…' : 'Sync'}</button><button className="icon-button" aria-label={`Disconnect ${inbox.email}`} onClick={() => void inboxAction(inbox.id, 'disconnect')} disabled={busy === inbox.id}><Trash size={17} /></button></div>)}</div> : <div className="connection-empty"><p>No email accounts connected.</p><span>Application tracking works without an inbox connection.</span></div>}
      <div className="connection-actions"><button className="button primary" onClick={() => void connect()} disabled={busy === 'connect' || !settings?.gmailConfigured}><Plus size={17} />{busy === 'connect' ? 'Connecting…' : 'Connect Gmail'}</button><button className="button secondary" onClick={() => setImportOpen(true)}><FileText size={17} />Import email</button></div>
      {!settings?.gmailConfigured && <details className="setup-note"><summary>Google setup required</summary><p>Set a Google OAuth client ID and client secret in the local server’s <code>.env</code> file. Restart the server, then connect your account.</p><p>Redirect URI: <code>http://127.0.0.1:4318/api/inboxes/google/callback</code></p><p>You can import an email while account setup is pending.</p></details>}
    </section>
    {items.length > 0 && <section className="connection-section"><div className="section-heading"><h2>Emails to review <span className="count-pill">{items.length}</span></h2></div><p className="section-explainer">Choose an application for messages that could not be matched automatically.</p><div className="review-list">{items.map(item => <button key={item.id} className="email-review-row" onClick={() => { setSelected(item); setSelectedApplication(''); }}><EnvelopeSimple size={20} /><span><strong>{item.subject || 'Untitled email'}</strong><span>{item.from || 'Sender not provided'}</span></span><span className="muted">{dateLabel(item.receivedAt)}</span><ArrowUpRight size={16} /></button>)}</div></section>}
    <section className="connection-section"><div className="connection-section-title"><span className="connection-icon"><LinkSimple size={23} /></span><div><h2>Browser extension</h2><p>Read job details and capture submission confirmations as you apply.</p></div></div>
      <ol className="setup-steps"><li><span className="step-number">1</span><div><strong>Install the extension</strong><p>Download and unzip the extension. Open Chrome’s Extensions page, enable Developer mode and select Load unpacked.</p><a className="button secondary small" href="/api/extension/download" download><DownloadSimple size={16} />Download extension</a></div></li><li><span className="step-number">2</span><div><strong>Pair with this dashboard</strong><p>Paste this code into the extension’s connection settings.</p><div className="pairing-code"><code>{showToken ? settings?.extensionToken || 'Loading…' : '••••••••••••••••••••••••'}</code><button className="text-button" onClick={() => setShowToken(value => !value)}>{showToken ? 'Hide' : 'Show'}</button><button className="icon-button" aria-label="Copy pairing code" disabled={!settings?.extensionToken} onClick={async () => { try { await navigator.clipboard.writeText(settings!.extensionToken); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { notify('Could not copy code. Reveal it and copy manually.', true); } }}>{copied ? <Check size={17} /> : <Copy size={17} />}</button></div></div></li><li><span className="step-number">3</span><div><strong>Start a tracking session</strong><p>Select Start tracking before applying. Enable screen capture for a second reading of on-screen confirmations.</p></div></li></ol>
    </section>
    <div className="privacy-note"><ShieldCheck size={19} /><p>Your application database and capture evidence are stored on this computer. Connected inboxes are checked only while the local server is running.</p></div>
    <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import an email" description="Paste a confirmation, assessment invitation or recruiter response." wide><form onSubmit={importEmail}><div className="modal-body"><label className="field"><span>Email text</span><textarea rows={9} value={text} onChange={event => setText(event.target.value)} placeholder={'From: recruiter@example.com\nSubject: Your application\n\nPaste the message here.'} required maxLength={100000} /></label><label className="field"><span>Application</span><select value={applicationId} onChange={event => setApplicationId(event.target.value)}><option value="">Match automatically</option>{applications.map(application => <option key={application.id} value={application.id}>{application.company} · {application.role}</option>)}</select></label><p className="field-help">Unclear matches are saved for review. No email is sent.</p>{importError && <p className="form-error" role="alert">{importError}</p>}</div><div className="modal-footer"><button className="button secondary" type="button" onClick={() => setImportOpen(false)}>Cancel</button><button className="button primary" disabled={busy === 'import'}>{busy === 'import' ? 'Importing…' : 'Import email'}</button></div></form></Modal>
    <Modal open={!!selected} onClose={() => setSelected(null)} title="Review email" description={selected?.subject || 'Choose the application this message belongs to.'} wide><div className="modal-body"><p className="muted">{selected?.from}</p><pre className="email-body">{selected?.body}</pre><label className="field"><span>Assign to application</span><select value={selectedApplication} onChange={event => setSelectedApplication(event.target.value)}><option value="">Choose an application</option>{applications.map(application => <option key={application.id} value={application.id}>{application.company} · {application.role}</option>)}</select></label></div><div className="modal-footer split"><button className="button quiet" onClick={() => void resolveReview('dismiss')} disabled={busy === 'review'}>Dismiss email</button><button className="button primary" onClick={() => void resolveReview('assign')} disabled={!selectedApplication || busy === 'review'}>{busy === 'review' ? 'Saving…' : 'Assign email'}</button></div></Modal>
  </div>;
}
