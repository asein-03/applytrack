import { test, expect, type Page } from '@playwright/test';
import type { GmailStatus, Inbox } from '../shared/types';

const authorizationUrl = `https://asein-03.github.io/applytrack/auth/?state=${'s'.repeat(43)}`;
const inbox = (extra: Partial<Inbox> = {}): Inbox => ({ id: 'synthetic-inbox', provider: 'gmail', email: 'applicant@example.invalid', status: 'connected', lastSyncAt: null, error: null, connectedAt: '2026-11-10T12:00:00Z', syncing: false, ...extra });
async function setup(page: Page, inboxes: Inbox[] = [], blocked = false) {
  const state: GmailStatus = { gmailConfigured: true, gmailSyncMode: 'cloud', inboxes }, calls: Array<{ path: string; method: string; body: unknown }> = [];
  await page.clock.install();
  await page.addInitScript(blocked => {
    const state = window as any; state.oauthTargets = []; state.oauthWindows = [];
    window.open = ((url?: string) => {
      state.oauthTargets.push(String(url)); if (blocked) return null;
      const popup = { closed: false, opener: null, close() { this.closed = true; }, location: { set href(value: string) { state.oauthTargets.push(value); } } };
      state.oauthWindows.push(popup); return popup;
    }) as typeof window.open;
  }, blocked);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const body = route.request().postData() ? route.request().postDataJSON() : null; calls.push({ path, method, body });
    if (path === '/api/cloud/config') return route.fulfill({ json: { enabled: false, configured: false } });
    if (path === '/api/inboxes/google/connect') return route.fulfill({ json: { url: authorizationUrl } });
    if (path.endsWith('/sync')) { state.inboxes = state.inboxes.map(value => ({ ...value, syncing: true })); return route.fulfill({ json: { syncing: true } }); }
    if (path === '/api/inboxes/synthetic-inbox' && method === 'DELETE') { state.inboxes = []; return route.fulfill({ json: { disconnected: true } }); }
    if (path === '/api/inboxes') return route.fulfill({ json: state });
    if (path === '/api/email/review') return route.fulfill({ json: { items: [] } });
    return route.fulfill({ status: 404, json: { error: 'Synthetic endpoint unavailable' } });
  });
  await page.goto('/tests/fixtures/gmail.html');
  await expect.poll(() => calls.filter(call => call.path === '/api/inboxes').length).toBeGreaterThan(0);
  return { state, calls };
}

test('Gmail opens a trusted sign-in page in a separate browser flow and connection status completes without a local callback', async ({ page }) => {
  const { state } = await setup(page);
  await expect(page.getByText(/Inbox checks continue in the cloud when this app is closed/)).toBeVisible();
  await expect(page.getByText(/cannot send, edit or delete your Gmail messages/)).toBeVisible();
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await expect(page.getByText('Finish connecting in your browser')).toBeVisible();
  await expect(page.getByText(/Sign in to ApplyTrack in your browser, then choose your Gmail account/)).toBeVisible();
  expect(page.url()).toContain('/tests/fixtures/gmail.html');
  expect(await page.evaluate(() => (window as any).oauthTargets)).toContain(authorizationUrl);
  await expect(page.getByText('Gmail connected. Application updates will appear here.')).toHaveCount(0);
  state.inboxes = [inbox()]; await page.clock.fastForward(3100);
  await expect(page.getByText('Gmail connected. Application updates will appear here.')).toBeVisible();
  await expect(page.getByText('applicant@example.invalid', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).gmailRefreshes)).toBe(1);
});

test('revoked Gmail access has an explicit reconnect flow for the same inbox', async ({ page }) => {
  const { state, calls } = await setup(page, [inbox({ status: 'reconnect_required', error: 'Gmail access expired. Reconnect this inbox.' })]);
  await page.getByRole('button', { name: 'Reconnect applicant@example.invalid' }).click();
  await expect(page.getByText('Finish connecting in your browser')).toBeVisible();
  expect(calls.find(call => call.path.endsWith('/connect'))?.body).toEqual({ inboxId: 'synthetic-inbox' });
  state.inboxes = [inbox({ connectedAt: '2026-11-10T14:00:00Z' })]; await page.clock.fastForward(3100);
  await expect(page.getByText('Gmail connected. Application updates will appear here.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect applicant@example.invalid' })).toHaveCount(0);
});

