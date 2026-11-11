import { test, expect, type Page } from '@playwright/test';
import type { ReminderSnapshot } from '../shared/reminders';

const item = { id: 'a'.repeat(64), applicationId: 'app-one', taskId: 'task-one', title: 'Complete assessment', company: 'Example Labs', role: 'Product Designer', dueAt: '2026-11-11T17:00:00.000Z', scheduledAt: '2026-11-10T17:00:00.000Z', snoozedUntil: null, deliveredAt: null, status: 'due' as const };
const snapshot = (): ReminderSnapshot => ({ preferences: { enabled: false, leadMinutes: 1440, timeZone: 'America/New_York', dateOnlyTime: '09:00' }, items: [structuredClone(item)], serverTime: '2026-11-10T18:00:00.000Z' });
async function mockNotifications(page: Page, permission: 'default' | 'granted' | 'denied' = 'granted') {
  await page.addInitScript(permission => {
    const state = window as unknown as { notificationRequests: number; notifications: FakeNotification[] };
    state.notificationRequests = 0; state.notifications = [];
    class FakeNotification {
      static permission = permission;
      static async requestPermission() { state.notificationRequests++; return this.permission === 'denied' ? 'denied' : this.permission = 'granted'; }
      closed = false;
      onshow: (() => void) | null = null; onerror: (() => void) | null = null; onclick: (() => void) | null = null; onclose: (() => void) | null = null;
      constructor(public title: string, public options: NotificationOptions) { state.notifications.push(this); }
      close() { this.closed = true; this.onclose?.(); }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
  }, permission);
}
async function mockApi(page: Page, state: ReminderSnapshot, events: Array<{ path: string; body: any }>, delivery = false) {
  let claimed = false;
  await page.route('**/api/reminders**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === 'GET' ? null : route.request().postDataJSON();
    if (body) events.push({ path, body });
    if (path === '/api/reminders/preferences') { state.preferences = { ...state.preferences, ...body }; await route.fulfill({ json: state.preferences }); }
    else if (path === '/api/reminders/claim') {
      const deliveries = delivery && !claimed && state.preferences.enabled ? [{ ...state.items[0], leaseId: '11111111-1111-4111-8111-111111111111', leaseExpiresAt: '2026-11-10T18:00:30.000Z' }] : [];
      claimed = true; await route.fulfill({ json: { deliveries } });
    } else if (path.endsWith('/ack')) { state.items[0] = { ...state.items[0], deliveredAt: '2026-11-10T18:00:00.000Z', status: 'notified' }; await route.fulfill({ status: 204 }); }
    else if (path.endsWith('/snooze')) { state.items[0] = { ...state.items[0], status: 'snoozed', snoozedUntil: '2026-11-10T19:00:00.000Z' }; await route.fulfill({ status: 204 }); }
    else if (path.endsWith('/dismiss')) { state.items = []; await route.fulfill({ status: 204 }); }
    else await route.fulfill({ json: state });
  });
}

test('notification opt-in saves the chosen schedule and does not prompt on page load', async ({ page }) => {
  const state = snapshot(), events: Array<{ path: string; body: any }> = [];
  await mockNotifications(page, 'default'); await mockApi(page, state, events);
  await page.goto('/tests/fixtures/reminders.html');
  await expect(page.getByRole('heading', { name: 'Deadline reminders', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).notificationRequests)).toBe(0);
  await page.getByRole('combobox', { name: 'Remind me', exact: true }).selectOption('60');
  await page.getByRole('combobox', { name: 'Time zone', exact: true }).fill('Europe/London');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled', { exact: true })).toBeVisible();
  expect(events.find(e => e.path.endsWith('/preferences'))?.body).toEqual({ enabled: true, leadMinutes: 60, timeZone: 'Europe/London', dateOnlyTime: '09:00' });
  expect(await page.evaluate(() => (window as any).notificationRequests)).toBe(1);
  await expect(page.getByText('Keep ApplyTrack open in this browser to receive notifications.')).toBeVisible();
});

