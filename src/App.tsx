import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Briefcase, CalendarBlank, CaretRight, Check, CheckCircle, Clock, DownloadSimple, EnvelopeSimple, Flag, LinkSimple, MagnifyingGlass, Monitor, Plus, Record, ShieldCheck, SquaresFour, Stop, WarningCircle, X } from '@phosphor-icons/react';
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
  const [unmatchedEmailCount, setUnmatchedEmailCount] = useState(0);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [highOnly, setHighOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    try {
      const [data, config, review] = await Promise.all([api<{ applications: Application[] }>(`/applications?workspace=${workspace}`), api<Settings>('/settings'), api<{ items: unknown[] }>(`/email/review?workspace=${workspace}`)]);
      if (workspaceRef.current !== workspace) return;
      setApplications(data.applications); applicationsRef.current = data.applications; setSettings(config); setUnmatchedEmailCount(review.items.length); setLoadError('');
    } catch (error) { if (workspaceRef.current === workspace) setLoadError(error instanceof Error ? error.message : 'Could not load applications.'); }
    finally { if (workspaceRef.current === workspace) setLoading(false); }
  }, [workspace]);

  useEffect(() => {
    setLoading(true); setSelectedId(null); setSearch(''); setStageFilter('all');
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
    return matchesSearch && (stageFilter === 'all' || application.stage === stageFilter) && (!highOnly || application.priority === 'high');
  }), [applications, search, stageFilter, highOnly]);

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
    return <section className="applications-section">
      <div className="section-heading"><div className="heading-with-count"><h2>{page === 'overview' ? 'Recent applications' : 'All applications'}</h2><span className="count-pill">{applications.length}</span></div><div className="table-heading-actions"><a className="button quiet small" href={`/api/export?workspace=${workspace}`} download><DownloadSimple size={16} />Export</a>{page === 'overview' && applications.length > 8 && <button className="text-button" onClick={() => setPage('applications')}>View all<ArrowRight size={15} /></button>}</div></div>
      <div className="table-toolbar"><div className="search-field"><MagnifyingGlass size={17} /><input aria-label="Search applications" placeholder="Search company or role" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</div><div className="filter-controls"><label className="sr-only" htmlFor="stage-filter">Filter by stage</label><select id="stage-filter" value={stageFilter} onChange={event => setStageFilter(event.target.value)}><option value="all">All stages</option>{STAGES.map(stage => <option value={stage} key={stage}>{STAGE_LABELS[stage]}</option>)}</select><button className={`button secondary small filter-priority${highOnly ? ' active' : ''}`} aria-pressed={highOnly} onClick={() => setHighOnly(value => !value)}><Flag size={15} weight={highOnly ? 'fill' : 'regular'} />High priority</button></div></div>
      <div className="table-container"><table className="applications-table"><thead><tr><th>Company / role</th><th>Stage</th><th>Next action</th><th>Deadline</th><th>Applied</th><th><span className="sr-only">Open application</span></th></tr></thead><tbody>
        {visible.map(application => { const task = nextTask(application); const emailConfirmed = application.evidence.some(evidence => evidence.source === 'email' && evidence.kind === 'submission_confirmed' && evidence.review === 'accepted'); return <tr key={application.id} onClick={() => setSelectedId(application.id)}>
          <td><div className="company-cell"><CompanyMark company={application.company} small /><div><button className="application-title" onClick={event => { event.stopPropagation(); setSelectedId(application.id); }}>{application.company}{application.priority === 'high' && <Flag size={12} weight="fill" />}</button><span className="role-name">{application.role}</span></div></div></td>
          <td><StageBadge stage={application.stage} /></td><td><span className="next-action">{task?.title || (application.stage === 'saved' ? 'Not submitted' : application.stage === 'in_progress' ? 'Confirm submission' : ['rejected', 'withdrawn'].includes(application.stage) ? 'No action needed' : application.stage === 'offer' ? 'Review offer' : 'Waiting for an update')}</span>{application.evidence.some(evidence => evidence.review === 'pending') && <span className="review-hint">Update needs review</span>}</td>
          <td><span className={task && isOverdue(task) ? 'overdue' : 'muted'}>{task?.dueAt ? relativeDate(task.dueAt) : 'Not set'}</span></td><td><span className="applied-date">{application.appliedAt ? dateLabel(application.appliedAt) : 'Not applied'}{emailConfirmed && <span title="Confirmed by email"><ShieldCheck size={14} /></span>}</span></td><td><CaretRight size={15} className="row-arrow" /></td>
        </tr>; })}
      </tbody></table>{visible.length === 0 && <div className="filtered-empty"><MagnifyingGlass size={24} /><h3>No applications match</h3><p>Try another search or clear your filters.</p><button className="button secondary small" onClick={() => { setSearch(''); setStageFilter('all'); setHighOnly(false); }}>Clear filters</button></div>}</div>
      <div className="table-footer"><span>{visible.length} of {applications.length} applications</span><span>Changes are saved automatically</span></div>
    </section>;
  }

  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); setPage('overview'); }} aria-label="Apply overview"><span className="brand-mark"><Check size={22} weight="bold" /></span><span>Apply</span></a>
      <div className="workspace-label">Your workspace</div><nav aria-label="Main navigation">{pages.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item${page === id ? ' active' : ''}`} onClick={() => { setPage(id); setSearch(''); }} aria-current={page === id ? 'page' : undefined}><Icon size={20} weight={page === id ? 'fill' : 'regular'} /><span>{label}</span>{id === 'tasks' && pendingTasks.length > 0 && <span className="nav-count">{pendingTasks.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-status"><span className="local-icon"><ShieldCheck size={18} /></span><div><strong>Stored on this computer</strong><span>Local workspace</span></div></div><button className="workspace-switch" onClick={() => { if (sessionActive) { notify('Stop tracking before switching workspaces.', true); return; } setWorkspace(workspace === 'demo' ? 'personal' : 'demo'); }}><span className="workspace-avatar">{workspace === 'demo' ? 'D' : 'M'}</span><span><strong>{workspace === 'demo' ? 'Demo workspace' : 'My workspace'}</strong><span>{workspace === 'demo' ? 'Switch to your applications' : 'Explore demo applications'}</span></span><CaretRight size={14} /></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumbs"><span>{workspace === 'demo' ? 'Demo workspace' : 'My workspace'}</span><CaretRight size={12} /><strong>{pages.find(item => item.id === page)?.label}</strong></div><div className="topbar-actions"><span className={`tracking-status${sessionActive ? ' running' : ''}`}><span className="status-dot" />{sessionActive ? screenActive ? 'Screen capture on' : 'Session active' : 'Tracking off'}</span><button className={`button ${sessionActive ? 'secondary' : 'primary'} tracking-button`} disabled={trackingBusy} onClick={() => { if (sessionActive) void stopTracking(); else if (workspace === 'demo') { notify('Switch to your workspace to start tracking.', true); } else { setTrackingError(''); setTrackingOpen(true); } }}>{sessionActive ? <Stop size={15} weight="fill" /> : <Record size={17} />}{trackingBusy ? 'Working…' : sessionActive ? 'Stop tracking' : 'Start tracking'}</button></div></header>
      <main className="main-content" id="main-content">
        {workspace === 'demo' && <div className="demo-banner"><span><strong>Demo workspace</strong> These are sample applications. Your real applications are separate.</span><button onClick={() => { if (!sessionActive) setWorkspace('personal'); else notify('Stop tracking before switching workspaces.', true); }}>Go to my workspace<ArrowRight size={14} /></button></div>}
        <div className="page-heading"><div><h1>{pages.find(item => item.id === page)?.label}</h1><p className="page-description">{page === 'overview' ? 'Your applications and next steps.' : page === 'applications' ? 'Every role, with the details in one place.' : page === 'tasks' ? 'Assessments, interviews and follow-ups.' : 'Manage browser tracking and email updates.'}</p></div>{page !== 'connections' && <button className="button secondary" onClick={() => setEditor('new')}><Plus size={18} />Add application</button>}</div>
        {loadError && <div className="error-banner" role="alert"><WarningCircle size={20} /><div><strong>Could not reach the local server</strong><p>{loadError}</p></div><button className="button secondary small" onClick={() => void refresh()}>Try again</button></div>}
        {loading ? <div className="loading-layout" aria-label="Loading applications"><div className="skeleton skeleton-stats" /><div className="skeleton skeleton-heading" />{Array.from({ length: 5 }, (_, index) => <div className="skeleton skeleton-row" key={index} />)}</div> : <>
          {page === 'connections' ? <Connections settings={settings} applications={applications} workspace={workspace} onChange={() => void refresh()} notify={notify} /> : <>
            {page === 'overview' && <div className="stats-row"><div className="stat"><span>Total applications</span><strong>{applications.length}</strong><span className="stat-detail">{activeApplications.length} active</span></div><div className="stat"><span>Needs attention</span><strong>{pendingTasks.length + reviewApplications.length + unmatchedEmailCount}</strong><span className="stat-detail">{pendingTasks.filter(({ task }) => isOverdue(task)).length > 0 ? `${pendingTasks.filter(({ task }) => isOverdue(task)).length} overdue` : 'Tasks and updates to review'}</span></div><div className="stat"><span>Interviewing</span><strong>{applications.filter(application => application.stage === 'interviewing').length}</strong><span className="stat-detail">Current interview processes</span></div><div className="stat"><span>Offers</span><strong>{applications.filter(application => application.stage === 'offer').length}</strong><span className="stat-detail">Offers received</span></div></div>}
            {unmatchedEmailCount > 0 && applications.length === 0 && <div className="unmatched-note"><EnvelopeSimple size={19} /><span>{unmatchedEmailCount} {unmatchedEmailCount === 1 ? 'email needs' : 'emails need'} an application.</span><button className="text-button" onClick={() => setPage('connections')}>Review emails<ArrowRight size={14} /></button></div>}{applications.length === 0 ? <section className="first-run"><EmptyState icon={<Briefcase size={31} />} title="Track your first application" description="Start a tracking session as you apply, or add an application you have already submitted."><button className="button primary" onClick={() => setEditor('new')}><Plus size={17} />Add application</button><button className="button secondary" onClick={() => { if (sessionActive) notify('Stop tracking before switching workspaces.', true); else setWorkspace('demo'); }}>Explore demo</button></EmptyState><div className="first-run-steps"><button onClick={() => setPage('connections')}><LinkSimple size={21} /><span><strong>Set up browser tracking</strong><span>Capture job details as you apply.</span></span><ArrowUpRight size={16} /></button><button onClick={() => setPage('connections')}><EnvelopeSimple size={21} /><span><strong>Connect your inbox</strong><span>Keep responses and next steps together.</span></span><ArrowUpRight size={16} /></button></div></section> : <>
              {page === 'overview' && <section className="attention-section"><div className="section-heading"><div className="heading-with-count"><h2>Needs attention</h2>{pendingTasks.length + reviewApplications.length + unmatchedEmailCount > 0 && <span className="count-pill">{pendingTasks.length + reviewApplications.length + unmatchedEmailCount}</span>}</div>{pendingTasks.length > 0 && <button className="text-button" onClick={() => setPage('tasks')}>View tasks<ArrowRight size={15} /></button>}</div>{pendingTasks.length || reviewApplications.length || unmatchedEmailCount ? <div className="attention-list">{pendingTasks.slice(0, 3).map(({ task, application }) => <TaskRow key={task.id} task={task} application={application} onToggle={toggleTask} onOpen={() => setSelectedId(application.id)} busy={taskBusy === task.id} />)}{unmatchedEmailCount > 0 && <button className="review-row" onClick={() => setPage('connections')}><EnvelopeSimple size={20} /><span><strong>{unmatchedEmailCount} {unmatchedEmailCount === 1 ? 'email needs' : 'emails need'} an application</strong><span>Match messages to the right role.</span></span><CaretRight size={16} /></button>}{reviewApplications.slice(0, 1).map(application => <button className="review-row" key={application.id} onClick={() => setSelectedId(application.id)}><WarningCircle size={20} /><span><strong>Review application update</strong><span>{application.company} · {application.role}</span></span><CaretRight size={16} /></button>)}</div> : <div className="attention-clear"><CheckCircle size={22} /><div><strong>No outstanding tasks</strong><span>New assessments and next steps will appear here.</span></div></div>}</section>}
              {page === 'tasks' ? <section className="tasks-section"><div className="tasks-toolbar"><div className="segmented-control" aria-label="Task view"><button className={taskView === 'upcoming' ? 'active' : ''} onClick={() => setTaskView('upcoming')}>Upcoming<span>{pendingTasks.length}</span></button><button className={taskView === 'completed' ? 'active' : ''} onClick={() => setTaskView('completed')}>Completed<span>{allTasks.filter(({ task }) => !!task.completedAt).length}</span></button></div><span className="muted">Sorted by deadline</span></div>{allTasks.filter(({ task }) => taskView === 'completed' ? !!task.completedAt : !task.completedAt).length ? <div className="task-list">{allTasks.filter(({ task }) => taskView === 'completed' ? !!task.completedAt : !task.completedAt).map(({ task, application }) => <TaskRow key={task.id} task={task} application={application} onToggle={toggleTask} onOpen={() => setSelectedId(application.id)} busy={taskBusy === task.id} />)}</div> : <EmptyState icon={<CheckCircle size={30} />} title={taskView === 'completed' ? 'No completed tasks yet' : 'No upcoming tasks'} description={taskView === 'completed' ? 'Completed assessments and follow-ups will appear here.' : 'Open an application to add an assessment, interview or follow-up.'}><button className="button secondary" onClick={() => setPage('applications')}>View applications</button></EmptyState>}</section> : renderApplicationTable()}
            </>}
          </>}
        </>}
      </main>
    </div>
    {selected && <ApplicationDetail key={selected.id} application={selected} onClose={() => setSelectedId(null)} onChange={() => void refresh()} onEdit={() => setEditor(selected)} onDelete={() => void deleteApplication()} onTaskToggle={toggleTask} onError={message => notify(message, true)} />}
    {editor && <ApplicationEditor application={editor === 'new' ? undefined : editor} workspace={workspace} onClose={() => setEditor(null)} onSaved={application => { setEditor(null); setSelectedId(application.id); void refresh(); notify(editor === 'new' ? 'Application added.' : 'Application updated.'); }} />}
    <Modal open={trackingOpen} onClose={() => { if (!trackingBusy) setTrackingOpen(false); }} title="Start tracking" description="Apply normally. Keep this dashboard open during your session.">
      <div className="modal-body"><div className="tracking-option"><span className="connection-icon"><LinkSimple size={22} /></span><div><strong>Browser tracking</strong><p>Read job details and submission messages on supported sites. Requires the paired extension.</p></div><Check size={19} className="blue-icon" /></div><label className="tracking-option screen-option"><span className="connection-icon"><Monitor size={22} /></span><span><strong>Screen capture</strong><span className="option-description">Choose a browser window or tab. Check visible confirmations while the session is running.</span></span><input type="checkbox" checked={screenEnabled} onChange={event => setScreenEnabled(event.target.checked)} /></label><p className="capture-note"><ShieldCheck size={17} />Screen analysis runs locally. Only relevant confirmation snapshots are saved.</p>{trackingError && <p className="form-error" role="alert">{trackingError}</p>}</div><div className="modal-footer"><button className="button secondary" onClick={() => setTrackingOpen(false)} disabled={trackingBusy}>Cancel</button><button className="button primary" onClick={() => void beginTracking()} disabled={trackingBusy}><Record size={17} />{trackingBusy ? 'Starting…' : screenEnabled ? 'Choose screen and start' : 'Start session'}</button></div>
    </Modal>
    {toast && <div className={`toast${toast.error ? ' error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <WarningCircle size={19} /> : <CheckCircle size={19} />}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}