test('asynchronous inbox checks poll until completion and disconnect removes the account', async ({ page }) => {
  const { state } = await setup(page, [inbox()]);
  await page.getByRole('button', { name: 'Sync applicant@example.invalid' }).click();
  await expect(page.getByText('Inbox check started. You can keep using ApplyTrack.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync applicant@example.invalid' })).toBeDisabled();
  state.inboxes = [inbox({ lastSyncAt: '2026-11-10T15:00:00Z' })]; await page.clock.fastForward(3100);
  await expect(page.getByText('Inbox check complete.')).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect applicant@example.invalid' }).click();
  await expect(page.getByText('Gmail disconnected.')).toBeVisible();
  await expect(page.getByText('No inbox connected')).toBeVisible();
});

test('blocked popups remain recoverable and cancelling stops rapid connection polling', async ({ page }) => {
  const { calls } = await setup(page, [], true);
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Continue in browser' })).toHaveAttribute('href', authorizationUrl);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const checks = calls.filter(call => call.path === '/api/inboxes').length;
  await page.clock.fastForward(10000);
  expect(calls.filter(call => call.path === '/api/inboxes').length).toBe(checks);
  await expect(page.getByText('Finish connecting in your browser')).toHaveCount(0);
});

test('switching workspace or signing out cancels pending Gmail state and polling', async ({ page }) => {
  const { state, calls } = await setup(page);
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await expect(page.getByText('Finish connecting in your browser')).toBeVisible();
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await expect(page.getByText('Finish connecting in your browser')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).oauthWindows[0].closed)).toBe(true);
  state.inboxes = [inbox()]; const checks = calls.filter(call => call.path === '/api/inboxes').length;
  await page.clock.fastForward(35000); expect(calls.filter(call => call.path === '/api/inboxes').length).toBe(checks);
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const signedOutChecks = calls.filter(call => call.path === '/api/inboxes').length;
  await page.clock.fastForward(35000); expect(calls.filter(call => call.path === '/api/inboxes').length).toBe(signedOutChecks);
  await expect(page.getByText('Gmail connected. Application updates will appear here.')).toHaveCount(0);
});

test('a delayed connection response cannot reopen Google after the workspace changes', async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/inboxes/google/connect', async route => { await gate; await route.fulfill({ json: { url: authorizationUrl } }).catch(() => {}); });
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  release(); await page.clock.fastForward(5000);
  expect(await page.evaluate(() => (window as any).oauthTargets)).not.toContain(authorizationUrl);
  await expect(page.getByText('Finish connecting in your browser')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect Gmail', exact: true })).toBeDisabled();
});

test('desktop opens the hosted approval URL directly and pending controls fit a narrow screen', async ({ page }, testInfo) => {
  await page.addInitScript(() => { (window as any).applyDesktop = {}; });
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await expect(page.getByText('Finish connecting in your browser')).toBeVisible();
  expect(await page.evaluate(() => (window as any).oauthTargets)).toEqual([authorizationUrl]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('gmail-pending-mobile.png'), fullPage: true });
});

test('disconnect reports pending Google revocation without claiming it is already complete', async ({ page }) => {
  const { state } = await setup(page, [inbox()]);
  await page.route('**/api/inboxes/synthetic-inbox', async route => { state.inboxes = []; await route.fulfill({ json: { disconnected: true, revocationPending: true } }); });
  await page.getByRole('button', { name: 'Disconnect applicant@example.invalid' }).click();
  await expect(page.getByText('Gmail disconnected. Google access removal is still being retried.')).toBeVisible();
  await expect(page.getByText('No inbox connected')).toBeVisible();
});