test('browser delivery acknowledges only after the operating system shows the notification', async ({ page }) => {
  const state = snapshot(), events: Array<{ path: string; body: any }> = []; state.preferences.enabled = true;
  await mockNotifications(page); await mockApi(page, state, events, true);
  await page.goto('/tests/fixtures/reminders.html');
  await expect.poll(() => page.evaluate(() => (window as any).notifications.length)).toBe(1);
  expect(events.some(e => e.path.endsWith('/ack'))).toBe(false);
  await page.evaluate(() => (window as any).notifications[0].onshow());
  await expect.poll(() => events.some(e => e.path.endsWith('/ack'))).toBe(true);
  await expect(page.getByText('Notified', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).notifications[0].onclick());
  expect(await page.evaluate(() => (window as any).reminderOpened)).toBe('app-one');
});

test('failed notifications are not acknowledged, while snooze and dismiss remain available', async ({ page }) => {
  const state = snapshot(), events: Array<{ path: string; body: any }> = []; state.preferences.enabled = true;
  await mockNotifications(page); await mockApi(page, state, events, true);
  await page.goto('/tests/fixtures/reminders.html');
  await expect.poll(() => page.evaluate(() => (window as any).notifications.length)).toBe(1);
  await page.evaluate(() => (window as any).notifications[0].onerror());
  await expect(page.getByRole('alert')).toContainText('A notification could not be shown');
  expect(events.some(e => e.path.endsWith('/ack'))).toBe(false);
  await page.getByRole('combobox', { name: 'Snooze Complete assessment', exact: true }).selectOption('60');
  await expect(page.getByText(/Until Nov 10/)).toBeVisible();
  expect(events.find(e => e.path.endsWith('/snooze'))?.body).toEqual({ minutes: 60 });
  await page.getByRole('button', { name: 'Dismiss reminder for Complete assessment', exact: true }).click();
  await expect(page.getByText('No reminders', { exact: true })).toBeVisible();
});

test('desktop delivery and demo mode do not request browser notifications', async ({ page }) => {
  const state = snapshot(), events: Array<{ path: string; body: any }> = []; state.preferences.enabled = true;
  await mockNotifications(page); await mockApi(page, state, events, true);
  await page.goto('/tests/fixtures/reminders.html?desktop');
  await expect(page.getByText('Notifications enabled', { exact: true })).toBeVisible();
  expect(events.some(e => e.path.endsWith('/claim'))).toBe(false);
  expect(await page.evaluate(() => (window as any).notifications.length)).toBe(0);
  await page.goto('/tests/fixtures/reminders.html?demo');
  await expect(page.getByRole('button', { name: 'Enable notifications', exact: true })).toBeDisabled();
  await expect(page.getByText('Switch to your personal workspace to set up reminders.')).toBeVisible();
});

test('reminders remain readable and operable on a narrow screen', async ({ page }, testInfo) => {
  const state = snapshot(), events: Array<{ path: string; body: any }> = [];
  state.items[0].title = 'Complete the product strategy and analytical reasoning assessment';
  state.items[0].role = 'Senior Product Designer, Enterprise Platform and Infrastructure';
  await mockNotifications(page); await mockApi(page, state, events);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tests/fixtures/reminders.html');
  await expect(page.getByRole('button', { name: 'Enable notifications', exact: true })).toBeVisible();
  await page.getByRole('button', { name: new RegExp('^' + state.items[0].title) }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Save reminder settings', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.screenshot({ path: testInfo.outputPath('reminders-mobile.png'), fullPage: true });
});


test('denied notification permission does not enable server delivery', async ({ page }) => {
  const state = snapshot(), events: Array<{ path: string; body: any }> = [];
  await mockNotifications(page, 'denied'); await mockApi(page, state, events);
  await page.goto('/tests/fixtures/reminders.html');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Notifications are blocked');
  expect(events.some(e => e.path.endsWith('/preferences'))).toBe(false);
  expect(events.some(e => e.path.endsWith('/claim'))).toBe(false);
});


test('turning notifications off cancels an unshown delivery without acknowledging it', async ({ page }) => {
  const state = snapshot(), events: Array<{ path: string; body: any }> = []; state.preferences.enabled = true;
  await mockNotifications(page); await mockApi(page, state, events, true);
  await page.goto('/tests/fixtures/reminders.html');
  await expect.poll(() => page.evaluate(() => (window as any).notifications.length)).toBe(1);
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Notifications off', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).notifications[0].closed)).toBe(true);
  await page.evaluate(() => (window as any).notifications[0].onshow());
  expect(events.some(e => e.path.endsWith('/ack'))).toBe(false);
});
