import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowClockwise, CaretDown, CaretRight, Check, Cloud, Copy, DownloadSimple, EnvelopeSimple, FileText, LinkSimple, Plus, SignOut, Trash, UserCircle, WarningCircle } from '@phosphor-icons/react';
import type { Application, Settings, Workspace } from '../shared/types';
import { api } from './api';
import { useCloudAccount } from './AuthGate';
import { dateLabel, Modal } from './ui';
import './connections.css';

interface ReviewItem { id: string; subject: string; from: string; body: string; receivedAt: string; workspace: Workspace; kind: string; }

function syncLabel(value: string | null) {
  if (!value) return 'Waiting for the first inbox check';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Last check unavailable';
  return `Last checked ${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

export default function Connections({ settings, applications, workspace, onChange, notify }: {
  settings: Settings | null; applications: Application[]; workspace: Workspace;
  onChange: () => void; notify: (message: string, error?: boolean) => void;
}) {
  const account = useCloudAccount();
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
  const [resolveError, setResolveError] = useState('');
  const [actionError, setActionError] = useState('');
  const [reviewLoading, setReviewLoading] = useState(true);
  const reviewRequest = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function loadReview(signal?: AbortSignal) {
    const request = ++reviewRequest.current;
    setReviewLoading(true);
    try {
      const result = await api<{ items: ReviewItem[] }>(`/email/review?workspace=${workspace}`, { signal });
      if (request !== reviewRequest.current || signal?.aborted) return;
      setItems(result.items.filter(item => item.workspace === workspace));
      setReviewError('');
    } catch (error) {
      if (request !== reviewRequest.current || signal?.aborted) return;
      setReviewError(error instanceof Error ? error.message : 'Could not load emails awaiting review.');
    } finally {
      if (request === reviewRequest.current && !signal?.aborted) setReviewLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setSelected(null); setResolveError('');
    void loadReview(controller.signal);
    const refresh = setInterval(() => { void loadReview(controller.signal); }, 30_000);
    return () => { clearInterval(refresh); controller.abort(); };
  }, [workspace]);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  async function connect() {
    setBusy('connect'); setActionError('');
    try {
      const result = await api<{ url: string }>('/inboxes/google/connect', { method: 'POST' });
      window.location.assign(result.url);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not connect Gmail.'); }
    finally { setBusy(''); }
  }
  async function inboxAction(id: string, action: 'sync' | 'disconnect') {
    setBusy(`${action}:${id}`); setActionError('');
    try {
      await api(`/inboxes/${id}${action === 'sync' ? '/sync' : ''}`, { method: action === 'sync' ? 'POST' : 'DELETE' });
      notify(action === 'sync' ? 'Inbox checked for updates.' : 'Inbox disconnected.');
      onChange(); await loadReview();
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not update inbox.'); }
    finally { setBusy(''); }
  }
  async function importEmail(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) { setImportError('Paste an email before importing.'); return; }
    setBusy('import'); setImportError('');
    try {
      const result = await api<{ queued?: boolean; message?: string }>('/email/import', { method: 'POST', body: JSON.stringify({ text, workspace, ...(applicationId ? { applicationId } : {}) }) });
      notify(result.message || (result.queued ? 'Email saved for review.' : 'Email added to the application.'));
      setImportOpen(false); setText(''); setApplicationId('');
      onChange(); await loadReview();
    } catch (error) { setImportError(error instanceof Error ? error.message : 'Could not import email.'); }
    finally { setBusy(''); }
  }
  async function resolveReview(action: 'assign' | 'dismiss') {
    if (!selected || (action === 'assign' && !selectedApplication)) return;
    setBusy(`review:${action}`); setResolveError('');
    try {
      await api(`/email/review/${selected.id}${action === 'assign' ? '/assign' : ''}`, { method: action === 'assign' ? 'POST' : 'DELETE', ...(action === 'assign' ? { body: JSON.stringify({ applicationId: selectedApplication }) } : {}) });
      setSelected(null); setSelectedApplication('');
      await loadReview(); onChange();
      notify(action === 'assign' ? 'Email assigned to application.' : 'Email dismissed.');
    } catch (error) { setResolveError(error instanceof Error ? error.message : 'Could not resolve email.'); }
    finally { setBusy(''); }
  }
  async function copyToken() {
    if (!settings?.extensionToken) return;
    try {
      await navigator.clipboard.writeText(settings.extensionToken);
      clearTimeout(copiedTimer.current); setCopied(true);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { notify('Could not copy the code. Select Show and copy it manually.', true); }
  }
  const closeImport = () => { if (busy !== 'import') setImportOpen(false); };
  const closeReview = () => { if (!busy.startsWith('review:')) setSelected(null); };

  return <div className="connection-settings">
    {account.enabled && <section className="cn-section" aria-labelledby="cloud-account-heading"><div className="cn-section-heading"><div><h2 id="cloud-account-heading">Your account</h2><p>Application records and saved documents stay with your account.</p></div><UserCircle size={23} aria-hidden="true" /></div><div className="cn-group cloud-account-row"><div><strong>{account.email || 'Signed-in account'}</strong><span>Signing out stops tracking on this device.</span></div><button className="button secondary small" onClick={() => void account.signOut?.()}><SignOut size={16} />Sign out</button></div></section>}
    <section className="cn-section" aria-labelledby="email-accounts-heading">
      <div className="cn-section-heading"><div><h2 id="email-accounts-heading">Email accounts</h2><p>Keep responses and next steps with the right application.</p></div><EnvelopeSimple size={22} aria-hidden="true" /></div>
      <div className="cn-group">
        {!settings ? <div className="cn-loading" role="status"><span className="cn-skeleton cn-skeleton-icon" /><div><span className="cn-skeleton cn-skeleton-title" /><span className="cn-skeleton cn-skeleton-text" /></div><span className="sr-only">Loading email connections</span></div> : settings.inboxes.length ? settings.inboxes.map(inbox => <div className="cn-inbox-row" key={inbox.id}>
          <span className="cn-provider" aria-hidden="true">G</span>
          <div className="cn-inbox-copy"><strong>{inbox.email}</strong><span className={inbox.status === 'error' ? 'cn-error-copy' : ''}>{inbox.status === 'error' ? inbox.error || 'Reconnect this account to check for updates.' : syncLabel(inbox.lastSyncAt)}</span></div>
          <span className={`cn-health${inbox.status === 'error' ? ' cn-health-error' : ''}`}>{inbox.status === 'error' ? <WarningCircle size={14} /> : <span className="cn-health-dot" />}{inbox.status === 'error' ? 'Needs attention' : 'Connected'}</span>
          <div className="cn-row-actions"><button className="button secondary small" onClick={() => void inboxAction(inbox.id, 'sync')} disabled={!!busy} aria-label={`Sync ${inbox.email}`}><ArrowClockwise size={15} />{busy === `sync:${inbox.id}` ? 'Checking…' : 'Sync'}</button><button className="cn-disconnect icon-button" aria-label={`Disconnect ${inbox.email}`} title="Disconnect account" onClick={() => void inboxAction(inbox.id, 'disconnect')} disabled={!!busy}><Trash size={17} /></button></div>
        </div>) : <div className="cn-inbox-row cn-empty-inbox"><span className="cn-provider" aria-hidden="true"><EnvelopeSimple size={21} /></span><div className="cn-inbox-copy"><strong>No inbox connected</strong><span>Connect Gmail or import an email to add updates.</span></div><span className="cn-health cn-health-neutral">Not connected</span></div>}
        <div className="cn-group-actions"><button className="button primary" onClick={() => void connect()} disabled={!!busy || !settings?.gmailConfigured}><Plus size={17} />{busy === 'connect' ? 'Connecting…' : 'Connect Gmail'}</button><button className="button secondary" onClick={() => { setImportError(''); setImportOpen(true); }} disabled={!!busy}><FileText size={17} />Import email</button><span className="cn-actions-note">Gmail is supported.</span></div>
        {actionError && <div className="cn-inline-error" role="alert"><WarningCircle size={17} /><p>{actionError}</p><button className="text-button" onClick={() => setActionError('')}>Dismiss</button></div>}
        {settings && !settings.gmailConfigured && <details className="cn-setup"><summary><span>Google setup required</span><CaretDown size={15} /></summary><div className="cn-setup-body"><p>Gmail connections are not configured on this server. You can import emails until setup is complete.</p></div></details>}
      </div>
      <p className="cn-section-footnote">Inboxes are checked while the app service is running. Your existing emails stay in your inbox.</p>
    </section>

    {(items.length > 0 || reviewError) && <section className="cn-section" aria-labelledby="email-review-heading">
      <div className="cn-section-heading"><div><h2 id="email-review-heading">Emails to review <span className="cn-count">{items.length}</span></h2><p>Choose an application for messages that need a match.</p></div></div>
      <div className="cn-group" aria-busy={reviewLoading}>
        {reviewError && <div className="cn-inline-error" role="alert"><WarningCircle size={18} /><p>{reviewError}</p><button className="button secondary small" onClick={() => void loadReview()} disabled={reviewLoading}>{reviewLoading ? 'Loading…' : 'Try again'}</button></div>}
        {items.map(item => <button className="cn-review-row" key={item.id} onClick={() => { setSelected(item); setSelectedApplication(''); setResolveError(''); }}><span className="cn-review-symbol"><EnvelopeSimple size={19} /></span><span className="cn-review-copy"><strong>{item.subject || 'Untitled email'}</strong><span>{item.from || 'Sender not provided'}</span></span><span className="cn-review-date">{dateLabel(item.receivedAt)}</span><CaretRight size={16} /></button>)}
      </div>
    </section>}

    <section className="cn-section" aria-labelledby="browser-extension-heading">
      <div className="cn-section-heading"><div><h2 id="browser-extension-heading">Browser extension</h2><p>Capture job details and submission confirmations as you apply.</p></div><LinkSimple size={22} aria-hidden="true" /></div>
      <ol className="cn-group cn-steps">
        <li className="cn-step"><span className="cn-step-number">1</span><div className="cn-step-copy"><strong>Install the extension</strong><p>Download and unzip. In Chrome or Edge, open Extensions, turn on Developer mode, then select Load unpacked.</p></div><a className="button secondary cn-step-action" href="/api/extension/download" download><DownloadSimple size={17} />Download extension</a></li>
        <li className="cn-step"><span className="cn-step-number">2</span><div className="cn-step-copy"><strong>Pair with this dashboard</strong><p>Paste your pairing code into the extension.</p><div className="cn-pairing"><code aria-label={showToken ? 'Pairing code' : 'Pairing code hidden'}>{showToken ? settings?.extensionToken || 'Loading…' : '•••• •••• •••• ••••'}</code><button className="text-button" onClick={() => setShowToken(value => !value)} disabled={!settings?.extensionToken} aria-expanded={showToken}>{showToken ? 'Hide' : 'Show'}</button></div></div><button className="button secondary cn-step-action" onClick={() => void copyToken()} disabled={!settings?.extensionToken} aria-label="Copy pairing code" aria-live="polite">{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied' : 'Copy code'}</button></li>
        <li className="cn-step"><span className="cn-step-number">3</span><div className="cn-step-copy"><strong>Start tracking</strong><p>Open the extension and select Start browser tracking. Allow access to the supported job sites when prompted.</p><span className="cn-supported">Greenhouse <span>·</span> Lever <span>·</span> Ashby</span></div></li>
      </ol>
      <p className="cn-section-footnote">Screen capture is separate. Enable it from Start tracking in the dashboard.</p>
    </section>

    <div className="cn-local-note"><Cloud size={19} /><p>{account.enabled ? 'Application records, document copies and confirmation snapshots are stored in your account.' : 'This test workspace stores application records on this computer.'}</p></div>

    <Modal open={importOpen} onClose={closeImport} title="Import an email" description="Paste a confirmation, assessment invitation or recruiter response." wide>
      <form onSubmit={importEmail} aria-busy={busy === 'import'} className="cn-import-form"><div className="modal-body"><label className="field"><span>Email text</span><textarea rows={9} value={text} onChange={event => setText(event.target.value)} placeholder={'From: recruiter@example.com\nSubject: Your application\n\nPaste the message here.'} required maxLength={100000} disabled={busy === 'import'} aria-invalid={!!importError} aria-describedby={importError ? 'email-import-error' : 'email-import-help'} /></label><label className="field"><span>Application</span><select value={applicationId} onChange={event => setApplicationId(event.target.value)} disabled={busy === 'import'}><option value="">Match automatically</option>{applications.map(application => <option key={application.id} value={application.id}>{application.company} · {application.role}</option>)}</select></label><p className="field-help" id="email-import-help">Unclear matches are saved for review. No email is sent.</p>{importError && <p className="form-error" id="email-import-error" role="alert">{importError}</p>}</div><div className="modal-footer"><button className="button secondary" type="button" onClick={closeImport} disabled={busy === 'import'}>Cancel</button><button className="button primary" disabled={busy === 'import'}>{busy === 'import' ? 'Importing…' : 'Import email'}</button></div></form>
    </Modal>
    <Modal open={!!selected} onClose={closeReview} title="Review email" description="Choose the application this message belongs to." wide>
      <div className="modal-body cn-review-modal"><div className="cn-email-header"><strong>{selected?.subject || 'Untitled email'}</strong><span>{selected?.from || 'Sender not provided'}</span><span>{dateLabel(selected?.receivedAt, true)}</span></div><pre className="cn-email-body">{selected?.body}</pre><label className="field"><span>Assign to application</span><select value={selectedApplication} onChange={event => setSelectedApplication(event.target.value)} disabled={busy.startsWith('review:') || !applications.length}><option value="">Choose an application</option>{applications.map(application => <option key={application.id} value={application.id}>{application.company} · {application.role}</option>)}</select></label>{!applications.length && <p className="field-help">Add an application before assigning this email.</p>}{resolveError && <p className="form-error" role="alert">{resolveError}</p>}</div><div className="modal-footer split"><button className="button quiet" onClick={() => void resolveReview('dismiss')} disabled={busy.startsWith('review:')}>{busy === 'review:dismiss' ? 'Dismissing…' : 'Dismiss email'}</button><button className="button primary" onClick={() => void resolveReview('assign')} disabled={!selectedApplication || busy.startsWith('review:')}>{busy === 'review:assign' ? 'Saving…' : 'Assign email'}</button></div>
    </Modal>
  </div>;
}
