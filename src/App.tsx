import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Briefcase, CalendarBlank, CaretRight, Check, CheckCircle, DownloadSimple, EnvelopeSimple, Flag, LinkSimple, MagnifyingGlass, Monitor, Plus, Record, ShieldCheck, SquaresFour, Stop, WarningCircle, X } from '@phosphor-icons/react';
import type { Application, Settings, Task, TrackingSession, Workspace } from '../shared/types';
import { STAGES, STAGE_LABELS } from '../shared/types';
import { api } from './api';
import { startCapture, type CaptureController, type CaptureStatus } from './capture';
import { CompanyMark, dateLabel, EmptyState, isOverdue, Modal, relativeDate, StageBadge, TaskRow } from './ui';
import ApplicationEditor from './ApplicationEditor';
import ApplicationDetail from './ApplicationDetail';
import Connections from './Connections';

type Page = 'overview' | 'applications' | 'tasks' | 'connections';
const pages: { id: Page; label: string; icon: typeof SquaresFour }[] = [
  { id: 'overview', label: 'Overview', icon: SquaresFour },
  { id: 'applications', label: 'Applications', icon: Briefcase },
  { id: 'tasks', label: 'Tasks', icon: CheckCircle },
  { id: 'connections', label: 'Connections', icon: LinkSimple },
];

