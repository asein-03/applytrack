import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('desktop serves the dashboard, isolates native privileges and keeps tracking alive with its window closed', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'apply-desktop-test-'));
  const executablePath = process.env.APPLY_DESKTOP_EXECUTABLE;
  const app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env: { ...process.env, APP_STORAGE_MODE: 'local', APPLY_DESKTOP_DATA_DIR: dataDir }, timeout: 45000 });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    expect(await page.evaluate(() => [typeof (window as any).require, typeof (window as any).process])).toEqual(['undefined', 'undefined']);
    const state = await page.evaluate(() => window.applyDesktop!.getState());
    expect(state.version).toBe(JSON.parse(await readFile(resolve('package.json'), 'utf8')).version);
    const cloudConfig = await (await fetch('http://localhost:4318/api/cloud/config')).json();
    if (cloudConfig.url) {
      const key = `sb-${new URL(cloudConfig.url).hostname.split('.')[0]}-auth-token`;
      await page.evaluate(async key => { await window.applyDesktop!.authStorage.setItem(key, 'synthetic-desktop-test-session'); }, key);
      expect(await page.evaluate(key => window.applyDesktop!.authStorage.getItem(key), key)).toBe('synthetic-desktop-test-session');
      const saved = await readFile(join(dataDir, 'runtime', 'account-session.os'));
      expect(saved.includes('synthetic-desktop-test-session')).toBe(false);
      await page.evaluate(key => window.applyDesktop!.authStorage.removeItem(key), key);
      expect(await page.evaluate(key => window.applyDesktop!.authStorage.getItem(key), key)).toBeNull();
    }
    expect(await page.evaluate(async () => { try { await window.applyDesktop!.authStorage.getItem('../../mail-key'); return true; } catch { return false; } })).toBe(false);
    await expect(readFile(join(dataDir, 'runtime', 'mail-key'))).rejects.toThrow();
    expect((await readFile(join(dataDir, 'runtime', 'mail-key.os'))).length).toBeGreaterThan(32);
    const security = await app.evaluate(({ BrowserWindow }) => { const preferences = (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences(); return { sandbox: preferences.sandbox, isolated: preferences.contextIsolation, node: preferences.nodeIntegration, webSecurity: preferences.webSecurity }; });
    expect(security).toEqual({ sandbox: true, isolated: true, node: false, webSecurity: true });
    const headers = (await fetch('http://localhost:5173')).headers;
    expect(headers.get('content-security-policy')).toContain("object-src 'none'");
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('demo');
    await expect(page.getByText(/These are sample applications/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Northstar', exact: true }).first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('desktop-dashboard.png') });
    await page.getByRole('button', { name: 'Documents', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('personal');
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Desktop app', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Deadline reminders', exact: true })).toBeVisible();
    const started = await fetch('http://localhost:4318/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ browserEnabled: true, screenEnabled: false }) });
    expect(started.ok).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    expect((await (await fetch('http://localhost:4318/api/settings')).json()).session).toBeTruthy();
    await app.evaluate(({ app }) => { app.emit('activate'); });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); });
    await expect.poll(async () => (await (await fetch('http://localhost:4318/api/settings')).json()).session).toBeNull();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('apply:command', { type: 'show-tasks' }));
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reminders', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Reminders/ })).toBeVisible();
    expect(await page.evaluate(async () => { try { await navigator.mediaDevices.getUserMedia({ audio: true }); return 'granted'; } catch (error) { return (error as DOMException).name; } })).toBe('NotAllowedError');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  await expect.poll(async () => { try { await fetch('http://localhost:4318/api/health'); return true; } catch { return false; } }).toBe(false);
});
