import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const site = 'https://applytrack.example';
async function serveSite(page: Page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== site) return route.abort();
    const file = url.pathname === '/' ? 'index.html' : url.pathname === '/privacy/' ? 'privacy/index.html' : url.pathname === '/style.css' ? 'style.css' : null;
    if (!file) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(resolve('site', file), 'utf8') });
  });
}

test('public site explains invited testing and keeps privacy accessible without an account', async ({ page }) => {
  await serveSite(page);
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(site);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your applications.A clearer view.');
  await expect(page.getByText('Gmail access is currently limited to approved Google test accounts.')).toBeVisible();
  await expect(page.getByRole('link', { name: /View downloads/ })).toHaveAttribute('href', 'https://github.com/asein-03/applytrack/releases');
  await page.getByRole('navigation').getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(`${site}/privacy/`);
  await expect(page.getByRole('heading', { name: 'Gmail access and use' })).toBeVisible();
  await expect(page.getByText(/Gmail permission is broader than a particular job or sender/)).toBeVisible();
  await expect(page.getByText(/relevant email content is retained/i)).toBeVisible();
  await expect(page.getByText(/This cleanup queue can outlive account deletion/)).toBeVisible();
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

for (const width of [390, 1440]) test(`public pages remain readable at ${width}px`, async ({ page }, info) => {
  await serveSite(page); await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  for (const path of ['/', '/privacy/']) {
    await page.goto(site + path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(path === '/' ? 'homepage.png' : 'privacy.png'), fullPage: true });
  }
});
