import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';

type DocumentFile = { kind: string; name: string; size: number; mimeType: string; lastModified: number; sha256: string | null; contentBase64?: string };
type Capture = { kind: string; sourceId: string; company: string; role: string; url: string; document?: DocumentFile; documents?: DocumentFile[] };
type Message = { type: string; [key: string]: unknown };
const contentPath = resolve('extension/content.js');
const background = readFileSync(resolve('extension/background.js'), 'utf8');
const fixture = readFileSync(resolve('tests/fixtures/document-application.html'), 'utf8');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const cleanCopy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function harness(page: Page, active = true) {
  const saved: Record<string, any> = {};
  const posted: Capture[] = [];
  const attempts: Capture[] = [];
  const titles: string[] = [];
  const session = { id: 'session-one', browserEnabled: active, screenEnabled: false, stoppedAt: null as string | null };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let eventFailures = 0;
  let listener: (message: Message, sender: any, respond: (value: any) => void) => void = () => {};
  const noopListener = { addListener: () => undefined };
  const local = { token: 'test-pairing-token-only' };
  const storage = (values: Record<string, unknown>) => ({
    get: async (keys: string | string[] | null) => keys === null ? cleanCopy(values) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key] ? cleanCopy(values[key]) : values[key]])),
    set: async (next: Record<string, unknown>) => { Object.assign(values, cleanCopy(next)); },
    remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    setAccessLevel: async () => {},
  });
  runInNewContext(background, {
    URL, AbortSignal, console,
    setTimeout: (fn: () => void, delay: number) => { const timer = setTimeout(fn, delay); timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); },
    chrome: {
      storage: { local: storage(local), session: storage(saved) },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async ({ title }: { title: string }) => { titles.push(title); } },
      permissions: { contains: async () => true, getAll: async () => ({ origins: ['https://jobs.lever.co/*'] }), onAdded: noopListener, onRemoved: noopListener },
      scripting: { unregisterContentScripts: async () => {}, registerContentScripts: async () => {}, executeScript: async () => {} },
      tabs: { query: async () => [], sendMessage: async () => {}, onRemoved: noopListener },
      alarms: { create: () => {}, onAlarm: noopListener },
      runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}`, onInstalled: noopListener, onStartup: noopListener, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    },
    fetch: async (url: string, init: { body?: string }) => {
      if (url.endsWith('/api/sessions/current')) return { ok: true, status: 200, json: async () => ({ session: cleanCopy(session) }) };
      if (url.endsWith('/api/events')) {
        const event = JSON.parse(init.body!) as Capture;
        attempts.push(event);
        if (eventFailures > 0) { eventFailures--; return { ok: false, status: 503, json: async () => ({ error: 'Fixture temporarily unavailable' }) }; }
        posted.push(event);
        return { ok: true, status: 200, json: async () => ({ application: { id: 'fixture-application' }, evidence: {} }) };
      }
      throw new Error(`Unexpected fixture network request: ${url}`);
    },
  });
  const send = (message: Message, url = page.url(), frameId = 0) => new Promise<any>(respond => {
    listener(message, { tab: { id: 77, url }, url, frameId }, respond);
  });
  await page.exposeBinding('__companionSend', ({ page: source }, message: Message) => send(message, source.url()));
  await page.addInitScript(() => {
    const state = window as any;
    state.__companionListeners = [];
    state.chrome = { runtime: {
      sendMessage: (message: unknown) => state.__companionSend(message),
      onMessage: { addListener: (fn: unknown) => state.__companionListeners.push(fn) },
    } };
  });
  await page.route('https://jobs.lever.co/**', route => {
    const url = route.request().url();
    const body = url.includes('/confirmation')
      ? '<!doctype html><title>Application received</title><h1>Your application has been submitted.</h1>'
      : url.includes('role-456') ? fixture.replaceAll('role-123', 'role-456').replaceAll('Northstar', 'Eaststar').replaceAll('Product Designer', 'Design Engineer') : fixture;
    return route.fulfill({ contentType: 'text/html', body });
  });
  const open = async (path = 'northstar/role-123') => {
    await page.goto(`https://jobs.lever.co/${path}`);
    await page.addScriptTag({ path: contentPath });
    if (session.browserEnabled) await expect.poll(() => saved['context:77']?.url).toBe(`https://jobs.lever.co/${path.replace('/confirmation', '')}`);
    else await page.waitForTimeout(100);
  };
  const refresh = () => page.evaluate(() => Promise.all((window as any).__companionListeners.map((fn: any) => new Promise(resolve => fn({ type: 'refresh' }, {}, resolve)))));
  return { saved, posted, attempts, titles, session, send, open, refresh,
    failEvents: (count: number) => { eventFailures = count; },
    dispose: () => { for (const timer of timers) clearTimeout(timer); },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;
let activeHarness: Harness | undefined;
test.afterEach(() => { activeHarness?.dispose(); activeHarness = undefined; });
const setup = async (page: Page, active = true) => { activeHarness = await harness(page, active); await activeHarness.open(); return activeHarness; };
async function select(page: Page, selector: string, contents: string, options: { name?: string; mimeType?: string; delay?: number } = {}) {
  await page.evaluate(({ selector, contents, options }) => {
    const input = document.querySelector(selector) as HTMLInputElement;
    const file = new File([contents], options.name || 'resume.pdf', { type: options.mimeType || 'application/pdf', lastModified: 1_700_000_000_000 });
    if (options.delay) Object.defineProperty(file, 'arrayBuffer', { value: async () => {
      await new Promise(resolve => setTimeout(resolve, options.delay));
      return File.prototype.arrayBuffer.call(file);
    } });
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { selector, contents, options });
}
async function clearFile(page: Page, selector: string) {
  await page.evaluate(selector => {
    const input = document.querySelector(selector) as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector);
}
const selected = (h: Harness) => h.posted.filter(event => event.kind === 'document_selected');
const confirmed = (h: Harness) => h.posted.filter(event => event.kind === 'submission_confirmed');

test('recognized documents preserve exact bytes and ignore unrelated files and answers', async ({ page }) => {
  const h = await setup(page);
  await select(page, '#portfolio', 'unrelated file', { name: 'resume.pdf' });
  await select(page, '#resume-upload', '%PDF-1.4 resume version A');
  await select(page, '#letter-upload', 'Dear Northstar', { name: 'cover.txt', mimeType: 'text/plain' });
  await expect.poll(() => selected(h).length).toBe(2);
  expect(selected(h).map(event => event.document?.kind)).toEqual(['resume', 'cover_letter']);
  expect(selected(h)[0].document).toMatchObject({ name: 'resume.pdf', sha256: digest('%PDF-1.4 resume version A'), contentBase64: Buffer.from('%PDF-1.4 resume version A').toString('base64') });
  expect(selected(h)[1].document?.sha256).toBe(digest('Dear Northstar'));
  expect(JSON.stringify(h.posted)).not.toContain('unrelated file');
  expect(JSON.stringify(h.posted)).not.toContain('Never capture this answer');
  expect(JSON.stringify(h.saved)).not.toContain('contentBase64');
  expect(h.posted.every(event => !event.kind.startsWith('submission'))).toBe(true);
});

test('inactive tracking does not read or retain files, and stale sessions are rejected', async ({ page }) => {
  const h = await setup(page, false);
  await page.evaluate(() => { File.prototype.arrayBuffer = () => { throw new Error('Inactive capture read a file'); }; });
  await select(page, '#resume-upload', '%PDF-1.4 inactive');
  await page.getByRole('button', { name: 'Submit application' }).click();
  await page.waitForTimeout(200);
  expect(h.posted).toEqual([]); expect(h.saved).toEqual({});
  const result = await h.send({ type: 'event', sessionId: 'session-one', event: { kind: 'document_selected' } });
  expect(result.ignored).toBe(true);
});

test('same-name replacements and reselections retain different fingerprints and identities', async ({ page }) => {
  const h = await setup(page);
  await select(page, '#resume-upload', '%PDF-same-name-A', { delay: 120 });
  await select(page, '#resume-upload', '%PDF-same-name-B');
  await expect.poll(() => selected(h).length).toBe(2);
  expect(selected(h).map(event => event.document?.sha256)).toEqual([digest('%PDF-same-name-A'), digest('%PDF-same-name-B')]);
  expect(new Set(selected(h).map(event => event.sourceId)).size).toBe(2);
  await clearFile(page, '#resume-upload');
  await expect.poll(() => h.posted.length).toBe(3);
  expect(h.posted[2]).toMatchObject({ kind: 'document_removed', document: { sha256: digest('%PDF-same-name-B') } });
  expect(h.posted[2].document?.contentBase64).toBeUndefined();
  await select(page, '#resume-upload', '%PDF-same-name-B');
  await expect.poll(() => selected(h).length).toBe(3);
  expect(new Set(h.posted.map(event => event.sourceId)).size).toBe(4);
});

test('clearing an older field cannot remove its replacement and form reset removes the current file', async ({ page }) => {
  const h = await setup(page);
  await select(page, '#resume-upload', '%PDF-old');
  await select(page, '#other-resume', '%PDF-current');
  await expect.poll(() => selected(h).length).toBe(2);
  await clearFile(page, '#resume-upload');
  await page.waitForTimeout(100);
  expect(h.posted.filter(event => event.kind === 'document_removed')).toHaveLength(0);
  await page.getByRole('button', { name: 'Reset form' }).click();
  await expect.poll(() => h.posted.filter(event => event.kind === 'document_removed').length).toBe(1);
  expect(h.posted.at(-1)?.document?.sha256).toBe(digest('%PDF-current'));
  expect(h.saved['context:77'].documentState.selected).toEqual([]);
});

test('submit snapshots bind to the clicked version and exclude later replacements and all bytes', async ({ page }) => {
  const h = await setup(page);
  await select(page, '#resume-upload', '%PDF-before-click', { delay: 150 });
  await page.getByRole('button', { name: 'Submit application' }).click();
  await select(page, '#resume-upload', '%PDF-after-click');
  await page.locator('#confirmation').evaluate(node => node.removeAttribute('hidden'));
  await expect.poll(() => confirmed(h).length).toBe(1);
  const submissions = h.posted.filter(event => event.kind.startsWith('submission'));
  expect(submissions.map(event => event.kind)).toEqual(['submission_pending', 'submission_confirmed']);
  expect(submissions.map(event => event.documents?.[0].sha256)).toEqual([digest('%PDF-before-click'), digest('%PDF-before-click')]);
  expect(JSON.stringify(submissions)).not.toContain('contentBase64');
  expect(new Set(submissions.map(event => event.sourceId.split(':').at(-1))).size).toBe(1);
  await page.locator('#confirmation').evaluate(node => node.setAttribute('hidden', ''));
  await page.getByRole('button', { name: 'Submit application' }).click();
  await page.locator('#confirmation').evaluate(node => node.removeAttribute('hidden'));
  await expect.poll(() => confirmed(h).length).toBe(2);
  expect(confirmed(h)[1].documents?.[0].sha256).toBe(digest('%PDF-after-click'));
  expect(confirmed(h)[0].sourceId).not.toBe(confirmed(h)[1].sourceId);
});

test('metadata survives a confirmation navigation and clears on job and session changes', async ({ page }) => {
  const h = await setup(page);
  await select(page, '#resume-upload', '%PDF-navigate');
  await expect.poll(() => selected(h).length).toBe(1);
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect.poll(() => h.posted.filter(event => event.kind === 'submission_pending').length).toBe(1);
  expect(JSON.stringify(h.saved)).not.toContain('contentBase64');
  await h.open('northstar/role-123/confirmation');
  await expect.poll(() => confirmed(h).length).toBe(1);
  expect(confirmed(h)[0].documents?.[0].sha256).toBe(digest('%PDF-navigate'));
  await h.open('eaststar/role-456');
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect.poll(() => h.posted.filter(event => event.kind === 'submission_pending').length).toBe(2);
  expect(h.posted.at(-1)?.documents).toEqual([]);
  expect(h.saved['context:77'].documentState.selected).toEqual([]);
  await select(page, '#resume-upload', '%PDF-new-job');
  await expect.poll(() => selected(h).length).toBe(2);
  h.session.id = 'session-two';
  await h.refresh();
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect.poll(() => h.posted.filter(event => event.kind === 'submission_pending').length).toBe(3);
  expect(h.posted.at(-1)?.documents).toEqual([]);
  expect(h.saved['context:77'].sessionId).toBe('session-two');
});

test('archive allowlist limits copies and the background rejects malformed content', async ({ page }) => {
  const h = await setup(page);
  await select(page, '#resume-upload', '<html>not an archive format</html>', { name: 'resume.html', mimeType: 'text/html' });
  await expect.poll(() => selected(h).length).toBe(1);
  expect(selected(h)[0].document?.contentBase64).toBeUndefined();
  expect(selected(h)[0].document?.sha256).toBe(digest('<html>not an archive format</html>'));
  const result = await h.send({ type: 'event', sessionId: h.session.id, event: {
    ...selected(h)[0], eventId: 'forged-event', document: { ...selected(h)[0].document, contentBase64: Buffer.from('different bytes').toString('base64') },
  } });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Only PDF, DOC, DOCX and TXT');
  const frameResult = await h.send({ type: 'event', sessionId: h.session.id, event: selected(h)[0] }, page.url(), 2);
  expect(frameResult.ok).toBe(false);
  expect(h.posted).toHaveLength(1);
});

test('temporary API failures retry the original bytes without persisting copies', async ({ page }) => {
  const h = await setup(page);
  h.failEvents(1);
  await select(page, '#resume-upload', '%PDF-retry');
  await expect.poll(() => h.titles.some(title => title.includes('waiting for the local app'))).toBe(true);
  expect(JSON.stringify(h.saved)).not.toContain('contentBase64');
  await expect.poll(() => selected(h).length, { timeout: 8_000 }).toBe(1);
  expect(h.attempts).toHaveLength(2);
  expect(h.attempts[0]).toEqual(h.attempts[1]);
  expect(selected(h)[0].document?.contentBase64).toBe(Buffer.from('%PDF-retry').toString('base64'));
});

test('documents above the archive limit retain metadata only and oversized selections clear the prior file', async ({ page }) => {
  const h = await setup(page);
  await page.evaluate(() => {
    const input = document.querySelector('#resume-upload') as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'resume.pdf', { type: 'application/pdf', lastModified: 1_700_000_000_000 }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => selected(h).length).toBe(1);
  expect(selected(h)[0].document?.size).toBe(10 * 1024 * 1024 + 1);
  expect(selected(h)[0].document?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(selected(h)[0].document?.contentBase64).toBeUndefined();
  await page.evaluate(() => {
    const input = document.querySelector('#resume-upload') as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'resume.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => h.posted.filter(event => event.kind === 'document_removed').length).toBe(1);
  expect(selected(h)).toHaveLength(1);
  expect(h.saved['context:77'].documentState.selected).toEqual([]);
  expect(h.titles.some(title => title.includes('25 MB capture limit'))).toBe(true);
});

test('ending a session discards waiting copies and a later session cannot replay them', async ({ page }) => {
  const h = await setup(page);
  h.failEvents(1);
  await select(page, '#resume-upload', '%PDF-ended-session');
  await expect.poll(() => h.titles.some(title => title.includes('waiting for the local app'))).toBe(true);
  h.session.browserEnabled = false;
  await h.refresh();
  expect(h.saved).toEqual({});
  const stopped = await h.send({ type: 'state' });
  expect(stopped.pendingCaptures).toBe(0);
  expect(stopped.captureError).toContain('Tracking ended');
  h.session.id = 'session-two'; h.session.browserEnabled = true;
  await h.refresh();
  await select(page, '#resume-upload', '%PDF-new-session');
  await expect.poll(() => selected(h).length).toBe(1);
  expect(selected(h)[0].document?.sha256).toBe(digest('%PDF-new-session'));
  expect(h.attempts).toHaveLength(2);
});

test('a confirmation without a submit snapshot does not promote a selected document', async ({ page }) => {
  const h = await setup(page);
  await select(page, '#resume-upload', '%PDF-selected-only');
  await expect.poll(() => selected(h).length).toBe(1);
  await page.locator('#confirmation').evaluate(node => node.removeAttribute('hidden'));
  await expect.poll(() => confirmed(h).length).toBe(1);
  expect(confirmed(h)[0].documents).toEqual([]);
  expect(h.posted.some(event => event.kind === 'submission_pending')).toBe(false);
});

test('popup shows pending captures and persistent failure details with clear recovery actions', async ({ page }) => {
  await page.route('http://127.0.0.1:5173/extension-popup-fixture/**', route => {
    const filename = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (!['popup.html', 'popup.css', 'popup.js'].includes(filename)) return route.abort();
    return route.fulfill({ contentType: filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(resolve('extension', filename), 'utf8') });
  });
  await page.addInitScript(() => {
    const state = window as any;
    state.__popupState = { ok: true, paired: true, session: { id: 'session-popup', browserEnabled: true }, pendingCaptures: 2, captureError: 'Captures are waiting for the local app. Keep tracking on while it reconnects.' };
    state.__popupActions = [];
    state.chrome = {
      runtime: { sendMessage: async ({ type }: { type: string }) => {
        state.__popupActions.push(type);
        if (type === 'retry-captures') state.__popupState.pendingCaptures = 0;
        if (type === 'retry-captures' || type === 'dismiss-capture-error') state.__popupState.captureError = null;
        return state.__popupState;
      } },
      permissions: { request: async () => true }, tabs: { create: () => {} },
    };
  });
  await page.goto('/extension-popup-fixture/popup.html');
  await expect(page.locator('#capture-heading')).toHaveText('2 captures waiting to save');
  await expect(page.locator('#capture-detail')).toContainText('Keep tracking on');
  await expect(page.getByRole('button', { name: 'Stop browser tracking' })).toBeVisible();
  await page.getByRole('button', { name: 'Check saves' }).click();
  await expect(page.locator('#capture-notice')).toBeHidden();
  await page.evaluate(() => { (window as any).__popupState.captureError = 'Capture not saved. Re-select the document with the local app connected.'; });
  await expect(page.locator('#capture-heading')).toHaveText('Capture needs attention', { timeout: 5000 });
  await expect(page.locator('#capture-notice')).toHaveAttribute('role', 'alert');
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('#capture-notice')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__popupActions)).toEqual(expect.arrayContaining(['retry-captures', 'dismiss-capture-error']));
});
