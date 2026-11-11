import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowClockwise, Bell, BellSlash, CaretDown, Check, Clock, WarningCircle, X } from '@phosphor-icons/react';
import type { Workspace } from '../shared/types';
import { DEFAULT_REMINDER_PREFERENCES, PRIVATE_REMINDER_NOTIFICATION, type ReminderDelivery, type ReminderItem, type ReminderPreferences, type ReminderSnapshot } from '../shared/reminders';
import { api } from './api';
import './reminders.css';

const browserPermission = () => 'Notification' in window ? Notification.permission : 'unsupported' as const;
const currentTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function timeLabel(value: string, timeZone?: string | null) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}
function deadlineLabel(item: ReminderItem, timeZone: string | null) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(item.dueAt)) return new Date(`${item.dueAt}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return timeLabel(item.dueAt, timeZone);
}
export interface ReminderNotifier { notify(item: ReminderDelivery): Promise<boolean>; }
export interface ReminderModel {
  preferences: ReminderPreferences; items: ReminderItem[]; loading: boolean; error: string; deliveryError: string; busy: string;
  desktop: boolean; available: boolean; permission: NotificationPermission | 'unsupported';
  refresh(): Promise<void>;
  savePreferences(patch: Partial<ReminderPreferences>): Promise<void>;
  enableNotifications(patch?: Partial<ReminderPreferences>): Promise<void>;
  snooze(id: string, minutes: number): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export function useReminders({ workspace, desktop = false, onOpenApplication, notifier }: { workspace: Workspace; desktop?: boolean; onOpenApplication?: (id: string) => void; notifier?: ReminderNotifier }): ReminderModel {
  const [snapshot, setSnapshot] = useState<ReminderSnapshot>({ preferences: { ...DEFAULT_REMINDER_PREFERENCES }, items: [], serverTime: '' });
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [deliveryError, setDeliveryError] = useState(''), [busy, setBusy] = useState('');
  const [permission, setPermission] = useState(browserPermission);
  const [clientId] = useState(() => `browser:${crypto.randomUUID()}`);
  const lifecycle = useRef<AbortController | null>(null);
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const inFlight = useRef(false);
  const requestSequence = useRef(0);
  const notifications = useRef(new Set<Notification>());
  const onOpen = useRef(onOpenApplication); onOpen.current = onOpenApplication;

  const refresh = useCallback(async () => {
    if (workspace !== 'personal') { setSnapshot({ preferences: { ...DEFAULT_REMINDER_PREFERENCES }, items: [], serverTime: '' }); setLoading(false); return; }
    const signal = lifecycle.current?.signal;
    const request = ++requestSequence.current;
    try {
      const result = await api<ReminderSnapshot>('/reminders', { signal });
      if (signal?.aborted || workspaceRef.current !== workspace || request !== requestSequence.current) return;
      setSnapshot(result); setError('');
    } catch (error) { if (!signal?.aborted && workspaceRef.current === workspace && request === requestSequence.current) setError(error instanceof Error ? error.message : 'Could not load reminders.'); }
    finally { if (!signal?.aborted && workspaceRef.current === workspace && request === requestSequence.current) setLoading(false); }
  }, [workspace]);

  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    setSnapshot({ preferences: { ...DEFAULT_REMINDER_PREFERENCES }, items: [], serverTime: '' }); setLoading(true); setError(''); setDeliveryError('');
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    const focus = () => { setPermission(browserPermission()); void refresh(); };
    window.addEventListener('focus', focus);
    return () => {
      controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus);
      for (const notification of notifications.current) notification.close();
      notifications.current.clear();
    };
  }, [refresh]);

  useEffect(() => {
    if (desktop || workspace !== 'personal' || !snapshot.preferences.enabled || (!notifier && permission !== 'granted')) return;
    const controller = new AbortController();
    const parentSignal = lifecycle.current?.signal;
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const signal = controller.signal;
    async function deliver() {
      if (inFlight.current || signal?.aborted) return;
      inFlight.current = true;
      try {
        const { deliveries } = await api<{ deliveries: ReminderDelivery[] }>('/reminders/claim', { method: 'POST', body: JSON.stringify({ clientId, limit: 3 }), signal });
        for (const item of deliveries) {
          if (signal?.aborted) break;
          let displayed = false;
          if (notifier) displayed = await notifier.notify(item);
          else displayed = await new Promise<boolean>(resolve => {
            let settled = false;
            const notification = new Notification(PRIVATE_REMINDER_NOTIFICATION.title, { body: PRIVATE_REMINDER_NOTIFICATION.body, tag: item.id });
            notifications.current.add(notification);
            const finish = (shown: boolean) => { if (settled) return; settled = true; clearTimeout(timeout); resolve(shown); };
            const timeout = setTimeout(() => { notification.close(); finish(false); }, 8000);
            notification.onshow = () => finish(true);
            notification.onerror = () => { notifications.current.delete(notification); finish(false); };
            notification.onclose = () => notifications.current.delete(notification);
            notification.onclick = () => { window.focus(); onOpen.current?.(item.applicationId); notification.close(); };
            signal?.addEventListener('abort', () => { notification.close(); finish(false); }, { once: true });
          });
          if (displayed && !signal?.aborted) {
            await api(`/reminders/${item.id}/ack`, { method: 'POST', body: JSON.stringify({ clientId, leaseId: item.leaseId }), signal });
            setDeliveryError('');
          } else if (!signal?.aborted) setDeliveryError('A notification could not be shown. Your reminders are still listed here.');
        }
        if (deliveries.length && !signal?.aborted) await refresh();
      } catch (error) { if (!signal?.aborted) setDeliveryError(error instanceof Error ? error.message : 'Notifications could not be checked.'); }
      finally { inFlight.current = false; }
    }
    void deliver(); const timer = setInterval(() => { void deliver(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); parentSignal?.removeEventListener('abort', abort); }; 
  }, [desktop, workspace, snapshot.preferences.enabled, snapshot.preferences.timeZone, permission, notifier, clientId, refresh]);

  async function savePreferences(patch: Partial<ReminderPreferences>) {
    if (workspace !== 'personal') return;
    setBusy('settings');
    try { const preferences = await api<ReminderPreferences>('/reminders/preferences', { method: 'PATCH', body: JSON.stringify(patch), signal: lifecycle.current?.signal }); setSnapshot(current => ({ ...current, preferences })); setError(''); await refresh(); }
    finally { setBusy(''); }
  }
  async function enableNotifications(patch: Partial<ReminderPreferences> = {}) {
    if (workspace !== 'personal') return;
    if (!desktop && !notifier) {
      if (!('Notification' in window)) throw new Error('This browser does not support notifications. Use the desktop app for deadline alerts.');
      const permission = await Notification.requestPermission(); setPermission(permission);
      if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings, then try again.');
    }
    await savePreferences({ ...patch, enabled: true, timeZone: patch.timeZone || snapshot.preferences.timeZone || currentTimeZone() });
  }
  async function action(id: string, kind: 'snooze' | 'dismiss', minutes?: number) {
    if (workspace !== 'personal') return;
    setBusy(`${kind}:${id}`);
    try { await api(`/reminders/${id}/${kind}`, { method: 'POST', body: JSON.stringify(kind === 'snooze' ? { minutes } : {}), signal: lifecycle.current?.signal }); await refresh(); }
    finally { setBusy(''); }
  }
  return { ...snapshot, loading, error, deliveryError, busy, desktop, available: workspace === 'personal', permission, refresh, savePreferences, enableNotifications, snooze: (id, minutes) => action(id, 'snooze', minutes), dismiss: id => action(id, 'dismiss') };
}

export function ReminderSettings({ model }: { model: ReminderModel }) {
  const [leadMinutes, setLeadMinutes] = useState(model.preferences.leadMinutes), [dateOnlyTime, setDateOnlyTime] = useState(model.preferences.dateOnlyTime), [timeZone, setTimeZone] = useState(model.preferences.timeZone || currentTimeZone());
  const [error, setError] = useState(''), [saved, setSaved] = useState(false);
  useEffect(() => { setLeadMinutes(model.preferences.leadMinutes); setDateOnlyTime(model.preferences.dateOnlyTime); setTimeZone(model.preferences.timeZone || currentTimeZone()); }, [model.preferences.leadMinutes, model.preferences.dateOnlyTime, model.preferences.timeZone]);
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setSaved(false);
    try { await model.savePreferences({ leadMinutes, dateOnlyTime, timeZone }); setSaved(true); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save reminder settings.'); }
  }
  async function toggle() {
    setError(''); setSaved(false);
    try { if (model.preferences.enabled) await model.savePreferences({ enabled: false }); else await model.enableNotifications({ leadMinutes, dateOnlyTime, timeZone }); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not change notifications.'); }
  }
  return <section className="reminder-settings" aria-labelledby="reminder-settings-title">
    <div className="reminder-section-heading"><div><h2 id="reminder-settings-title">Deadline reminders</h2><p>Get a notification before an assessment, interview or follow-up is due.</p></div><Bell size={22} aria-hidden="true" /></div>
    <div className="reminder-settings-body">
      {!model.available && <p className="reminder-warning">Switch to your personal workspace to set up reminders.</p>}
      <div className="reminder-enable-row"><div><strong>{model.preferences.enabled ? 'Notifications enabled' : 'Notifications off'}</strong><p>{model.desktop ? 'Reminders run while ApplyTrack is open, including in the menu bar.' : 'Keep ApplyTrack open in this browser to receive notifications.'}</p></div><button className="button secondary small" onClick={() => void toggle()} disabled={!!model.busy || model.loading || !model.available}>{model.preferences.enabled ? <BellSlash size={16} /> : <Bell size={16} />}{model.preferences.enabled ? 'Turn off' : 'Enable notifications'}</button></div>
      {!model.desktop && model.preferences.enabled && model.permission !== 'granted' && <p className="reminder-warning"><WarningCircle size={16} />Notifications are blocked on this browser. Allow them in browser settings.</p>}
      <form className="reminder-settings-form" onSubmit={save}>
        <div className="reminder-fields"><label className="field"><span>Remind me</span><select value={leadMinutes} onChange={event => { setLeadMinutes(Number(event.target.value)); setSaved(false); }} disabled={!!model.busy || model.loading || !model.available}><option value={0}>At the deadline</option><option value={15}>15 minutes before</option><option value={60}>1 hour before</option><option value={1440}>1 day before</option><option value={2880}>2 days before</option><option value={10080}>1 week before</option></select></label><label className="field"><span>For deadlines without a time</span><input type="time" value={dateOnlyTime} onChange={event => { setDateOnlyTime(event.target.value); setSaved(false); }} required disabled={!!model.busy || model.loading || !model.available} /></label></div>
        <div className="reminder-timezone"><label className="field"><span>Time zone</span><input value={timeZone} onChange={event => { setTimeZone(event.target.value); setSaved(false); }} list="reminder-timezones" required maxLength={100} disabled={!!model.busy || model.loading || !model.available} /><datalist id="reminder-timezones"><option value={currentTimeZone()} /><option value="UTC" /><option value="America/New_York" /><option value="America/Los_Angeles" /><option value="Europe/London" /><option value="Asia/Singapore" /></datalist></label>{timeZone !== currentTimeZone() && <button type="button" className="text-button" onClick={() => { setTimeZone(currentTimeZone()); setSaved(false); }}>Use this device’s time zone</button>}</div>
        <div className="reminder-settings-actions"><button className="button secondary small" disabled={!!model.busy || model.loading || !model.available}>{model.busy === 'settings' ? 'Saving…' : 'Save reminder settings'}</button>{saved && <span className="reminder-saved" role="status"><Check size={15} />Saved</span>}</div>
      </form>
      {(error || model.error) && <p className="reminder-error" role="alert">{error || model.error}</p>}
    </div>
  </section>;
}

export function ReminderCenter({ model, onOpenApplication }: { model: ReminderModel; onOpenApplication: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false), [error, setError] = useState('');
  const visible = expanded ? model.items : model.items.slice(0, 5);
  async function action(id: string, type: 'snooze' | 'dismiss', minutes?: number) {
    setError(''); try { if (type === 'dismiss') await model.dismiss(id); else await model.snooze(id, minutes ?? 60); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update reminder.'); }
  }
  return <section className="reminder-center" aria-labelledby="reminder-center-title">
    <div className="reminder-section-heading"><div><h2 id="reminder-center-title">Reminders <span className="count-pill">{model.items.length}</span></h2><p>{model.preferences.enabled ? 'Upcoming deadlines and reminders you have snoozed.' : 'Your deadlines are listed here. Enable notifications in Connections.'}</p></div><button className="icon-button" onClick={() => void model.refresh()} aria-label="Refresh reminders" disabled={model.loading}><ArrowClockwise size={18} /></button></div>
    {(error || model.error || model.deliveryError) && <p className="reminder-error" role="alert">{error || model.error || model.deliveryError}</p>}
    {model.loading ? <div className="reminder-empty" role="status">Loading reminders…</div> : !model.items.length ? <div className="reminder-empty"><Clock size={22} /><div><strong>No reminders</strong><p>Add a due date to a task to see it here.</p></div></div> : <div className="reminder-list">{visible.map(item => <article className="reminder-row" key={item.id}>
      <button className="reminder-copy" onClick={() => onOpenApplication(item.applicationId)}><strong>{item.title}</strong><span>{item.company} <span aria-hidden="true">·</span> {item.role}</span><span className="reminder-due">Due {deadlineLabel(item, model.preferences.timeZone)}</span></button>
      <div className="reminder-row-end"><span className={`reminder-state reminder-state-${item.status}`}>{item.status === 'snoozed' ? <><Clock size={13} />Until {timeLabel(item.snoozedUntil!, model.preferences.timeZone)}</> : item.status === 'notified' ? <><Check size={13} />Notified</> : item.status === 'due' ? 'Ready' : 'Upcoming'}</span><div className="reminder-row-actions"><label className="reminder-snooze"><span className="sr-only">Snooze {item.title}</span><select aria-label={`Snooze ${item.title}`} value="" onChange={event => { if (event.target.value) void action(item.id, 'snooze', Number(event.target.value)); }} disabled={!!model.busy || model.loading || !model.available}><option value="" disabled>Snooze</option><option value="15">15 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option></select><CaretDown size={13} aria-hidden="true" /></label><button className="icon-button" onClick={() => void action(item.id, 'dismiss')} aria-label={`Dismiss reminder for ${item.title}`} title="Dismiss reminder" disabled={!!model.busy || model.loading || !model.available}><X size={16} /></button></div></div>
    </article>)}</div>}
    {model.items.length > 5 && <button className="text-button reminder-show-all" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer reminders' : `Show all ${model.items.length} reminders`}</button>}
  </section>;
}
