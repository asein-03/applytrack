import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import type { Task } from '../shared/types.js';
import { DEFAULT_REMINDER_PREFERENCES, type ReminderDelivery, type ReminderItem, type ReminderPreferences, type ReminderSnapshot } from '../shared/reminders.js';
import type { CloudActor, CloudService, WorkspaceRepository } from './cloud.js';
import { HttpError, type Store } from './store.js';

const minute = 60_000;
export const REMINDER_LEASE_MS = 30_000;
const preferencesKey = 'reminder:preferences';
interface ReminderState {
  deliveredAt?: string | null;
  snoozedUntil?: string | null;
  dismissedAt?: string | null;
  lease?: { id: string; clientId: string; expiresAt: string } | null;
  lastAcknowledged?: { id: string; clientId: string };
}
const stateKey = (id: string) => `reminder:item:${id}`;
export function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return value.length <= 100; }
  catch { return false; }
}
const preferencesSchema = z.object({
  enabled: z.boolean(), leadMinutes: z.number().int().min(0).max(10080),
  timeZone: z.string().min(1).max(100).refine(validTimeZone, 'Choose a valid time zone.').nullable(),
  dateOnlyTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).strict();
const patchSchema = preferencesSchema.partial().refine(value => Object.keys(value).length > 0, 'Provide a setting to update.');
const clientIdSchema = z.string().min(8).max(120).regex(/^[a-zA-Z0-9:_-]+$/);
const reminderId = (applicationId: string, task: Task) => createHash('sha256').update(JSON.stringify([applicationId, task.id, /^\d{4}-\d{2}-\d{2}$/.test(task.dueAt!) ? task.dueAt : new Date(task.dueAt!).toISOString()])).digest('hex');

/** Date-only deadlines are calendar dates in the explicitly saved time zone. */
export function zonedReminderTime(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number), [hour, minutes] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minutes);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const representedTime = (value: number) => {
    const values = Object.fromEntries(formatter.formatToParts(value).map(part => [part.type, part.value]));
    return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  };
  const offsets = new Set([-86400000, 0, 86400000].map(delta => representedTime(target + delta) - (target + delta)));
  const candidates = [...offsets].map(offset => target - offset).sort((a, b) => a - b);
  const exact = candidates.find(candidate => representedTime(candidate) === target);
  if (exact !== undefined) return exact;
  // A skipped clock time advances by the DST gap; repeated times use the first occurrence.
  const after = candidates.filter(candidate => representedTime(candidate) > target).sort((a, b) => representedTime(a) - representedTime(b));
  if (after.length) return after[0];
  throw new HttpError(422, 'This deadline could not be scheduled in the selected time zone.');
}

export function readReminderPreferences(store: Store): ReminderPreferences {
  const saved = preferencesSchema.safeParse(store.getMeta(preferencesKey));
  return saved.success ? saved.data : { ...DEFAULT_REMINDER_PREFERENCES };
}
export function listReminders(store: Store, now: number): ReminderSnapshot {
  const preferences = readReminderPreferences(store);
  const items: ReminderItem[] = [];
  for (const application of store.listApplications('personal')) {
    for (const task of application.tasks) {
      if (task.completedAt || !task.dueAt || !Number.isFinite(new Date(task.dueAt).getTime())) continue;
      const id = reminderId(application.id, task);
      const state = store.getMeta<ReminderState>(stateKey(id)) ?? {};
      if (state.dismissedAt) continue;
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(task.dueAt);
      // Before setup the in-app list uses UTC; native/browser delivery stays disabled.
      const daysBefore = Math.floor(preferences.leadMinutes / 1440);
      const reminderDate = dateOnly ? new Date(new Date(`${task.dueAt}T12:00:00Z`).getTime() - daysBefore * 86400000).toISOString().slice(0, 10) : '';
      const scheduled = dateOnly
        ? zonedReminderTime(reminderDate, preferences.dateOnlyTime, preferences.timeZone ?? 'UTC') - (preferences.leadMinutes % 1440) * minute
        : new Date(task.dueAt).getTime() - preferences.leadMinutes * minute;
      const due = state.snoozedUntil ? new Date(state.snoozedUntil).getTime() : scheduled;
      items.push({ id, applicationId: application.id, taskId: task.id, title: task.title, company: application.company, role: application.role, dueAt: task.dueAt,
        scheduledAt: new Date(scheduled).toISOString(), snoozedUntil: state.snoozedUntil ?? null, deliveredAt: state.deliveredAt ?? null,
        status: state.snoozedUntil && due > now ? 'snoozed' : state.deliveredAt ? 'notified' : due <= now ? 'due' : 'upcoming' });
    }
  }
  items.sort((a, b) => new Date(a.snoozedUntil ?? a.scheduledAt).getTime() - new Date(b.snoozedUntil ?? b.scheduledAt).getTime());
  return { preferences, items, serverTime: new Date(now).toISOString() };
}

