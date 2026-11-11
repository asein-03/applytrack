import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowClockwise, CaretDown, CaretRight, Check, Cloud, Copy, DownloadSimple, EnvelopeSimple, FileText, LinkSimple, Plus, SignOut, Trash, UserCircle, WarningCircle } from '@phosphor-icons/react';
import type { Application, GmailStatus, GmailSyncResult, GmailDisconnectResult, Inbox, Settings, Workspace } from '../shared/types';
import { api } from './api';
import { safeGmailAuthorizationUrl } from '../shared/gmail';
import { useCloudAccount } from './AuthGate';
import { dateLabel, Modal } from './ui';
import './connections.css';

interface PendingGmail { startedAt: number; inboxId?: string; previous: Map<string, Inbox>; url: string; }
interface ReviewItem { id: string; subject: string; from: string; body: string; receivedAt: string; workspace: Workspace; kind: string; }

function syncLabel(value: string | null) {
  if (!value) return 'Waiting for the first inbox check';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Last check unavailable';
  return `Last checked ${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

export default function Connections({ settings, applications, workspace, onChange, notify, additionalSettings }: {
  settings: Settings | null; applications: Application[]; workspace: Workspace;
  onChange: () => void; notify: (message: string, error?: boolean) => void;
  additionalSettings?: ReactNode;
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
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [pending, setPending] = useState<PendingGmail | null>(null);
  const pendingRef = useRef<PendingGmail | null>(null);
  const syncPending = useRef<{ id: string; lastSyncAt: string | null; startedAt: number } | null>(null);
  const [syncingId, setSyncingId] = useState('');
  const lifecycle = useRef<AbortController | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const lastStatusCheck = useRef(0);
  const popup = useRef<Window | null>(null);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const connection = gmail ?? settings;
  const inboxes = connection?.inboxes ?? [];
  const hosted = connection?.gmailSyncMode === 'cloud' || settings?.cloud?.enabled;
  const rememberPending = (value: PendingGmail | null) => { pendingRef.current = value; setPending(value); };

  async function loadGmailStatus() {
    if (workspace !== 'personal' || lifecycle.current?.signal.aborted) return;
    statusRequest.current?.abort(); const controller = new AbortController(); statusRequest.current = controller;
    const signal = lifecycle.current ? AbortSignal.any([lifecycle.current.signal, controller.signal]) : controller.signal;
    lastStatusCheck.current = Date.now();
    try {
      const result = await api<GmailStatus>('/inboxes', { signal });
      if (signal.aborted) return;
      setGmail(result); setStatusError(result.gmailStatusError ?? '');
      const waiting = pendingRef.current;
      if (waiting && !result.gmailStatusError) {
        const connected = result.inboxes.find(inbox => {
          if (inbox.status !== 'connected' || (waiting.inboxId && inbox.id !== waiting.inboxId)) return false;
          const before = waiting.previous.get(inbox.id);
          return !before || before.status !== 'connected' || (!!inbox.connectedAt && inbox.connectedAt !== before.connectedAt);
        });
        if (connected) { rememberPending(null); popup.current = null; setConnectionMessage('Gmail connected. Application updates will appear here.'); onChangeRef.current(); void loadReview(signal); }
      }
      const syncing = syncPending.current;
      if (syncing) {
        const inbox = result.inboxes.find(inbox => inbox.id === syncing.id);
        if (inbox?.status === 'reconnect_required' || inbox?.status === 'error') { syncPending.current = null; setSyncingId(''); setActionError(inbox.error || 'The inbox check failed. Try again.'); }
        else if (inbox && inbox.lastSyncAt !== syncing.lastSyncAt && !inbox.syncing) { syncPending.current = null; setSyncingId(''); setConnectionMessage('Inbox check complete.'); onChangeRef.current(); void loadReview(signal); }
      }
    } catch (error) { if (!signal.aborted) setStatusError(error instanceof Error ? error.message : 'Could not check Gmail connections.'); }
  }
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    rememberPending(null); syncPending.current = null; setSyncingId(''); setGmail(null); setStatusError(''); setActionError(''); setConnectionMessage(''); setBusy('');
    void loadGmailStatus();
    const focus = () => { void loadGmailStatus(); }; window.addEventListener('focus', focus);
    const timer = setInterval(() => {
      if (pendingRef.current && Date.now() - pendingRef.current.startedAt > 600000) { rememberPending(null); setActionError('Google approval was not completed. Start Connect Gmail again when you are ready.'); }
      if (syncPending.current && Date.now() - syncPending.current.startedAt > 120000) { syncPending.current = null; setSyncingId(''); setConnectionMessage('The inbox check is continuing in the cloud. Updates will appear when it finishes.'); }
      if (pendingRef.current || syncPending.current || Date.now() - lastStatusCheck.current >= 30000) void loadGmailStatus();
    }, 3000);
    return () => { controller.abort(); statusRequest.current?.abort(); clearInterval(timer); window.removeEventListener('focus', focus); pendingRef.current = null; syncPending.current = null; if (popup.current && !popup.current.closed) popup.current.close(); popup.current = null; };
  }, [workspace, account.email]);

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

  async function connect(inboxId?: string) {
    if (workspace !== 'personal' || !connection?.gmailConfigured) return;
    setBusy('connect'); setActionError(''); setConnectionMessage('');
    const signal = lifecycle.current?.signal;
    const isHosted = hosted;
    if (isHosted && !window.applyDesktop) { popup.current = window.open('about:blank', '_blank'); if (popup.current) popup.current.opener = null; }
    const authWindow = popup.current;
    try {
      const result = await api<{ url: string }>('/inboxes/google/connect', { method: 'POST', body: JSON.stringify(inboxId ? { inboxId } : {}), signal });
      if (signal?.aborted) return;
      if (!isHosted) {
        const url = new URL(result.url);
        if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.username || url.password || url.port || !['/o/oauth2/v2/auth', '/o/oauth2/auth'].includes(url.pathname)) throw new Error('Gmail returned an invalid connection link. Try again.');
        window.location.assign(url.href); return;
      }
      const destination = safeGmailAuthorizationUrl(result.url);
      if (!destination) throw new Error('Gmail returned an invalid connection link. Try again.');
      rememberPending({ startedAt: Date.now(), inboxId, previous: new Map(inboxes.map(inbox => [inbox.id, inbox])), url: destination });
      if (window.applyDesktop) window.open(destination, '_blank', 'noopener,noreferrer');
      else if (authWindow && !authWindow.closed) authWindow.location.href = destination;
    } catch (error) { if (!signal?.aborted) setActionError(error instanceof Error ? error.message : 'Could not connect Gmail.'); if (authWindow && !authWindow.closed) authWindow.close(); if (popup.current === authWindow) popup.current = null; }
    finally { if (!signal?.aborted) setBusy(''); }
  }
  function cancelConnection() { rememberPending(null); if (popup.current && !popup.current.closed) popup.current.close(); popup.current = null; setConnectionMessage('Connection check stopped. You can connect Gmail again at any time.'); }
  async function inboxAction(id: string, action: 'sync' | 'disconnect') {
    if (workspace !== 'personal') return;
    setBusy(`${action}:${id}`); setActionError(''); setConnectionMessage('');
    const signal = lifecycle.current?.signal;
    try {
      const result = await api<(GmailSyncResult & Partial<GmailDisconnectResult>) | undefined>(`/inboxes/${id}${action === 'sync' ? '/sync' : ''}`, { method: action === 'sync' ? 'POST' : 'DELETE', signal });
      if (signal?.aborted) return;
      if (action === 'sync' && result?.syncing) {
        syncPending.current = { id, lastSyncAt: inboxes.find(inbox => inbox.id === id)?.lastSyncAt ?? null, startedAt: Date.now() }; setSyncingId(id); setConnectionMessage('Inbox check started. You can keep using ApplyTrack.');
      } else {
        if (syncPending.current?.id === id) { syncPending.current = null; setSyncingId(''); }
        setConnectionMessage(action === 'disconnect' ? result?.revocationPending ? 'Gmail disconnected. Google access removal is still being retried.' : 'Gmail disconnected.' : 'Inbox checked for updates.');
        onChangeRef.current(); await loadReview(signal);
      }
      await loadGmailStatus();
    } catch (error) { if (!signal?.aborted) { setActionError(error instanceof Error ? error.message : 'Could not update inbox.'); void loadGmailStatus(); } }
    finally { if (!signal?.aborted) setBusy(''); }
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
        {!connection ? <div className="cn-loading" role="status"><span className="cn-skeleton cn-skeleton-icon" /><div><span className="cn-skeleton cn-skeleton-title" /><span className="cn-skeleton cn-skeleton-text" /></div><span className="sr-only">Loading email connections</span></div> : inboxes.length ? inboxes.map(inbox => <div className="cn-inbox-row" key={inbox.id}>
          <span className="cn-provider" aria-hidden="true">G</span>
          <div className="cn-inbox-copy"><strong>{inbox.email}</strong><span className={inbox.status !== 'connected' ? 'cn-error-copy' : ''}>{inbox.status !== 'connected' ? inbox.error || 'Reconnect this account to check for updates.' : inbox.syncing || syncingId === inbox.id ? 'Checking Gmail for application updates…' : syncLabel(inbox.lastSyncAt)}</span></div>
          <span className={`cn-health${inbox.status !== 'connected' ? ' cn-health-error' : ''}`}>{inbox.status !== 'connected' ? <WarningCircle size={14} /> : <span className="cn-health-dot" />}{inbox.status !== 'connected' ? 'Needs attention' : 'Connected'}</span>
          <div className="cn-row-actions">{inbox.status === 'reconnect_required' ? <button className="button secondary small" onClick={() => void connect(inbox.id)} disabled={!!busy || !!pending || workspace !== 'personal'} aria-label={`Reconnect ${inbox.email}`}>Reconnect</button> : <button className="button secondary small" onClick={() => void inboxAction(inbox.id, 'sync')} disabled={!!busy || !!inbox.syncing || syncingId === inbox.id || workspace !== 'personal'} aria-label={`Sync ${inbox.email}`}><ArrowClockwise size={15} />{busy === `sync:${inbox.id}` || inbox.syncing || syncingId === inbox.id ? 'Checking…' : 'Sync'}</button>}<button className="cn-disconnect icon-button" aria-label={`Disconnect ${inbox.email}`} title="Disconnect account" onClick={() => void inboxAction(inbox.id, 'disconnect')} disabled={!!busy || workspace !== 'personal'}><Trash size={17} /></button></div>
        </div>) : <div className="cn-inbox-row cn-empty-inbox"><span className="cn-provider" aria-hidden="true"><EnvelopeSimple size={21} /></span><div className="cn-inbox-copy"><strong>No inbox connected</strong><span>Connect Gmail or import an email to add updates.</span></div><span className="cn-health cn-health-neutral">Not connected</span></div>}
        <div className="cn-group-actions"><button className="button primary" onClick={() => void connect()} disabled={!!busy || !!pending || !connection?.gmailConfigured || workspace !== 'personal'}><Plus size={17} />{busy === 'connect' ? 'Connecting…' : 'Connect Gmail'}</button><button className="button secondary" onClick={() => { setImportError(''); setImportOpen(true); }} disabled={!!busy}><FileText size={17} />Import email</button><span className="cn-actions-note">Read-only Gmail access</span></div>
        {pending && <div className="cn-pending" role="status"><div><strong>Finish connecting in your browser</strong><p>Sign in to ApplyTrack in your browser, then choose your Gmail account. This page will update automatically.</p></div><div className="cn-pending-actions"><a className="button secondary small" href={pending.url} target="_blank" rel="noopener noreferrer">Continue in browser</a><button className="text-button" onClick={cancelConnection}>Cancel</button></div></div>}
        {connectionMessage && <div className="cn-connection-message" role="status"><Check size={17} /><p>{connectionMessage}</p></div>}
        {statusError && <div className="cn-inline-error" role="alert"><WarningCircle size={17} /><p>{statusError}</p><button className="text-button" onClick={() => void loadGmailStatus()}>Check again</button></div>}
        {workspace === 'demo' && <p className="cn-personal-note">Switch to your personal workspace to connect or manage Gmail.</p>}
        {actionError && <div className="cn-inline-error" role="alert"><WarningCircle size={17} /><p>{actionError}</p><button className="text-button" onClick={() => setActionError('')}>Dismiss</button></div>}
        {connection && !connection.gmailConfigured && !statusError && <details className="cn-setup"><summary><span>Google setup required</span><CaretDown size={15} /></summary><div className="cn-setup-body"><p>Gmail connections are not available yet. You can import emails until setup is complete.</p></div></details>}
      </div>
      <p className="cn-section-footnote">ApplyTrack uses read-only access to find application updates. It cannot send, edit or delete your Gmail messages. {hosted ? 'Inbox checks continue in the cloud when this app is closed.' : 'Inboxes are checked while the app service is running.'}</p><p className="cn-section-footnote">Clear matches update your applications. Messages that need a match or confirmation go to review.</p>
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

    {additionalSettings}
    <div className="cn-local-note"><Cloud size={19} /><p>{account.enabled ? 'Application records, document copies and confirmation snapshots are stored in your account.' : 'This test workspace stores application records on this computer.'}</p></div>

    <Modal open={importOpen} onClose={closeImport} title="Import an email" description="Paste a confirmation, assessment invitation or recruiter response." wide>
      <form onSubmit={importEmail} aria-busy={busy === 'import'} className="cn-import-form"><div className="modal-body"><label className="field"><span>Email text</span><textarea rows={9} value={text} onChange={event => setText(event.target.value)} placeholder={'From: recruiter@example.com\nSubject: Your application\n\nPaste the message here.'} required maxLength={100000} disabled={busy === 'import'} aria-invalid={!!importError} aria-describedby={importError ? 'email-import-error' : 'email-import-help'} /></label><label className="field"><span>Application</span><select value={applicationId} onChange={event => setApplicationId(event.target.value)} disabled={busy === 'import'}><option value="">Match automatically</option>{applications.map(application => <option key={application.id} value={application.id}>{application.company} · {application.role}</option>)}</select></label><p className="field-help" id="email-import-help">Unclear matches are saved for review. No email is sent.</p>{importError && <p className="form-error" id="email-import-error" role="alert">{importError}</p>}</div><div className="modal-footer"><button className="button secondary" type="button" onClick={closeImport} disabled={busy === 'import'}>Cancel</button><button className="button primary" disabled={busy === 'import'}>{busy === 'import' ? 'Importing…' : 'Import email'}</button></div></form>
    </Modal>
    <Modal open={!!selected} onClose={closeReview} title="Review email" description="Choose the application this message belongs to." wide>
      <div className="modal-body cn-review-modal"><div className="cn-email-header"><strong>{selected?.subject || 'Untitled email'}</strong><span>{selected?.from || 'Sender not provided'}</span><span>{dateLabel(selected?.receivedAt, true)}</span></div><pre className="cn-email-body">{selected?.body}</pre><label className="field"><span>Assign to application</span><select value={selectedApplication} onChange={event => setSelectedApplication(event.target.value)} disabled={busy.startsWith('review:') || !applications.length}><option value="">Choose an application</option>{applications.map(application => <option key={application.id} value={application.id}>{application.company} · {application.role}</option>)}</select></label>{!applications.length && <p className="field-help">Add an application before assigning this email.</p>}{resolveError && <p className="form-error" role="alert">{resolveError}</p>}</div><div className="modal-footer split"><button className="button quiet" onClick={() => void resolveReview('dismiss')} disabled={busy.startsWith('review:')}>{busy === 'review:dismiss' ? 'Dismissing…' : 'Dismiss email'}</button><button className="button primary" onClick={() => void resolveReview('assign')} disabled={!selectedApplication || busy.startsWith('review:')}>{busy === 'review:assign' ? 'Saving…' : 'Assign email'}</button></div>
    </Modal>
  </div>;
}
