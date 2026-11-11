import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const origin = 'https://asein-03.github.io';
const pageUrl = `${origin}/applytrack/auth/`;
const callback = 'https://fbnmvajnvylkaegtkvsj.supabase.co/functions/v1/gmail';
const state = 'a'.repeat(43);
async function serve(page: Page) {
  await page.route(`${pageUrl}**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const name = path.endsWith('/connect.js') ? 'connect.js' : path.endsWith('/style.css') ? 'style.css' : 'index.html';
    await route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(resolve('auth', name), 'utf8') });
  });
}

test('Gmail browser approval redirects to Google without forwarding credentials and stores a private callback cookie', async ({ page }) => {
  const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`;
  const requests: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  const unexpected: string[] = [];
  const interceptionErrors: string[] = [];
  const cspErrors: string[] = [];
  page.on('console', message => { if (/content security policy/i.test(message.text())) cspErrors.push(message.text()); });
  // CDP intercepts each redirect hop. Playwright route handlers only intercept
  // the initial request in this chain. Offline mode also prevents real traffic.
  await page.context().setOffline(true);
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    try {
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
      requests.push({ url: request.url, method: request.method, body: request.postData, headers });
      let responseCode = 200;
      let responseHeaders: Array<{ name: string; value: string }> = [];
      let body = '';
      if (request.url === callback) {
        responseCode = 303;
        responseHeaders = [
          { name: 'Location', value: googleUrl },
          { name: 'Set-Cookie', value: '__Host-apply-gmail-test=synthetic-nonce; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600' },
        ];
      } else if (request.url === googleUrl) {
        responseHeaders = [{ name: 'Content-Type', value: 'text/plain' }];
        body = 'Synthetic Google consent';
      } else if (request.url.startsWith(pageUrl)) {
        const path = new URL(request.url).pathname;
        const name = path.endsWith('/connect.js') ? 'connect.js' : path.endsWith('/style.css') ? 'style.css' : 'index.html';
        responseHeaders = [{ name: 'Content-Type', value: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }];
        body = readFileSync(resolve('auth', name), 'utf8');
      } else if (request.url === `${origin}/favicon.ico` || request.url === 'https://accounts.google.com/favicon.ico') {
        responseCode = 204;
      } else {
        unexpected.push(request.url);
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        return;
      }
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders, body: Buffer.from(body).toString('base64') });
    } catch (error) {
      interceptionErrors.push(String(error));
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.goto(`${pageUrl}?state=${state}`);
  await expect(page.getByRole('heading', { name: 'Sign in to ApplyTrack.' })).toBeVisible();
  expect(page.url()).toBe(pageUrl);
  await page.getByLabel('ApplyTrack email', { exact: true }).fill('candidate@example.invalid');
  await page.getByLabel('ApplyTrack password', { exact: true }).fill('synthetic-password-for-test');
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await page.getByRole('button', { name: 'Continue to Google' }).click({ noWaitAfter: true });
  await expect(page).toHaveURL(googleUrl);
  await expect(page.getByText('Synthetic Google consent')).toBeVisible();
  const submitted = requests.filter(request => request.url === callback);
  expect(submitted).toHaveLength(1);
  expect(submitted[0].method).toBe('POST');
  expect(submitted[0].headers.origin).toBe(origin);
  expect(Object.fromEntries(new URLSearchParams(submitted[0].body))).toEqual({ action: 'browser_authorize', state, email: 'candidate@example.invalid', password: 'synthetic-password-for-test' });
  const redirected = requests.filter(request => request.url === googleUrl);
  expect(redirected).toHaveLength(1);
  expect(redirected[0].method).toBe('GET');
  expect(redirected[0].body).toBeUndefined();
  expect(redirected[0].headers.authorization).toBeUndefined();
  expect(redirected[0].headers.cookie).toBeUndefined();
  expect(JSON.stringify(redirected)).not.toContain('synthetic-password-for-test');
  expect(JSON.stringify(redirected)).not.toContain('candidate@example.invalid');
  const cookie = (await page.context().cookies(callback)).find(value => value.name === '__Host-apply-gmail-test');
  expect(cookie).toMatchObject({ value: 'synthetic-nonce', domain: 'fbnmvajnvylkaegtkvsj.supabase.co', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
  expect(cspErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(interceptionErrors).toEqual([]);
});

test('Gmail browser approval rejects missing, duplicate and malformed connection state', async ({ page }) => {
  await serve(page);
  for (const query of ['', '?state=invalid', `?state=${state}&state=${state}`, `?state=${state}#untrusted`]) {
    await page.goto(`${pageUrl}${query}`);
    await expect(page.getByRole('alert')).toHaveText('Open ApplyTrack and choose Connect Gmail to start a new connection.');
    await expect(page.getByLabel('ApplyTrack password', { exact: true })).toBeHidden();
  }
});

test('Gmail approval error copy cannot reflect URL content and fits a narrow screen', async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${pageUrl}?state=${state}&error=${encodeURIComponent('<script>private-provider-token</script>')}`);
  await expect(page.getByRole('alert')).toContainText('Sign-in could not be confirmed.');
  expect(await page.locator('body').innerText()).not.toContain('private-provider-token');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(page.url()).toBe(pageUrl);
  await page.screenshot({ path: test.info().outputPath('gmail-browser-approval.png'), fullPage: true });
});