export class ReminderService {
  private preferenceListeners = new Set<(change: { userId: string | null; preferences: ReminderPreferences }) => void>();
  onPreferencesChanged(listener: (change: { userId: string | null; preferences: ReminderPreferences }) => void): () => void {
    this.preferenceListeners.add(listener); return () => { this.preferenceListeners.delete(listener); };
  }
  constructor(private store: Store, private options: { cloud?: CloudService; repository?: WorkspaceRepository; now?: () => number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private async run<T>(actor: CloudActor | null, write: boolean, action: (store: Store) => T) {
    if (this.options.repository) return this.options.repository.run('personal', actor, write, action);
    if (this.options.cloud?.enabled && !actor) throw new HttpError(401, 'Sign in to manage reminders.');
    return Promise.resolve(action(this.store));
  }
  snapshot(actor: CloudActor | null): Promise<ReminderSnapshot> { return this.run(actor, false, store => listReminders(store, this.now())); }
  async preferences(actor: CloudActor | null, patch: unknown): Promise<ReminderPreferences> {
    const input = patchSchema.parse(patch);
    const result = await this.run(actor, true, store => {
      const previous = readReminderPreferences(store);
      const next = preferencesSchema.parse({ ...previous, ...input });
      if (next.enabled && !next.timeZone) throw new HttpError(422, 'Choose a time zone before enabling reminders.');
      const changed = JSON.stringify(previous) !== JSON.stringify(next);
      if (changed) {
        for (const entry of store.listMeta<ReminderState>('reminder:item:')) if (entry.value.lease) store.setMeta(entry.key, { ...entry.value, lease: null });
      }
      store.setMeta(preferencesKey, next);
      return { preferences: next, changed };
    });
    if (result.changed) for (const listener of this.preferenceListeners) { try { listener({ userId: actor?.id ?? null, preferences: result.preferences }); } catch { /* Notification cleanup cannot invalidate saved preferences. */ } }
    return result.preferences;
  }
  validateDelivery(actor: CloudActor | null, id: string, delivery: { clientId: string; leaseId: string }): Promise<ReminderDelivery | null> {
    return this.run(actor, false, store => {
      const now = this.now(), snapshot = listReminders(store, now);
      if (!snapshot.preferences.enabled || !snapshot.preferences.timeZone) return null;
      const item = snapshot.items.find(item => item.id === id && item.status === 'due');
      const lease = store.getMeta<ReminderState>(stateKey(id))?.lease;
      if (!item || !lease || lease.clientId !== delivery.clientId || lease.id !== delivery.leaseId || new Date(lease.expiresAt).getTime() <= now) return null;
      return { ...item, leaseId: lease.id, leaseExpiresAt: lease.expiresAt };
    });
  }
  async claim(actor: CloudActor | null, input: { clientId: string; limit?: number }): Promise<ReminderDelivery[]> {
    const { clientId, limit } = z.object({ clientId: clientIdSchema, limit: z.number().int().min(1).max(5).default(3) }).strict().parse(input);
    return this.run(actor, true, store => {
      const now = this.now(), snapshot = listReminders(store, now);
      if (!snapshot.preferences.enabled || !snapshot.preferences.timeZone) return [];
      const deliveries: ReminderDelivery[] = [];
      for (const item of snapshot.items) {
        if (item.status !== 'due') continue;
        const state = store.getMeta<ReminderState>(stateKey(item.id)) ?? {};
        if (state.lease && new Date(state.lease.expiresAt).getTime() > now) continue;
        const lease = { id: randomUUID(), clientId, expiresAt: new Date(now + REMINDER_LEASE_MS).toISOString() };
        store.setMeta(stateKey(item.id), { ...state, lease });
        deliveries.push({ ...item, leaseId: lease.id, leaseExpiresAt: lease.expiresAt });
        if (deliveries.length >= limit) break;
      }
      return deliveries;
    });
  }
  async acknowledge(actor: CloudActor | null, id: string, input: { clientId: string; leaseId: string }): Promise<void> {
    const delivery = z.object({ clientId: clientIdSchema, leaseId: z.uuid() }).strict().parse(input);
    return this.run(actor, true, store => {
      const now = this.now();
      const state = store.getMeta<ReminderState>(stateKey(id)) ?? {};
      if (state.deliveredAt && state.lastAcknowledged?.id === delivery.leaseId && state.lastAcknowledged.clientId === delivery.clientId) return;
      const snapshot = listReminders(store, now);
      const item = snapshot.items.find(item => item.id === id);
      if (!item) throw new HttpError(404, 'This reminder is no longer active.');
      if (!snapshot.preferences.enabled) throw new HttpError(409, 'Reminder notifications are disabled.');
      if (!state.lease || state.lease.id !== delivery.leaseId || state.lease.clientId !== delivery.clientId || new Date(state.lease.expiresAt).getTime() <= now) throw new HttpError(409, 'This reminder delivery has expired or changed.');
      store.setMeta(stateKey(id), { ...state, deliveredAt: new Date(now).toISOString(), lease: null, snoozedUntil: null, lastAcknowledged: { id: delivery.leaseId, clientId: delivery.clientId } });
    });
  }
  async snooze(actor: CloudActor | null, id: string, minutes: number): Promise<void> {
    z.number().int().min(1).max(10080).parse(minutes);
    return this.run(actor, true, store => {
      const now = this.now();
      if (!listReminders(store, now).items.some(item => item.id === id)) throw new HttpError(404, 'This reminder is no longer active.');
      const state = store.getMeta<ReminderState>(stateKey(id)) ?? {};
      store.setMeta(stateKey(id), { ...state, deliveredAt: null, lease: null, snoozedUntil: new Date(now + minutes * minute).toISOString() });
    });
  }
  async dismiss(actor: CloudActor | null, id: string): Promise<void> {
    return this.run(actor, true, store => {
      if (!listReminders(store, this.now()).items.some(item => item.id === id)) throw new HttpError(404, 'This reminder is no longer active.');
      store.setMeta(stateKey(id), { dismissedAt: new Date(this.now()).toISOString(), lease: null });
    });
  }
}

export function attachReminderRoutes(app: Express, store: Store, options: { cloud?: CloudService; repository?: WorkspaceRepository; now?: () => number } = {}) {
  const service = new ReminderService(store, options);
  const actorFor = (req: Request): Promise<CloudActor | null> => options.cloud?.enabled ? options.cloud.authenticate(req) : Promise.resolve(null);
  const idFor = (req: Request) => z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.id);
  app.get('/api/reminders', async (req, res) => res.json(await service.snapshot(await actorFor(req))));
  app.patch('/api/reminders/preferences', async (req, res) => res.json(await service.preferences(await actorFor(req), req.body)));
  app.post('/api/reminders/claim', async (req, res) => res.json({ deliveries: await service.claim(await actorFor(req), req.body) }));
  app.post('/api/reminders/:id/ack', async (req, res) => { await service.acknowledge(await actorFor(req), idFor(req), req.body); res.sendStatus(204); });
  app.post('/api/reminders/:id/snooze', async (req, res) => { const { minutes } = z.object({ minutes: z.number().int().min(1).max(10080) }).strict().parse(req.body); await service.snooze(await actorFor(req), idFor(req), minutes); res.sendStatus(204); });
  app.post('/api/reminders/:id/dismiss', async (req, res) => { z.object({}).strict().parse(req.body ?? {}); await service.dismiss(await actorFor(req), idFor(req)); res.sendStatus(204); });
  return service;
}
