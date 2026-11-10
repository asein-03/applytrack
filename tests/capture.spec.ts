import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = readFileSync(resolve('tests/fixtures/application.html'), 'utf8');
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });

test('DOM capture distinguishes button clicks from visible submission confirmation', async ({ page }) => {
  await page.route('https://jobs.lever.co/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.addInitScript(() => {
    const state = window as unknown as { events: unknown[]; context: unknown; chrome: unknown };
    state.events = [];
    state.chrome = { runtime: {
      sendMessage: async (message: { type: string; event?: unknown; context?: unknown }) => {
        if (message.type === 'state') return { ok: true, session: { id: 'session-test', browserEnabled: true, screenEnabled: false } };
        if (message.type === 'remember') { state.context = message.context; return { ok: true }; }
        if (message.type === 'context') return { ok: true, context: state.context };
        if (message.type === 'event') { state.events.push(message.event); return { ok: true }; }
        return { ok: true };
      },
      onMessage: { addListener: () => undefined },
    } };
  });
  await page.goto('https://jobs.lever.co/northstar/role-123');
  await page.addScriptTag({ path: resolve('extension/content.js') });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as unknown as { events: unknown[] }).events)).toHaveLength(0);

  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { events: { kind: string }[] }).events.map(event => event.kind))).toEqual(['submission_pending']);
  await page.evaluate(() => {
    document.querySelector('form')!.remove();
    document.querySelector('h2')!.removeAttribute('hidden');
    const error = document.createElement('div');
    error.id = 'failure';
    error.setAttribute('role', 'alert');
    error.textContent = 'Your application could not be submitted.';
    document.body.append(error);
    document.querySelector('main')!.append(document.createElement('br'));
  });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as unknown as { events: unknown[] }).events)).toHaveLength(1);
  await page.evaluate(() => document.querySelector('#failure')!.remove());
  await expect.poll(() => page.evaluate(() => (window as unknown as { events: { kind: string }[] }).events.map(event => event.kind))).toEqual(['submission_pending', 'submission_confirmed']);
  const events = await page.evaluate(() => (window as unknown as { events: { company: string; role: string; description: string }[] }).events);
  expect(events[1].company).toBe('Northstar');
  expect(events[1].role).toBe('Product Designer');
  expect(JSON.stringify(events)).not.toContain('private@example.test');

  await page.evaluate(() => document.querySelector('main')!.append(document.createElement('br')));
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as unknown as { events: unknown[] }).events)).toHaveLength(2);
});

test('ending screen sharing during OCR initialization rejects and stops the stream', async ({ page }) => {
  await page.route('**/capture-lifecycle-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Capture lifecycle test</title>' }));
  await page.goto('/capture-lifecycle-test');
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()); });
  const result = await page.evaluate(async () => {
    // Keep initialization pending without making a CDN request.
    Object.defineProperty(window, 'Worker', { configurable: true, value: class {
      postMessage() {}
      terminate() {}
    } });
    const canvas = document.createElement('canvas');
    canvas.width = 300; canvas.height = 150;
    canvas.getContext('2d')!.fillRect(0, 0, 300, 150);
    const stream = canvas.captureStream(2);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => stream });
    const modulePath = '/src/capture.ts';
    const { startCapture } = await import(modulePath);
    let lastStatus = '';
    try {
      await startCapture({ getApplications: () => [], onStatus: (status: { state: string; message: string }) => {
        lastStatus = status.state;
        if (status.message === 'Loading on-device text recognition.') setTimeout(() => {
          const track = stream.getVideoTracks()[0];
          track.stop();
          track.dispatchEvent(new Event('ended'));
        }, 10);
      } });
      return { rejected: false, track: stream.getVideoTracks()[0].readyState, lastStatus, message: '' };
    } catch (error) {
      return { rejected: true, track: stream.getVideoTracks()[0].readyState, lastStatus, message: error instanceof Error ? error.message : String(error) };
    }
  });
  expect(result.rejected).toBe(true);
  expect(result.track).toBe('ended');
  expect(result.lastStatus).toBe('stopped');
  expect(result.message).toContain('Screen sharing stopped');
  expect(requests).toEqual([]);
});