function nextTask(application: Application) {
  return [...application.tasks].filter(task => !task.completedAt).sort((a, b) => (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity))[0];
}

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [workspace, setWorkspace] = useState<Workspace>(() => localStorage.getItem('apply.workspace') === 'demo' ? 'demo' : 'personal');
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [applications, setApplications] = useState<Application[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [applicationsUnavailable, setApplicationsUnavailable] = useState(false);
  const [unmatchedEmailCount, setUnmatchedEmailCount] = useState(0);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [highOnly, setHighOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const applicationOpener = useRef<HTMLElement | null>(null);
  const [editor, setEditor] = useState<Application | 'new' | null>(null);
  const [taskView, setTaskView] = useState<'upcoming' | 'completed'>('upcoming');
  const [taskBusy, setTaskBusy] = useState('');
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trackingOpen, setTrackingOpen] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(true);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [trackingError, setTrackingError] = useState('');
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const capture = useRef<CaptureController | null>(null);
  const applicationsRef = useRef<Application[]>([]);
  const stopping = useRef(false);
  const sessionActive = !!settings?.session && !settings.session.stoppedAt;
  const screenActive = captureStatus?.state === 'capturing';

  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 7000 : 4000);
  }, []);

  const refresh = useCallback(async () => {
    const [data, config, review] = await Promise.allSettled([api<{ applications: Application[] }>(`/applications?workspace=${workspace}`), api<Settings>('/settings'), api<{ items: unknown[] }>(`/email/review?workspace=${workspace}`)]);
    if (workspaceRef.current !== workspace) return;
    if (data.status === 'fulfilled') { setApplications(data.value.applications); applicationsRef.current = data.value.applications; }
    setApplicationsUnavailable(data.status === 'rejected');
    if (config.status === 'fulfilled') setSettings(config.value);
    if (review.status === 'fulfilled') setUnmatchedEmailCount(review.value.items.length);
    const failure = [data, config, review].find(result => result.status === 'rejected');
    setLoadError(failure?.status === 'rejected' ? failure.reason instanceof Error ? failure.reason.message : 'Could not load your workspace.' : '');
    setLoading(false);
  }, [workspace]);

  useEffect(() => {
    setLoading(true); setApplications([]); applicationsRef.current = []; setUnmatchedEmailCount(0); setLoadError(''); setApplicationsUnavailable(false);
    setSelectedId(null); setSearch(''); setStageFilter('all'); setHighOnly(false);
    void refresh(); const interval = setInterval(() => void refresh(), 5000);
    localStorage.setItem('apply.workspace', workspace);
    return () => clearInterval(interval);
  }, [workspace, refresh]);
  useEffect(() => () => { void capture.current?.stop(); if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  useEffect(() => {
    if (!loading && !trackingBusy && !sessionActive && capture.current) {
      const controller = capture.current;
      capture.current = null;
      setCaptureStatus(null);
      void controller.stop();
    }
  }, [loading, trackingBusy, sessionActive]);
  useEffect(() => {
    const stopOnLeave = () => {
      if (sessionActive) void fetch('/api/sessions/current', { method: 'DELETE', keepalive: true });
    };
    window.addEventListener('pagehide', stopOnLeave);
    return () => window.removeEventListener('pagehide', stopOnLeave);
  }, [sessionActive]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('connected') || params.has('connection')) { setPage('connections'); const connected = params.get('connected') === 'gmail'; notify(connected ? 'Gmail connected.' : params.get('connection') === 'cancelled' ? 'Gmail connection cancelled.' : 'Gmail connection needs attention.', !connected); window.history.replaceState({}, '', window.location.pathname); }
  }, [notify]);

  const allTasks = useMemo(() => applications.flatMap(application => application.tasks.map(task => ({ task, application }))).sort((a, b) => (a.task.dueAt ? new Date(a.task.dueAt).getTime() : Infinity) - (b.task.dueAt ? new Date(b.task.dueAt).getTime() : Infinity)), [applications]);
  const pendingTasks = allTasks.filter(({ task }) => !task.completedAt);
  const reviewApplications = applications.filter(application => application.evidence.some(evidence => evidence.review === 'pending'));
  const activeApplications = applications.filter(application => !['saved', 'rejected', 'withdrawn'].includes(application.stage));
  const selected = applications.find(application => application.id === selectedId);
  const filteredApplications = useMemo(() => applications.filter(application => {
    const matchesSearch = `${application.company} ${application.role} ${application.location}`.toLowerCase().includes(search.toLowerCase());
    const matchesStage = stageFilter === 'all' || application.stage === stageFilter || (stageFilter === 'active' && !['saved', 'rejected', 'withdrawn'].includes(application.stage));
    return matchesSearch && matchesStage && (!highOnly || application.priority === 'high');
  }), [applications, search, stageFilter, highOnly]);

  function openApplication(id: string, opener?: HTMLElement | null) {
    applicationOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSelectedId(id);
  }
  function switchWorkspace(value: Workspace) {
    if (sessionActive || trackingBusy) { notify('Stop tracking before switching workspaces.', true); return; }
    setWorkspace(value);
  }
  function navigate(value: Page) { setPage(value); setSearch(''); setStageFilter('all'); setHighOnly(false); setSelectedId(null); }
  function showApplications(stage: string) { navigate('applications'); setStageFilter(stage); setHighOnly(false); }

  async function toggleTask(task: Task) {
    setTaskBusy(task.id);
    try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ completedAt: task.completedAt ? null : new Date().toISOString() }) }); await refresh(); notify(task.completedAt ? 'Task reopened.' : 'Task completed.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not update task.', true); }
    finally { setTaskBusy(''); }
  }
  async function deleteApplication() {
    if (!selected) return;
    try { await api(`/applications/${selected.id}`, { method: 'DELETE' }); setSelectedId(null); await refresh(); notify('Application deleted.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not delete application.', true); }
  }
  async function stopTracking() {
    if (stopping.current) return;
    stopping.current = true; setTrackingBusy(true);
    try {
      const currentCapture = capture.current; capture.current = null; await currentCapture?.stop();
      await api('/sessions/current', { method: 'DELETE' }); setCaptureStatus(null); await refresh(); notify('Tracking stopped.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not stop tracking.', true); }
    finally { setTrackingBusy(false); stopping.current = false; }
  }
  async function beginTracking() {
    if (workspace === 'demo') return;
    setTrackingBusy(true); setTrackingError('');
    try {
      if (screenEnabled) {
        capture.current = await startCapture({
          workspace,
          getApplications: () => applicationsRef.current,
          onStatus: status => {
            setCaptureStatus(status);
            if (status.state === 'stopped' && capture.current && !stopping.current) void stopTracking();
          },
          onEvent: () => { void refresh(); },
          onError: message => notify(message, true),
        });
      }
      const session = await api<TrackingSession>('/sessions', { method: 'POST', body: JSON.stringify({ browserEnabled: true, screenEnabled }) });
      capture.current?.activate(); setSettings(previous => previous ? { ...previous, session } : previous); await refresh(); setTrackingOpen(false);
      notify(screenEnabled ? 'Tracking session started with screen capture.' : 'Browser tracking session started.');
    } catch (error) {
      stopping.current = true; await capture.current?.stop(); capture.current = null; stopping.current = false;
      setCaptureStatus(null); setTrackingError(error instanceof Error ? error.message : 'Could not start tracking.');
    } finally { setTrackingBusy(false); }
  }

  function renderApplicationTable() {
    const visible = page === 'overview' ? filteredApplications.slice(0, 8) : filteredApplications;
    return <section className="applications-section" aria-label="Application list">
      <div className="section-heading table-section-heading">
        <div className="heading-with-count"><h2>{page === 'overview' ? 'Recent applications' : 'All applications'}</h2><span className="count-pill">{applications.length}</span></div>
        <a className="button quiet small" href={`/api/export?workspace=${workspace}`} download><DownloadSimple size={16} />Export</a>
      </div>
      <div className="table-toolbar">
        <div className="search-field"><MagnifyingGlass size={18} /><input aria-label="Search applications" placeholder="Search company or role" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><X size={15} /></button>}</div>
        <div className="filter-controls"><label className="sr-only" htmlFor="stage-filter">Filter by stage</label><select id="stage-filter" value={stageFilter} onChange={event => setStageFilter(event.target.value)}><option value="all">All stages</option><option value="active">Active applications</option>{STAGES.map(stage => <option value={stage} key={stage}>{STAGE_LABELS[stage]}</option>)}</select><button className={`button secondary small filter-priority${highOnly ? ' active' : ''}`} aria-label="High priority only" aria-pressed={highOnly} title="High priority only" onClick={() => setHighOnly(value => !value)}><Flag size={17} weight={highOnly ? 'fill' : 'regular'} /><span>Priority</span></button></div>
      </div>
      <div className="table-container"><table className="applications-table"><thead><tr><th scope="col">Company / role</th><th scope="col">Stage</th><th scope="col" className="action-column">Next action</th><th scope="col">Deadline</th><th scope="col" className="applied-column">Applied</th><th scope="col"><span className="sr-only">Open application</span></th></tr></thead><tbody>
        {visible.map(application => {
          const task = nextTask(application);
          const emailConfirmed = application.evidence.some(evidence => evidence.source === 'email' && evidence.kind === 'submission_confirmed' && evidence.review === 'accepted');
          const action = task?.title || (application.stage === 'saved' ? 'Ready to apply' : application.stage === 'in_progress' ? 'Confirm submission' : ['rejected', 'withdrawn'].includes(application.stage) ? 'No action needed' : application.stage === 'offer' ? 'Review offer' : 'Awaiting response');
          return <tr key={application.id} onClick={event => openApplication(application.id, event.currentTarget.querySelector('button'))}>
            <td><div className="company-cell"><CompanyMark company={application.company} small /><div><button className="application-title" aria-label={application.company} aria-description={application.priority === 'high' ? 'High priority' : undefined} onClick={event => { event.stopPropagation(); openApplication(application.id, event.currentTarget); }}>{application.company}{application.priority === 'high' && <Flag size={12} weight="fill" aria-hidden="true" />}</button><span className="role-name" title={application.role}>{application.role}</span></div></div></td>
            <td><StageBadge stage={application.stage} /></td>
            <td className="action-column"><span className="next-action" title={action}>{action}</span>{application.evidence.some(evidence => evidence.review === 'pending') && <span className="review-hint">Update needs review</span>}</td>
            <td><span className={task && isOverdue(task) ? 'overdue' : 'muted'}>{task?.dueAt ? relativeDate(task.dueAt) : <span aria-label="No deadline">Not set</span>}</span></td>
            <td className="applied-column"><span className="applied-date">{application.appliedAt ? dateLabel(application.appliedAt) : 'Not applied'}{emailConfirmed && <span title="Confirmed by email"><ShieldCheck size={14} aria-label="Confirmed by email" /></span>}</span></td>
            <td><CaretRight size={15} className="row-arrow" aria-hidden="true" /></td>
          </tr>;
        })}
      </tbody></table>{visible.length === 0 && <div className="filtered-empty"><MagnifyingGlass size={26} /><h3>No matching applications</h3><p>Try another company, role or stage.</p><button className="button secondary small" onClick={() => { setSearch(''); setStageFilter('all'); setHighOnly(false); }}>Clear filters</button></div>}</div>
      <div className="table-footer"><span>{visible.length} of {applications.length} applications</span>{page === 'overview' && applications.length > 8 ? <button className="text-button" onClick={() => navigate('applications')}>View all applications<ArrowRight size={15} /></button> : <span><Check size={13} />Saved locally</span>}</div>
    </section>;
  }

  function renderAttention() {
    const count = pendingTasks.length + reviewApplications.length + unmatchedEmailCount;
    return <aside className="overview-rail" aria-label="Next steps">
      <section className="attention-section">
        <div className="section-heading"><div className="heading-with-count"><h2>Needs attention</h2><span className="count-pill">{count}</span></div></div>
        {count ? <div className="attention-list">
          {pendingTasks.slice(0, 4).map(({ task, application }) => <TaskRow key={task.id} task={task} application={application} onToggle={toggleTask} onOpen={() => openApplication(application.id)} busy={taskBusy === task.id} />)}
          {unmatchedEmailCount > 0 && <button className="review-row" onClick={() => navigate('connections')}><EnvelopeSimple size={20} /><span><strong>{unmatchedEmailCount} {unmatchedEmailCount === 1 ? 'email to match' : 'emails to match'}</strong><span>Choose the correct application.</span></span><CaretRight size={16} /></button>}
          {reviewApplications.slice(0, 2).map(application => <button className="review-row" key={application.id} onClick={() => openApplication(application.id)}><WarningCircle size={20} /><span><strong>Review an update</strong><span>{application.company} · {application.role}</span></span><CaretRight size={16} /></button>)}
        </div> : <div className="attention-clear"><CheckCircle size={26} weight="light" /><strong>You're up to date</strong><span>New tasks and updates will appear here.</span></div>}
        {pendingTasks.length > 0 && <button className="rail-footer text-button" onClick={() => navigate('tasks')}>View tasks<ArrowRight size={15} /></button>}
      </section>
      <button className="connection-summary" onClick={() => navigate('connections')}><span className="connection-summary-icon"><EnvelopeSimple size={21} /></span><span><strong>{settings?.inboxes.length ? `${settings.inboxes.length} ${settings.inboxes.length === 1 ? 'inbox connected' : 'inboxes connected'}` : 'Connect your inbox'}</strong><span>{settings?.inboxes.some(inbox => inbox.status === 'error') ? 'A connection needs attention' : settings?.inboxes.length ? 'Manage email updates' : 'Bring responses into your tracker'}</span></span><ArrowUpRight size={17} /></button>
    </aside>;
  }

  function renderTasks() {
    const visible = allTasks.filter(({ task }) => taskView === 'completed' ? !!task.completedAt : !task.completedAt);
    const groups = taskView === 'completed' ? [{ label: 'Completed', entries: visible }] : [
      { label: 'Overdue', entries: visible.filter(({ task }) => isOverdue(task)) },
      { label: 'Upcoming', entries: visible.filter(({ task }) => !!task.dueAt && !isOverdue(task)) },
      { label: 'No deadline', entries: visible.filter(({ task }) => !task.dueAt) },
    ];
    return <section className="tasks-section">
      <div className="tasks-toolbar"><div className="segmented-control" aria-label="Task view"><button className={taskView === 'upcoming' ? 'active' : ''} aria-pressed={taskView === 'upcoming'} onClick={() => setTaskView('upcoming')}>Upcoming<span>{pendingTasks.length}</span></button><button className={taskView === 'completed' ? 'active' : ''} aria-pressed={taskView === 'completed'} onClick={() => setTaskView('completed')}>Completed<span>{allTasks.length - pendingTasks.length}</span></button></div><span className="muted">Sorted by deadline</span></div>
      {visible.length ? groups.filter(group => group.entries.length).map(group => <section className="task-group" key={group.label}><div className="task-group-heading"><h2>{group.label}</h2><span>{group.entries.length}</span></div><div className="task-list">{group.entries.map(({ task, application }) => <TaskRow key={task.id} task={task} application={application} onToggle={toggleTask} onOpen={() => openApplication(application.id)} busy={taskBusy === task.id} />)}</div></section>) : <EmptyState icon={<CheckCircle size={32} weight="light" />} title={taskView === 'completed' ? 'No completed tasks yet' : 'No upcoming tasks'} description={taskView === 'completed' ? 'Your completed assessments and follow-ups will appear here.' : 'Add a task from an application, or connect an inbox to find next steps.'}><button className="button secondary" onClick={() => navigate('applications')}>View applications</button></EmptyState>}
    </section>;
  }

  const attentionCount = pendingTasks.length + reviewApplications.length + unmatchedEmailCount;
  const nextStep = pendingTasks[0];
  const pageDescription = page === 'overview'
    ? `${activeApplications.length} active ${activeApplications.length === 1 ? 'application' : 'applications'}. ${attentionCount} ${attentionCount === 1 ? 'item needs' : 'items need'} your attention.`
    : page === 'applications' ? 'Every role and its next step.' : page === 'tasks' ? 'Your assessments, interviews and follow-ups.' : 'Browser tracking and email accounts.';

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('overview'); }} aria-label="Apply overview"><span className="brand-mark"><Check size={24} weight="bold" /></span><span>Apply</span></a>
      <div className="workspace-label">Workspace</div>
      <nav aria-label="Main navigation">{pages.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item${page === id ? ' active' : ''}`} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}><Icon size={21} weight={page === id ? 'fill' : 'regular'} /><span>{label}</span>{id === 'tasks' && pendingTasks.length > 0 && <span className="nav-count">{pendingTasks.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom">
        <button className="sidebar-connection" onClick={() => navigate('connections')}><EnvelopeSimple size={19} /><span>{settings?.inboxes.length ? `${settings.inboxes.length} ${settings.inboxes.length === 1 ? 'inbox connected' : 'inboxes connected'}` : 'Connect an inbox'}</span><Plus size={15} /></button>
        <div className="local-status"><ShieldCheck size={17} /><span>Saved on this computer</span></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar">
        <div className="workspace-control"><span className="workspace-avatar" aria-hidden="true">{workspace === 'demo' ? 'D' : 'M'}</span><label className="sr-only" htmlFor="workspace-select">Workspace</label><select id="workspace-select" value={workspace} onChange={event => switchWorkspace(event.target.value as Workspace)}><option value="personal">My workspace</option><option value="demo">Demo workspace</option></select></div>
        <div className="topbar-actions"><span className="topbar-date"><CalendarBlank size={16} />{new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span className={`tracking-status${sessionActive ? ' running' : ''}`} role="status"><span className="status-dot" />{sessionActive ? screenActive ? 'Screen capture on' : 'Session active' : 'Tracking off'}</span><button className={`button ${sessionActive ? 'secondary' : 'primary'} tracking-button`} disabled={trackingBusy} onClick={() => { if (sessionActive) void stopTracking(); else if (workspace === 'demo') notify('Switch to your workspace to start tracking.', true); else { setTrackingError(''); setTrackingOpen(true); } }}>{sessionActive ? <Stop size={16} weight="fill" /> : <Record size={18} />}{trackingBusy ? 'Working…' : sessionActive ? 'Stop tracking' : 'Start tracking'}</button></div>
      </header>
      <main className={`main-content page-${page}`} id="main-content" tabIndex={-1}>
        {workspace === 'demo' && <div className="demo-banner"><span><strong>Demo workspace</strong><span>These are sample applications.</span></span><button onClick={() => switchWorkspace('personal')}>Go to my workspace<ArrowRight size={14} /></button></div>}
        <div className="page-heading"><div><h1>{pages.find(item => item.id === page)?.label}</h1><p className="page-description">{applications.length || page === 'connections' || page === 'tasks' ? pageDescription : 'Your job search starts here.'}</p></div>{page !== 'connections' && <button className="button secondary add-application" onClick={event => { applicationOpener.current = event.currentTarget; setEditor('new'); }}><Plus size={18} />Add application</button>}</div>
        {loadError && <div className="error-banner" role="alert"><WarningCircle size={21} /><div><strong>Could not load your workspace</strong><p>{loadError}</p></div><button className="button secondary small" onClick={() => void refresh()}>Try again</button></div>}
        {loading ? <div className="loading-layout" aria-label="Loading applications" aria-busy="true"><div className="skeleton skeleton-stats" /><div className="skeleton skeleton-heading" />{Array.from({ length: 5 }, (_, index) => <div className="skeleton skeleton-row" key={index} />)}</div> : page === 'connections' ? <Connections settings={settings} applications={applications} workspace={workspace} onChange={() => void refresh()} notify={notify} /> : applicationsUnavailable && !applications.length ? <div className="unavailable-state"><Briefcase size={36} weight="light" /><p>Your applications are unavailable. Try again shortly.</p></div> : <>
          {unmatchedEmailCount > 0 && !applications.length && <div className="unmatched-note"><EnvelopeSimple size={20} /><span>{unmatchedEmailCount} {unmatchedEmailCount === 1 ? 'email needs' : 'emails need'} an application.</span><button className="text-button" onClick={() => navigate('connections')}>Review emails<ArrowRight size={14} /></button></div>}
          {page === 'tasks' ? renderTasks() : !applications.length ? <section className="first-run">
            <EmptyState icon={<Briefcase size={36} weight="light" />} title="Track your first application" description="Add an application, or turn on tracking before you apply."><button className="button primary" onClick={event => { applicationOpener.current = event.currentTarget; setEditor('new'); }}><Plus size={18} />Add application</button><button className="button secondary" onClick={() => switchWorkspace('demo')}>Explore demo</button></EmptyState>
            <div className="first-run-steps"><button onClick={() => navigate('connections')}><span className="setup-icon"><LinkSimple size={24} /></span><span><strong>Set up browser tracking</strong><span>Capture job details and confirmations.</span></span><ArrowUpRight size={18} /></button><button onClick={() => navigate('connections')}><span className="setup-icon"><EnvelopeSimple size={24} /></span><span><strong>Connect your inbox</strong><span>Keep responses and next steps together.</span></span><ArrowUpRight size={18} /></button></div>
          </section> : <>
            {page === 'overview' && <div className="summary-strip" aria-label="Application summary">
              <button onClick={() => showApplications('all')}><span>Applications</span><strong>{applications.length}</strong><ArrowUpRight size={18} /></button>
              <button onClick={() => showApplications('active')}><span>Active</span><strong>{activeApplications.length}</strong><ArrowUpRight size={18} /></button>
              <button onClick={() => showApplications('interviewing')}><span>Interviewing</span><strong>{applications.filter(application => application.stage === 'interviewing').length}</strong><ArrowUpRight size={18} /></button>
              <button onClick={() => showApplications('offer')}><span>Offers</span><strong>{applications.filter(application => application.stage === 'offer').length}</strong><ArrowUpRight size={18} /></button>
            </div>}
            {page === 'overview' && attentionCount > 0 && <button className="compact-attention" onClick={() => { if (nextStep) openApplication(nextStep.application.id); else if (reviewApplications[0]) openApplication(reviewApplications[0].id); else navigate('connections'); }}><WarningCircle size={21} /><span><strong>{nextStep?.task.title || (reviewApplications.length ? 'Review an application update' : 'Match an email to an application')}</strong><span>{nextStep ? `${nextStep.application.company} · ` : ''}{attentionCount} {attentionCount === 1 ? 'item needs' : 'items need'} attention</span></span>{nextStep?.task.dueAt && <span className={`compact-deadline${isOverdue(nextStep.task) ? ' overdue' : ''}`}>{relativeDate(nextStep.task.dueAt)}</span>}<ArrowUpRight size={17} /></button>}
            {page === 'overview' ? <div className="overview-grid">{renderApplicationTable()}{renderAttention()}</div> : renderApplicationTable()}
          </>}
        </>}
      </main>
    </div>
    {selected && <ApplicationDetail key={selected.id} application={selected} onClose={() => setSelectedId(null)} onRestoreFocus={() => (applicationOpener.current?.isConnected ? applicationOpener.current : document.getElementById('main-content'))?.focus()} onChange={() => void refresh()} onEdit={() => setEditor(selected)} onDelete={() => void deleteApplication()} onTaskToggle={toggleTask} onError={message => notify(message, true)} />}
    {editor && <ApplicationEditor application={editor === 'new' ? undefined : editor} workspace={workspace} onClose={() => setEditor(null)} onSaved={application => { setEditor(null); setSelectedId(application.id); void refresh(); notify(editor === 'new' ? 'Application added.' : 'Application updated.'); }} />}
    <Modal open={trackingOpen} onClose={() => { if (!trackingBusy) setTrackingOpen(false); }} title="Start tracking" description="Keep this dashboard open while you apply.">
      <div className="modal-body tracking-body"><div className="tracking-option"><span className="setup-icon"><LinkSimple size={23} /></span><div><strong>Browser tracking</strong><p>Capture job details and submission confirmations with the paired extension.</p></div><Check size={19} /></div><label className="tracking-option screen-option"><span className="setup-icon"><Monitor size={23} /></span><span><strong>Screen confirmation</strong><span className="option-description">Check the browser window or tab you choose for a second confirmation.</span></span><input type="checkbox" role="switch" checked={screenEnabled} onChange={event => setScreenEnabled(event.target.checked)} /></label><div className="capture-note"><ShieldCheck size={18} /><p>Screen analysis runs on this computer. Only confirmation snapshots are saved.</p></div>{captureStatus?.state === 'starting' && <p className="capture-progress" role="status">{captureStatus.message}</p>}{trackingError && <p className="form-error" role="alert">{trackingError}</p>}</div>
      <div className="modal-footer"><button className="button secondary" onClick={() => setTrackingOpen(false)} disabled={trackingBusy}>Cancel</button><button className="button primary" onClick={() => void beginTracking()} disabled={trackingBusy}><Record size={17} />{trackingBusy ? 'Starting…' : screenEnabled ? 'Choose screen and start' : 'Start session'}</button></div>
    </Modal>
    {toast && <div className={`toast${toast.error ? ' error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <WarningCircle size={19} /> : <CheckCircle size={19} />}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}
