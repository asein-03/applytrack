import { randomUUID } from 'node:crypto';
import type { CloudActor } from '../server/cloud.js';
import type { ReminderService } from '../server/reminders.js';
import { PRIVATE_REMINDER_NOTIFICATION, type ReminderDelivery, type ReminderItem, type ReminderSnapshot } from '../shared/reminders.js';

export interface NativeReminderNotification {
  on(event: 'click' | 'action' | 'show' | 'failed' | 'close', listener: () => void): unknown;
  show(): void;
  close(): void;
}
export interface NativeReminderContent { id: string; title: string; body: string; reminder: boolean; }
interface DeliveryOptions {
  reminders: Pick<ReminderService, 'snapshot' | 'claim' | 'validateDelivery' | 'acknowledge' | 'snooze' | 'onPreferencesChanged'>;
  currentOwner(): string | null;
  actor(): Promise<CloudActor | null>;
  supported(): boolean;
  create(content: NativeReminderContent): NativeReminderNotification;
  open(applicationId?: string): void;
  now?: () => number;
  setTimeout?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  maxNotifications?: number;
}
interface RetainedNotification { notification: NativeReminderNotification; owner: string; item?: ReminderDelivery; cancel(): void; }
const occurrence = (item: Pick<ReminderItem, 'id' | 'snoozedUntil' | 'scheduledAt'>) => `${item.id}:${item.snoozedUntil ?? item.scheduledAt}`;

