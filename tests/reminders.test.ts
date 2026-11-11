import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { ReminderService, REMINDER_LEASE_MS, zonedReminderTime } from '../server/reminders.js';
import { cloudFixture, post } from './cloud-fixtures.js';
import type { Application, Task } from '../shared/types.js';

const options = { enabled: true, leadMinutes: 60, timeZone: 'America/New_York', dateOnlyTime: '09:00' };
function localFixture(dueAt = '2026-11-10T17:00:00.000Z') {
  const store = new Store(':memory:');
  const application = store.createApplication({ company: 'Example', role: 'Designer' });
  const task = store.createTask(application.id, { title: 'Complete assessment', dueAt });
  let now = Date.parse('2026-11-10T16:00:00.000Z');
  return { store, application, task, service: new ReminderService(store, { now: () => now }), advance: (ms: number) => { now += ms; } };
}

test('calendar reminders use the saved time zone, including DST gaps, overlaps and day-before reminders', async () => {
  assert.equal(new Date(zonedReminderTime('2026-03-08', '02:30', 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(new Date(zonedReminderTime('2026-11-01', '01:30', 'America/New_York')).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(new Date(zonedReminderTime('2026-11-10', '09:00', 'Asia/Kathmandu')).toISOString(), '2026-11-10T03:15:00.000Z');
  const f = localFixture('2026-03-08');
  try {
    await f.service.preferences(null, { ...options, leadMinutes: 1440 });
    assert.equal((await f.service.snapshot(null)).items[0].scheduledAt, '2026-03-07T14:00:00.000Z');
    await f.service.preferences(null, { timeZone: 'America/Los_Angeles' });
    assert.equal((await f.service.snapshot(null)).items[0].scheduledAt, '2026-03-07T17:00:00.000Z');
  } finally { f.store.close(); }
});

test('notifications require explicit preferences and a valid time zone', async () => {
  const f = localFixture();
  try {
    assert.equal((await f.service.snapshot(null)).preferences.enabled, false);
    assert.equal((await f.service.claim(null, { clientId: 'device-one' })).length, 0);
    await assert.rejects(() => f.service.preferences(null, { enabled: true }), /Choose a time zone/);
    await assert.rejects(() => f.service.preferences(null, { timeZone: 'Mars/One' }));
    await assert.rejects(() => f.service.preferences(null, { dateOnlyTime: '29:00' }));
    await f.service.preferences(null, options);
    assert.equal((await f.service.claim(null, { clientId: 'device-one' })).length, 1);
  } finally { f.store.close(); }
});

test('delivery leases prevent concurrent notifications, survive restart and expire without false acknowledgments', async () => {
  const f = await cloudFixture(); let now = Date.parse('2026-11-10T16:00:00.000Z');
  try {
    const actor = f.cloud.actors.get('alice')!;
    const service = new ReminderService(f.store, { repository: f.repository, now: () => now });
    await f.repository.run('personal', actor, true, store => { const app = store.createApplication({ company: 'Example', role: 'Designer' }); store.createTask(app.id, { title: 'Interview', dueAt: '2026-11-10T17:00:00.000Z' }); });
    await service.preferences(actor, options);
    const batches = await Promise.all([service.claim(actor, { clientId: 'browser-one' }), service.claim(actor, { clientId: 'desktop-two' })]);
    assert.equal(batches.flat().length, 1);
    const first = batches.flat()[0];
    assert.equal((await new ReminderService(f.store, { repository: f.repository, now: () => now }).claim(actor, { clientId: 'restart-one' })).length, 0);
    assert.equal((await service.snapshot(actor)).items[0].deliveredAt, null);
    now += REMINDER_LEASE_MS + 1;
    const [second] = await service.claim(actor, { clientId: 'restart-one' });
    assert.notEqual(second.leaseId, first.leaseId);
    await assert.rejects(() => service.acknowledge(actor, first.id, { clientId: 'browser-one', leaseId: first.leaseId }), /expired or changed/);
    await service.acknowledge(actor, second.id, { clientId: 'restart-one', leaseId: second.leaseId });
    await service.acknowledge(actor, second.id, { clientId: 'restart-one', leaseId: second.leaseId });
    assert.equal((await service.claim(actor, { clientId: 'desktop-two' })).length, 0);
    assert.equal((await service.snapshot(actor)).items[0].status, 'notified');
    assert.deepEqual(f.store.listMeta('reminder:'), []);
  } finally { await f.close(); }
});

test('snoozing produces a new delivery only when its time arrives, and invalidates stale delivery acknowledgments', async () => {
  const f = localFixture();
  try {
    await f.service.preferences(null, options);
    const [first] = await f.service.claim(null, { clientId: 'device-one' });
    await f.service.snooze(null, first.id, 60);
    await assert.rejects(() => f.service.acknowledge(null, first.id, { clientId: 'device-one', leaseId: first.leaseId }), /expired or changed/);
    assert.equal((await f.service.snapshot(null)).items[0].status, 'snoozed');
    f.advance(59 * 60_000); assert.equal((await f.service.claim(null, { clientId: 'device-one' })).length, 0);
    f.advance(60_000); const [second] = await f.service.claim(null, { clientId: 'device-one' });
    await f.service.acknowledge(null, second.id, { clientId: 'device-one', leaseId: second.leaseId });
    await f.service.snooze(null, first.id, 15);
    f.advance(15 * 60_000); assert.equal((await f.service.claim(null, { clientId: 'device-one' })).length, 1);
  } finally { f.store.close(); }
});

test('completed, deleted and dismissed tasks cannot deliver; a changed deadline creates a new reminder', async () => {
  const f = localFixture();
  try {
    await f.service.preferences(null, options);
    const original = (await f.service.snapshot(null)).items[0];
    await f.service.dismiss(null, original.id);
    assert.equal((await f.service.snapshot(null)).items.length, 0);
    f.store.updateTask(f.task.id, { dueAt: '2026-11-10T16:30:00.000Z' });
    const changed = (await f.service.snapshot(null)).items[0]; assert.notEqual(changed.id, original.id);
    const [delivery] = await f.service.claim(null, { clientId: 'device-one' });
    f.store.updateTask(f.task.id, { completedAt: '2026-11-10T16:05:00.000Z' });
    await assert.rejects(() => f.service.acknowledge(null, delivery.id, { clientId: 'device-one', leaseId: delivery.leaseId }), /no longer active/);
    assert.equal((await f.service.claim(null, { clientId: 'device-one' })).length, 0);
    f.store.updateTask(f.task.id, { completedAt: null });
    f.store.deleteApplication(f.application.id);
    assert.equal((await f.service.snapshot(null)).items.length, 0);
  } finally { f.store.close(); }
});

test('reminder API keeps preferences, snoozes and delivery claims private to the authenticated account', async () => {
  const f = await cloudFixture();
  try {
    assert.equal((await f.api('/reminders', {}, null)).status, 401);
    const application = await (await f.api('/applications', post({ company: 'Private', role: 'Analyst' }))).json() as Application;
    const task = await (await f.api(`/applications/${application.id}/tasks`, post({ title: 'Assessment', dueAt: new Date(Date.now() - 60_000).toISOString() }))).json() as Task;
    assert.equal((await f.api('/reminders/preferences', { method: 'PATCH', body: JSON.stringify(options) })).status, 200);
    assert.equal((await (await f.api('/reminders', {}, 'bob')).json()).items.length, 0);
    assert.equal((await (await f.api('/reminders', {}, 'bob')).json()).preferences.enabled, false);
    const { deliveries } = await (await f.api('/reminders/claim', post({ clientId: 'browser-one' }))).json();
    assert.equal(deliveries[0].taskId, task.id);
    assert.equal((await f.api(`/reminders/${deliveries[0].id}/snooze`, post({ minutes: 15 }), 'bob')).status, 404);
    assert.equal((await f.api(`/reminders/${deliveries[0].id}/ack`, post({ clientId: 'browser-one', leaseId: deliveries[0].leaseId }), 'bob')).status, 404);
    assert.equal((await f.api(`/reminders/${deliveries[0].id}/snooze`, post({ minutes: 15 }))).status, 204);
    assert.equal((await f.api('/reminders/preferences', { method: 'PATCH', body: JSON.stringify({ timeZone: 'Not/AZone' }) })).status, 422);
    assert.deepEqual(f.store.listMeta('reminder:'), []);
  } finally { await f.close(); }
});


test('changing reminder preferences revokes outstanding delivery leases', async () => {
  const f = localFixture();
  try {
    await f.service.preferences(null, options);
    const [delivery] = await f.service.claim(null, { clientId: 'device-one' });
    await f.service.preferences(null, { enabled: false });
    await assert.rejects(() => f.service.acknowledge(null, delivery.id, { clientId: 'device-one', leaseId: delivery.leaseId }), /disabled/);
    assert.equal((await f.service.claim(null, { clientId: 'device-one' })).length, 0);
    await f.service.preferences(null, { enabled: true });
    const [fresh] = await f.service.claim(null, { clientId: 'device-one' });
    assert.notEqual(fresh.leaseId, delivery.leaseId);
    await f.service.preferences(null, { leadMinutes: 15 });
    await assert.rejects(() => f.service.acknowledge(null, fresh.id, { clientId: 'device-one', leaseId: fresh.leaseId }), /expired or changed/);
  } finally { f.store.close(); }
});

test('delivery validation requires the current account, client, lease and active deadline', async () => {
  const f = await cloudFixture();
  try {
    const alice = f.cloud.actors.get('alice')!, bob = f.cloud.actors.get('bob')!;
    const service = new ReminderService(f.store, { repository: f.repository, now: () => Date.parse('2026-11-10T16:00:00Z') });
    await f.repository.run('personal', alice, true, store => {
      const app = store.createApplication({ company: 'Private', role: 'Designer' });
      store.createTask(app.id, { title: 'Assessment', dueAt: '2026-11-10T17:00:00Z' });
    });
    await service.preferences(alice, options);
    const [delivery] = await service.claim(alice, { clientId: 'desktop-owner' });
    const lease = { clientId: 'desktop-owner', leaseId: delivery.leaseId };
    assert.equal((await service.validateDelivery(alice, delivery.id, lease))?.id, delivery.id);
    assert.equal(await service.validateDelivery(bob, delivery.id, lease), null);
    assert.equal(await service.validateDelivery(alice, delivery.id, { ...lease, clientId: 'other-client' }), null);
    await service.snooze(alice, delivery.id, 60);
    assert.equal(await service.validateDelivery(alice, delivery.id, lease), null);
  } finally { await f.close(); }
});
