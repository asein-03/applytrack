import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeReminderDelivery, type NativeReminderNotification, type NativeReminderContent } from '../desktop/reminder-delivery.js';
import { ReminderService, REMINDER_LEASE_MS } from '../server/reminders.js';
import { Store } from '../server/store.js';
import type { CloudActor } from '../server/cloud.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const store = new Store(':memory:');
  let now = Date.parse('2026-11-10T16:00:00Z'), owner: string | null = 'local';
  const app = store.createApplication({ company: 'Private Company', role: 'Private Role' });
  const task = store.createTask(app.id, { title: 'Private assessment', dueAt: '2026-11-10T16:00:00Z' });
  const service = new ReminderService(store, { now: () => now });
  await service.preferences(null, { enabled: true, leadMinutes: 0, timeZone: 'UTC', dateOnlyTime: '09:00' });
  const created: FakeNotification[] = [], opened: Array<string | undefined> = [];
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  let behavior: 'show' | 'fail' | 'pending' = 'show';
  class FakeNotification extends EventEmitter implements NativeReminderNotification {
    closed = false; closeCount = 0;
    constructor(readonly content: NativeReminderContent) { super(); }
    show() { if (behavior === 'show') this.emit('show'); if (behavior === 'fail') this.emit('failed'); }
    close() { this.closed = true; this.closeCount++; this.emit('close'); }
  }
  const delivery = new NativeReminderDelivery({ reminders: service, now: () => now, currentOwner: () => owner,
    actor: async () => owner === 'local' ? null : { id: owner } as CloudActor,
    supported: () => true, create: content => { const value = new FakeNotification(content); created.push(value); return value; },
    open: id => { opened.push(id); }, maxNotifications: 2,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: timer => { timers.delete(timer as unknown as number); },
  });
  return { store, app, task, service, delivery, created, opened, timers,
    behavior: (value: typeof behavior) => { behavior = value; },
    owner: (value: string | null) => { owner = value; delivery.syncOwner(); },
    advance: (milliseconds: number) => { now += milliseconds; },
    close: () => { delivery.dispose(); store.close(); },
  };
}

test('native reminders recheck preferences, task activity and lease expiry after a claim', async () => {
  for (const change of ['disabled', 'completed', 'expired'] as const) {
    const f = await fixture();
    try {
      const claim = f.service.claim.bind(f.service);
      f.service.claim = async (actor, input) => {
        const deliveries = await claim(actor, input);
        if (change === 'disabled') await f.service.preferences(null, { enabled: false });
        if (change === 'completed') f.store.updateTask(f.task.id, { completedAt: new Date().toISOString() });
        if (change === 'expired') f.advance(REMINDER_LEASE_MS + 1);
        return deliveries;
      };
      await f.delivery.poll();
      assert.equal(f.created.length, 0, change);
      assert.equal((await f.service.snapshot(null)).items[0]?.deliveredAt ?? null, null);
    } finally { f.close(); }
  }
});

test('native delivery only acknowledges OS show and cancels immediately when preferences are disabled', async () => {
  const f = await fixture();
  try {
    f.behavior('pending'); const polling = f.delivery.poll(); await turn();
    assert.equal(f.created.length, 1); assert.equal((await f.service.snapshot(null)).items[0].deliveredAt, null);
    await f.service.preferences(null, { enabled: false }); await polling;
    assert.equal(f.created[0].closed, true);
    f.created[0].emit('show'); await turn();
    assert.equal((await f.service.snapshot(null)).items[0].deliveredAt, null);
    assert.equal(f.delivery.notificationError, null);
    await f.service.preferences(null, { enabled: true }); f.behavior('show'); await f.delivery.poll();
    assert.equal((await f.service.snapshot(null)).items[0].status, 'notified');
  } finally { f.close(); }
});

test('account changes cancel pending notifications and prevent old click and snooze callbacks', async () => {
  const f = await fixture();
  try {
    f.owner('alice'); f.behavior('pending'); const polling = f.delivery.poll(); await turn();
    const notification = f.created[0]; assert(notification);
    f.owner('bob'); await polling;
    assert.equal(notification.closed, true);
    notification.emit('show'); notification.emit('click'); notification.emit('action'); await turn();
    assert.deepEqual(f.opened, []);
    const item = (await f.service.snapshot(null)).items[0];
    assert.equal(item.deliveredAt, null); assert.equal(item.snoozedUntil, null);
  } finally { f.close(); }
});