export class NativeReminderDelivery {
  private readonly clientId = `desktop:${randomUUID()}`;
  private owner: string | null = null;
  private epoch = 0;
  private disposed = false;
  private polling = false;
  private retryAt = 0;
  private error: string | null = null;
  private readonly notifications = new Set<RetainedNotification>();
  private readonly shown = new Map<string, ReminderDelivery>();
  private readonly unsubscribe: () => void;
  constructor(private options: DeliveryOptions) {
    this.owner = options.currentOwner();
    this.unsubscribe = options.reminders.onPreferencesChanged(change => {
      if ((change.userId ?? 'local') !== this.options.currentOwner()) return;
      this.epoch++; this.retryAt = 0;
      this.closeNotifications();
      if (!change.preferences.enabled) this.shown.clear();
    });
  }
  get notificationError() { return this.error; }
  private now() { return (this.options.now ?? Date.now)(); }
  private current(owner: string, epoch: number) { return !this.disposed && this.options.currentOwner() === owner && this.epoch === epoch; }
  private remove(entry: RetainedNotification) {
    this.notifications.delete(entry); entry.cancel();
    try { entry.notification.close(); } catch { /* A removed OS notification may already be unavailable. */ }
  }
  private closeNotifications() { for (const entry of [...this.notifications]) this.remove(entry); }
  syncOwner() {
    const next = this.options.currentOwner();
    if (next === this.owner) return;
    this.owner = next; this.epoch++; this.retryAt = 0; this.error = null;
    this.closeNotifications(); this.shown.clear();
  }
  private reconcile(snapshot: ReminderSnapshot) {
    const active = new Map(snapshot.items.map(item => [item.id, item]));
    for (const entry of [...this.notifications]) if (entry.item) {
      const item = active.get(entry.item.id);
      if (!snapshot.preferences.enabled || !item || (!item.deliveredAt && occurrence(item) !== occurrence(entry.item))) this.remove(entry);
    }
    for (const [key, delivery] of this.shown) {
      const item = active.get(delivery.id);
      if (!snapshot.preferences.enabled || !item || item.deliveredAt || occurrence(item) !== key) this.shown.delete(key);
    }
  }
  private async acknowledge(actor: CloudActor | null, item: ReminderDelivery, owner: string, epoch: number) {
    if (!this.current(owner, epoch)) return;
    try {
      await this.options.reminders.acknowledge(actor, item.id, { clientId: this.clientId, leaseId: item.leaseId });
      if (this.current(owner, epoch)) this.shown.delete(occurrence(item));
    } catch { /* Keep the shown receipt and retry without alerting again. */ }
  }
  async poll() {
    this.syncOwner();
    const owner = this.owner, epoch = this.epoch;
    if (this.disposed || this.polling || !owner) return;
    this.polling = true;
    try {
      const actor = await this.options.actor();
      if (!this.current(owner, epoch) || (actor && actor.id !== owner)) return;
      const snapshot = await this.options.reminders.snapshot(actor);
      if (!this.current(owner, epoch)) return;
      this.reconcile(snapshot);
      if (!snapshot.preferences.enabled) return;
      for (const shown of this.shown.values()) {
        if (!this.current(owner, epoch)) return;
        if (Date.parse(shown.leaseExpiresAt) > this.now()) await this.acknowledge(actor, shown, owner, epoch);
      }
      if (!this.current(owner, epoch) || this.now() < this.retryAt) return;
      const deliveries = await this.options.reminders.claim(actor, { clientId: this.clientId, limit: 3 });
      for (const delivery of deliveries) {
        if (!this.current(owner, epoch)) return;
        const item = await this.options.reminders.validateDelivery(actor, delivery.id, { clientId: this.clientId, leaseId: delivery.leaseId });
        if (!this.current(owner, epoch)) return;
        if (!item || Date.parse(item.leaseExpiresAt) <= this.now()) continue;
        const key = occurrence(item);
        if (this.shown.has(key)) {
          this.shown.set(key, item);
          await this.acknowledge(actor, item, owner, epoch);
          continue;
        }
        if (this.shown.size >= 128) continue;
        const result = await this.show(item, owner, epoch);
        if (!this.current(owner, epoch)) return;
        if (result === 'shown') {
          this.shown.set(key, item);
          await this.acknowledge(actor, item, owner, epoch);
        } else if (result === 'failed') { this.retryAt = this.now() + 60_000; return; }
      }
    } catch { /* Network failures leave eligible reminders available for a later poll. */ }
    finally { this.polling = false; }
  }
  private async snooze(entry: RetainedNotification, epoch: number) {
    if (!entry.item || !this.current(entry.owner, epoch)) return;
    try {
      const actor = await this.options.actor();
      if (!this.current(entry.owner, epoch) || (actor && actor.id !== entry.owner)) return;
      await this.options.reminders.snooze(actor, entry.item.id, 60);
      if (!this.current(entry.owner, epoch)) return;
      this.shown.delete(occurrence(entry.item)); this.remove(entry);
    } catch { if (this.current(entry.owner, epoch)) this.error = 'The reminder could not be snoozed. Open Tasks and try again.'; }
  }
  private show(item: ReminderDelivery | undefined, owner: string, epoch: number): Promise<'shown' | 'failed' | 'cancelled'> {
    if (!this.current(owner, epoch)) return Promise.resolve('cancelled');
    if (!this.options.supported()) { this.error = 'Desktop notifications are not supported on this computer.'; return Promise.resolve('failed'); }
    let notification: NativeReminderNotification;
    try { notification = this.options.create({ id: item?.id ?? `test-${randomUUID()}`, ...(item ? PRIVATE_REMINDER_NOTIFICATION : { title: 'ApplyTrack reminders', body: 'Deadline notifications are working on this computer.' }), reminder: !!item }); }
    catch { this.error = 'Notifications could not be shown. Check ApplyTrack in system notification settings.'; return Promise.resolve('failed'); }
    while (this.notifications.size >= (this.options.maxNotifications ?? 64)) this.remove(this.notifications.values().next().value!);
    return new Promise(resolve => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const entry: RetainedNotification = { notification, owner, item, cancel: () => finish('cancelled') };
      const finish = (result: 'shown' | 'failed' | 'cancelled') => {
        if (settled) return; settled = true;
        if (timeout) (this.options.clearTimeout ?? clearTimeout)(timeout);
        if (result === 'shown') this.error = null;
        if (result === 'failed') { this.error = 'Notifications could not be shown. Check ApplyTrack in system notification settings.'; this.remove(entry); }
        resolve(result);
      };
      this.notifications.add(entry);
      notification.on('click', () => { if (this.notifications.has(entry) && this.current(owner, epoch)) this.options.open(item?.applicationId); });
      notification.on('action', () => { if (this.notifications.has(entry)) void this.snooze(entry, epoch); });
      notification.on('show', () => { if (this.notifications.has(entry) && this.current(owner, epoch)) finish('shown'); else this.remove(entry); });
      notification.on('failed', () => finish('failed'));
      // A Windows banner timeout emits close while the item stays in Action Center.
      // Keep a bounded reference so sign-out can still remove it from the OS.
      timeout = (this.options.setTimeout ?? setTimeout)(() => finish('failed'), 8000);
      try { notification.show(); } catch { finish('failed'); }
    });
  }
  async testNotification(): Promise<{ shown: boolean; error?: string }> {
    this.syncOwner(); this.retryAt = 0;
    const owner = this.owner;
    if (!owner || this.disposed) return { shown: false, error: 'Sign in to test desktop notifications.' };
    const result = await this.show(undefined, owner, this.epoch);
    return { shown: result === 'shown', ...(result === 'failed' ? { error: this.error ?? undefined } : {}) };
  }
  dispose() { this.disposed = true; this.epoch++; this.unsubscribe(); this.closeNotifications(); this.shown.clear(); }
}
