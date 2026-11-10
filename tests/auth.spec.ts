import { test, expect, type Page, type Route } from '@playwright/test';
import type { Application } from '../shared/types';

const authOrigin = 'https://apply-auth.test';
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'applicant@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: '2026-11-10T12:00:00Z' };
const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: user.id, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iss: `${authOrigin}/auth/v1` })).toString('base64url'), Buffer.from('test-signature').toString('base64url')].join('.');
const session = { access_token: token, refresh_token: 'test-refresh-token', expires_in: 3600, token_type: 'bearer', user };
const application: Application = { id: 'cloud-test', company: 'Cloud test', role: 'Designer', workspace: 'personal', stage: 'saved', location: '', workMode: '', salary: '', url: '', jobId: '', description: '', email: '', resumeName: '', coverLetterName: '', recruiterName: '', recruiterEmail: '', notes: '', priority: 'normal', appliedAt: null, createdAt: '2026-11-10T12:00:00Z', updatedAt: '2026-11-10T12:00:00Z', tasks: [], evidence: [], timeline: [] };

async function mockCloud(page: Page, options: { configured?: boolean; bind?: (route: Route, attempt: number) => Promise<void>; detach?: (route: Route) => Promise<void> } = {}) {
  const apiCalls: { path: string; method: string; authorization?: string; body?: unknown }[] = [];
  const authCalls: { path: string; method: string; body?: unknown }[] = [];
  let bindAttempt = 0;
  await page.route(`${authOrigin}/auth/v1/**`, async route => {
    const request = route.request(); const url = new URL(request.url());
    authCalls.push({ path: url.pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : undefined });
    if (url.pathname.endsWith('/token')) return route.fulfill({ json: session });
    if (url.pathname.endsWith('/user')) return route.fulfill({ json: user });
    if (url.pathname.endsWith('/signup')) return route.fulfill({ json: { user } });
    if (url.pathname.endsWith('/recover')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { msg: 'Unexpected authentication request.' } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    const path = url.pathname;
    apiCalls.push({ path, method: request.method(), authorization: request.headers().authorization, body: request.postData() ? request.postDataJSON() : undefined });
    if (path === '/api/cloud/config') return route.fulfill({ json: { enabled: true, configured: options.configured !== false, url: authOrigin, publishableKey: 'sb_publishable_ui_test_only' } });
    if (path === '/api/cloud/session') {
      if (request.method() === 'POST' && options.bind) return options.bind(route, ++bindAttempt);
      if (request.method() === 'DELETE' && options.detach) return options.detach(route);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/applications') return route.fulfill({ json: { applications: [application] } });
    if (path === '/api/settings') return route.fulfill({ json: { gmailConfigured: false, inboxes: [], extensionToken: 'test-pairing-token', session: null } });
    if (path === '/api/email/review') return route.fulfill({ json: { items: [] } });
    if (path === '/api/export') return route.fulfill({ contentType: 'text/csv', body: 'Company,Role\nCloud test,Designer\n' });
    return route.fulfill({ status: 404, json: { error: 'Unexpected account request.' } });
  });
  return { apiCalls, authCalls };
}

async function signIn(page: Page) {
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('test-password-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('the app waits for account binding, authenticates downloads, and clears context on sign-out', async ({ page }) => {
  let releaseBinding: (() => void) | undefined;
  let releaseSignOut: (() => void) | undefined;
  const held = new Promise<void>(resolve => { releaseBinding = resolve; });
  const heldSignOut = new Promise<void>(resolve => { releaseSignOut = resolve; });
  const { apiCalls, authCalls } = await mockCloud(page, { bind: async route => { await held; await route.fulfill({ status: 204 }); }, detach: async route => { await heldSignOut; await route.fulfill({ status: 204 }); } });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(apiCalls.filter(call => call.path === '/api/applications')).toHaveLength(0);
  await signIn(page);
  await expect(page.getByRole('status')).toHaveText('Opening your workspace…');
  await expect.poll(() => apiCalls.some(call => call.path === '/api/cloud/session')).toBe(true);
  expect(apiCalls.filter(call => call.path === '/api/applications')).toHaveLength(0);
  releaseBinding!();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  const binding = apiCalls.find(call => call.path === '/api/cloud/session' && call.method === 'POST');
  expect(binding?.authorization).toBe(`Bearer ${token}`);
  expect(binding?.body).toEqual({ accessToken: token, refreshToken: session.refresh_token });
  expect(apiCalls.find(call => call.path === '/api/applications')?.authorization).toBe(`Bearer ${token}`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('apply-applications-personal.csv');
  expect(await download.failure()).toBeNull();
  expect(apiCalls.find(call => call.path === '/api/export')?.authorization).toBe(`Bearer ${token}`);
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Signing out', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect(authCalls.some(call => call.path.endsWith('/logout'))).toBe(false);
  releaseSignOut!();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(apiCalls.find(call => call.path === '/api/cloud/session' && call.method === 'DELETE')?.authorization).toBe(`Bearer ${token}`);
  expect(authCalls.some(call => call.path.endsWith('/logout'))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('apply.workspace'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('apply.account'))).toBeNull();
  await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('sign-up confirmation and password reset stay outside the workspace until a session exists', async ({ page }) => {
  const { apiCalls, authCalls } = await mockCloud(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('test-password-only');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
  expect(authCalls.some(call => call.path.endsWith('/signup'))).toBe(true);
  await page.getByRole('button', { name: 'Back to sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
  await page.getByRole('button', { name: 'Send reset link', exact: true }).click();
  await expect(page.getByText('Follow the password reset link to choose a new password.')).toBeVisible();
  expect(authCalls.some(call => call.path.endsWith('/recover'))).toBe(true);
  expect(apiCalls.some(call => call.path === '/api/cloud/session' || call.path === '/api/applications')).toBe(false);
});

test('a failed device binding can be retried without loading account records early', async ({ page }) => {
  const { apiCalls } = await mockCloud(page, { bind: async (route, attempt) => { await route.fulfill(attempt === 1 ? { status: 503, json: { error: 'Account connection unavailable.' } } : { status: 204 }); } });
  await page.goto('/'); await signIn(page);
  await expect(page.getByRole('heading', { name: 'Could not open your workspace', exact: true })).toBeVisible();
  expect(apiCalls.some(call => call.path === '/api/applications')).toBe(false);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
});

test('recovery links require a new password before account data is loaded', async ({ page }) => {
  const { apiCalls, authCalls } = await mockCloud(page);
  const hash = new URLSearchParams({ access_token: token, refresh_token: session.refresh_token, expires_in: '3600', token_type: 'bearer', type: 'recovery' });
  await page.goto(`/#${hash}`);
  await expect(page.getByRole('heading', { name: 'Choose a new password', exact: true })).toBeVisible();
  expect(apiCalls.some(call => call.path === '/api/applications')).toBe(false);
  await page.getByLabel('New password', { exact: true }).fill('new-test-password');
  await page.getByLabel('Confirm new password', { exact: true }).fill('different-password');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('The passwords do not match.');
  await page.getByLabel('Confirm new password', { exact: true }).fill('new-test-password');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  expect(authCalls.some(call => call.path.endsWith('/user') && call.method === 'PUT')).toBe(true);
});

test('missing cloud configuration explains setup without falling back to local storage', async ({ page }) => {
  const { apiCalls } = await mockCloud(page, { configured: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cloud setup required', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore demo', exact: true })).toHaveCount(0);
  expect(apiCalls.some(call => call.path === '/api/applications')).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('sign-out uses the last token when the browser session has already disappeared', async ({ page }) => {
  const { apiCalls } = await mockCloud(page);
  await page.goto('/'); await signIn(page);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  await page.evaluate(async () => {
    const modulePath = '/src/cloud.ts';
    const { getCloudClient } = await import(modulePath);
    getCloudClient().auth.getSession = async () => ({ data: { session: null }, error: null });
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(apiCalls.find(call => call.path === '/api/cloud/session' && call.method === 'DELETE')?.authorization).toBe(`Bearer ${token}`);
  expect(await page.evaluate(() => localStorage.getItem('apply.workspace'))).toBeNull();
});

test('an expired browser session can sign out while an unclosed tracking connection stays explicit', async ({ page }) => {
  await mockCloud(page, { detach: route => route.fulfill({ status: 401, json: { error: 'Session expired.' } }) });
  await page.goto('/'); await signIn(page);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Connections', exact: true }).click();
  await page.evaluate(async () => {
    const modulePath = '/src/cloud.ts';
    const { getCloudClient } = await import(modulePath);
    getCloudClient().auth.getSession = async () => ({ data: { session: null }, error: null });
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Signed out of this browser. The tracking connection could not be closed. Sign in again to stop tracking.');
  await expect(page.getByRole('navigation')).toHaveCount(0);
});