test('account changes while asynchronous validation is pending prevent all OS display', async () => {
  const f = await fixture();
  try {
    f.owner('alice'); const gate = deferred<void>();
    const validate = f.service.validateDelivery.bind(f.service);
    f.service.validateDelivery = async (...args) => { await gate.promise; return validate(...args); };
    const polling = f.delivery.poll(); await turn(); f.owner('bob'); gate.resolve(); await polling;
    assert.equal(f.created.length, 0);
  } finally { f.close(); }
});

test('native notifications retain bounded cleanup references after Windows banner close events', async () => {
  const f = await fixture();
  try {
    f.owner('alice'); await f.delivery.testNotification();
    const first = f.created[0]; first.emit('close'); assert.equal(first.closed, false);
    await f.delivery.testNotification(); await f.delivery.testNotification();
    assert.equal(first.closed, true, 'the oldest retained notification is removed at the bound');
    const second = f.created[1]; second.emit('close'); f.owner('bob');
    assert.equal(second.closed, true); assert.equal(f.created[2].closed, true);
    second.emit('click'); assert.deepEqual(f.opened, []);
  } finally { f.close(); }
});

test('acknowledgment failures retry without showing another notification, including after lease expiry', async () => {
  for (const expired of [false, true]) {
    const f = await fixture();
    try {
      const acknowledge = f.service.acknowledge.bind(f.service); let attempts = 0;
      f.service.acknowledge = async (...args) => { attempts++; if (attempts === 1) throw new Error('Network unavailable'); return acknowledge(...args); };
      await f.delivery.poll(); assert.equal(f.created.length, 1); assert.equal((await f.service.snapshot(null)).items[0].deliveredAt, null);
      if (expired) f.advance(REMINDER_LEASE_MS + 1);
      await f.delivery.poll();
      assert.equal(f.created.length, 1, 'the shown delivery is not alerted again');
      assert.equal((await f.service.snapshot(null)).items[0].status, 'notified');
    } finally { f.close(); }
  }
});

test('OS failures and timeouts are never acknowledged and are retried after backoff', async () => {
  for (const behavior of ['fail', 'pending'] as const) {
    const f = await fixture();
    try {
      f.behavior(behavior); const polling = f.delivery.poll(); await turn();
      if (behavior === 'pending') for (const callback of [...f.timers.values()]) callback();
      await polling;
      assert.equal((await f.service.snapshot(null)).items[0].deliveredAt, null);
      assert.match(f.delivery.notificationError!, /could not be shown/);
      await f.delivery.poll(); assert.equal(f.created.length, 1);
      f.advance(60001); f.behavior('show'); await f.delivery.poll();
      assert.equal(f.created.length, 2); assert.equal((await f.service.snapshot(null)).items[0].status, 'notified');
      assert.equal(f.delivery.notificationError, null);
    } finally { f.close(); }
  }
});

test('snoozing a shown reminder delivers a fresh notification at the new time', async () => {
  const f = await fixture();
  try {
    await f.delivery.poll(); f.created[0].emit('action'); await turn();
    assert.equal((await f.service.snapshot(null)).items[0].status, 'snoozed'); assert.equal(f.created[0].closed, true);
    f.advance(3600001); await f.delivery.poll(); assert.equal(f.created.length, 2);
    assert.equal((await f.service.snapshot(null)).items[0].status, 'notified');
  } finally { f.close(); }
});

test('disposal cancels an outstanding OS operation and suppresses late callbacks', async () => {
  const f = await fixture();
  try {
    f.behavior('pending'); const polling = f.delivery.poll(); await turn();
    f.delivery.dispose(); await polling; f.created[0].emit('show'); f.created[0].emit('click');
    assert.equal(f.created[0].closed, true); assert.deepEqual(f.opened, []);
    assert.equal((await f.service.snapshot(null)).items[0].deliveredAt, null);
  } finally { f.close(); }
});

test('the OS receives only generic deadline text while clicking still opens the specific application', async () => {
  const f = await fixture();
  try {
    await f.delivery.poll();
    const notification = f.created[0];
    assert.equal(notification.content.title, 'Application deadline');
    assert.equal(notification.content.body, 'Open ApplyTrack to view your next task.');
    assert.equal(JSON.stringify(notification.content).includes('Private'), false);
    notification.emit('click');
    assert.deepEqual(f.opened, [f.app.id]);
  } finally { f.close(); }
});
