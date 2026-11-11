import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

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
  let archiveFailures = 0;
  let offline = false;
  let committedFailures = 0;
  let healthUrl = 'http://localhost:5173';
  let timeOffset = 0;
  let heldSession: Promise<number> | null = null;
  let sessionHeld = false;
  const openedUrls: string[] = [];
  const remoteDocuments = new Map<string, any>();
  let listener: (message: Message, sender: any, respond: (value: any) => void) => void = () => {};
  const noopListener = { addListener: () => undefined };
  let workerGeneration = 0;
  const local: Record<string, any> = { token: 'test-pairing-token-only' };
  const storage = (values: Record<string, unknown>, generation: number) => ({
    get: async (keys: string | string[] | null) => { if (generation !== workerGeneration) return new Promise(() => {}); return keys === null ? cleanCopy(values) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key] ? cleanCopy(values[key]) : values[key]])); },
    set: async (next: Record<string, unknown>) => { if (generation !== workerGeneration) return new Promise(() => {}); Object.assign(values, cleanCopy(next)); },
    remove: async (keys: string | string[]) => { if (generation !== workerGeneration) return new Promise(() => {}); for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    setAccessLevel: async () => {},
  });
  const startWorker = () => {
    const generation = ++workerGeneration;
    runInNewContext(background, {
    URL, AbortSignal, console, crypto: webcrypto, TextEncoder,
    Date: class extends Date { static now() { return Date.now() + timeOffset; } },
    setTimeout: (fn: () => void, delay: number) => { const timer = setTimeout(() => { if (generation === workerGeneration) fn(); }, delay); timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); },
    chrome: {
      storage: { local: storage(local, generation), session: storage(saved, generation) },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async ({ title }: { title: string }) => { titles.push(title); } },
      permissions: { contains: async () => true, getAll: async () => ({ origins: ['https://jobs.lever.co/*'] }), onAdded: noopListener, onRemoved: noopListener },
      scripting: { unregisterContentScripts: async () => {}, registerContentScripts: async () => {}, executeScript: async () => {} },
      tabs: { create: async ({ url }: { url: string }) => { openedUrls.push(url); }, query: async () => [], sendMessage: async () => {}, onRemoved: noopListener },
      alarms: { create: () => {}, onAlarm: noopListener },
      runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}`, onInstalled: noopListener, onStartup: noopListener, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    },
    fetch: async (url: string, init: { body?: string }) => {
      if (generation !== workerGeneration) return new Promise(() => {});
      if (offline) throw new Error('Fixture network offline');
      if (url.endsWith('/api/health')) return { ok: true, status: 200, json: async () => ({ ok: true, dashboardUrl: healthUrl }) };
      if (url.endsWith('/api/sessions/current')) {
        const gate = heldSession; heldSession = null;
        if (gate) { sessionHeld = true; const status = await gate; return { ok: status === 200, status, json: async () => ({ session: cleanCopy(session), error: 'Previous account signed out' }) }; }
        return { ok: true, status: 200, json: async () => ({ session: cleanCopy(session) }) };
      }
      if (url.endsWith('/api/events')) {
        const event = JSON.parse(init.body!) as Capture;
        attempts.push(event);
        if (eventFailures > 0) { eventFailures--; return { ok: false, status: 503, json: async () => ({ error: 'Fixture temporarily unavailable' }) }; }
        if (archiveFailures > 0) { archiveFailures--; return { ok: true, status: 201, json: async () => ({ application: { id: 'fixture-application', documents: [{ stored: false }] }, evidence: {}, archiveError: 'The document name was recorded, but its cloud copy could not be saved.' }) }; }
        posted.push(event);
        if (event.kind === 'document_selected' && event.document) {
          const key = `${event.url}:${event.document.sha256}`;
          const previous = remoteDocuments.get(key);
          const { contentBase64, ...metadata } = event.document;
          remoteDocuments.set(key, { ...metadata, id: `document-${event.document.sha256}`, stored: contentBase64 !== undefined || previous?.stored || false });
        }
        if (committedFailures > 0) { committedFailures--; throw new Error('Response lost after cloud commit'); }
        return { ok: true, status: 200, json: async () => ({ application: { id: 'fixture-application', documents: [...remoteDocuments.values()] }, evidence: { documentId: event.document ? `document-${event.document.sha256}` : undefined } }) };
      }
      throw new Error(`Unexpected fixture network request: ${url}`);
    },
    });
  };
  startWorker();
  const send = (message: Message, url = page.url(), frameId = 0, tabId = 77) => new Promise<any>(respond => {
    listener(message, { tab: { id: tabId, url }, url, frameId }, respond);
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
  return { saved, local, posted, attempts, titles, session, send, open, refresh, openedUrls,
    popup: (message: Message) => new Promise<any>(respond => listener(message, { url: 'chrome-extension://fixture/popup.html' }, respond)),
    restartWorker: () => { for (const timer of timers) clearTimeout(timer); timers.clear(); startWorker(); },
    restartBrowser: () => { for (const timer of timers) clearTimeout(timer); timers.clear(); for (const key of Object.keys(saved)) delete saved[key]; startWorker(); },
    setOffline: (value: boolean) => { offline = value; },
    failAfterCommit: (count: number) => { committedFailures = count; },
    setHealthUrl: (value: string) => { healthUrl = value; },
    advanceTime: (milliseconds: number) => { timeOffset += milliseconds; },
    holdNextSession: () => { let release!: (status: number) => void; sessionHeld = false; heldSession = new Promise(resolve => { release = resolve; }); return release; },
    sessionIsHeld: () => sessionHeld,
    failEvents: (count: number) => { eventFailures = count; },
    failArchives: (count: number) => { archiveFailures = count; },
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
  await expect.poll(() => h.titles.some(title => title.includes('waiting for the Apply app'))).toBe(true);
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
  await expect.poll(() => h.titles.some(title => title.includes('waiting for the Apply app'))).toBe(true);
  h.session.browserEnabled = false;
  await h.refresh();
  expect(Object.keys(h.saved).filter(key => key.startsWith('context:'))).toEqual([]);
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


test('partial HTTP 201 archive failures retain and retry the original copy until storage succeeds', async ({ page }) => {
  const h = await setup(page);
  h.failArchives(1);
  await select(page, '#resume-upload', '%PDF-partial-archive');
  await expect.poll(() => h.titles.some(title => title.includes('waiting for the Apply app'))).toBe(true);
  const pending = await h.send({ type: 'state' });
  expect(pending.pendingCaptures).toBe(1);
  expect(JSON.stringify(h.saved)).not.toContain('contentBase64');
  await expect.poll(() => selected(h).length, { timeout: 8_000 }).toBe(1);
  expect(h.attempts).toHaveLength(2);
  expect(h.attempts[0]).toEqual(h.attempts[1]);
  expect(selected(h)[0].document?.contentBase64).toBe(Buffer.from('%PDF-partial-archive').toString('base64'));
  const complete = await h.send({ type: 'state' });
  expect(complete.pendingCaptures).toBe(0); expect(complete.captureError).toBeNull();
});

test('a worker restart recovers queued metadata and explicitly requests a lost file copy', async ({ page }) => {
  const h = await setup(page);
  h.failEvents(1);
  await select(page, '#resume-upload', '%PDF-worker-recovery');
  await expect.poll(() => h.saved['capture-journal-v1']?.pending?.length).toBe(1);
  await expect.poll(() => h.attempts.length).toBe(1);
  const originalId = h.attempts[0].sourceId;
  expect(JSON.stringify(h.saved)).not.toContain('contentBase64');
  expect(JSON.stringify(h.local)).not.toContain('resume.pdf');
  h.restartWorker();
  await h.popup({ type: 'retry-captures' });
  await expect.poll(() => selected(h).length).toBe(1);
  expect(selected(h)[0].sourceId).toBe(originalId);
  expect(selected(h)[0].document?.contentBase64).toBeUndefined();
  const recovered = await h.popup({ type: 'state' });
  expect(recovered.pendingCaptures).toBe(0);
  expect(recovered.captureStatus.state).toBe('attention');
  expect(recovered.captureStatus.detail).toContain('copy is missing');
  await clearFile(page, '#resume-upload');
  await select(page, '#resume-upload', '%PDF-worker-recovery');
  await expect.poll(() => selected(h).length).toBe(2);
  const retried = await h.popup({ type: 'state' });
  expect(retried.captureStatus.state).toBe('saved');
  expect(retried.captureError).toBeNull();
});

test('a lost response followed by worker restart verifies the existing cloud copy without false failure', async ({ page }) => {
  const h = await setup(page);
  h.failAfterCommit(1);
  await select(page, '#resume-upload', '%PDF-response-lost');
  await expect.poll(() => h.attempts.length).toBe(1);
  await expect.poll(() => h.saved['capture-journal-v1']?.pending?.length).toBe(1);
  h.restartWorker();
  await h.popup({ type: 'retry-captures' });
  await expect.poll(() => h.attempts.length).toBe(2);
  await expect.poll(async () => (await h.popup({ type: 'state' })).captureStatus.state).toBe('saved');
  expect(h.attempts[1].sourceId).toBe(h.attempts[0].sourceId);
  expect(h.attempts[1].document?.contentBase64).toBeUndefined();
});

test('browser restart preserves only an account-scoped interruption count until acknowledged', async ({ page }) => {
  const h = await setup(page);
  h.failEvents(1);
  await select(page, '#resume-upload', '%PDF-browser-restart');
  await expect.poll(() => h.local['capture-interruption-v1']?.pending).toBe(1);
  expect(Object.keys(h.local['capture-interruption-v1']).sort()).toEqual(['attention', 'owner', 'pending', 'updatedAt']);
  expect(JSON.stringify(h.local)).not.toContain('Northstar');
  await expect.poll(() => h.attempts.length).toBe(1);
  await expect.poll(async () => (await h.popup({ type: 'state' })).captureStatus.detail).toContain('waiting for the Apply app');
  await page.goto('about:blank');
  h.restartBrowser();
  const interrupted = await h.popup({ type: 'state' });
  expect(interrupted.captureStatus.state).toBe('attention');
  expect(interrupted.captureStatus.detail).toContain('browser restarted with 1 unconfirmed capture');
  expect(interrupted.pendingCaptures).toBe(0);
  expect(interrupted.captureStatus.recent).toEqual([]);
  h.restartWorker();
  expect((await h.popup({ type: 'state' })).captureStatus.state).toBe('attention');
  await h.popup({ type: 'dismiss-capture-error' });
  expect(h.local['capture-interruption-v1']).toBeUndefined();
});

test('re-pairing cannot expose or replay an earlier account’s pending captures', async ({ page }) => {
  const h = await setup(page);
  h.failEvents(1);
  await select(page, '#resume-upload', '%PDF-other-account');
  await expect.poll(() => h.attempts.length).toBe(1);
  const result = await h.popup({ type: 'pair', token: 'different-pairing-token-for-another-account' });
  expect(result.ok).toBe(true);
  expect(result.captureStatus.recent).toEqual([]);
  expect(result.pendingCaptures).toBe(0);
  expect(result.captureError).toBeNull();
  h.restartWorker();
  await h.popup({ type: 'retry-captures' });
  expect(h.attempts).toHaveLength(1);
  expect(JSON.stringify(h.saved)).not.toContain('other-account');
});

test('offline popup preserves save status and session metadata resumes when the connection returns', async ({ page }) => {
  const h = await setup(page);
  h.failEvents(1);
  await select(page, '#resume-upload', '%PDF-offline');
  await expect.poll(() => h.attempts.length).toBe(1);
  h.setOffline(true);
  const offline = await h.popup({ type: 'state' });
  expect(offline.ok).toBe(true); expect(offline.connected).toBe(false);
  expect(offline.pendingCaptures).toBe(1);
  expect(offline.captureStatus.state).toBe('saving');
  h.setOffline(false);
  await h.popup({ type: 'retry-captures' });
  await expect.poll(() => selected(h).length).toBe(1);
  expect((await h.popup({ type: 'state' })).captureStatus.state).toBe('saved');
});

test('an interrupted file identification and an expired upload remain visible after restart', async ({ page }) => {
  const h = await setup(page);
  const context = { company: 'Northstar', role: 'Product Designer', url: page.url(), jobId: 'role-123' };
  await h.send({ type: 'document-detected', sessionId: h.session.id, context, eventId: 'interrupted-detection',
    document: { kind: 'resume', name: 'resume.pdf', size: 10, mimeType: 'application/pdf', lastModified: 0, sha256: null } });
  expect((await h.popup({ type: 'state' })).captureStatus.state).toBe('detected');
  h.restartWorker();
  expect((await h.popup({ type: 'state' })).captureStatus.detail).toContain('File detection was interrupted');
  await h.popup({ type: 'dismiss-capture-error' });
  h.failEvents(1);
  await select(page, '#resume-upload', '%PDF-expired');
  await expect.poll(() => h.saved['capture-journal-v1']?.pending?.length).toBe(1);
  h.saved['capture-journal-v1'].pending[0].createdAt = Date.now() - 6 * 60 * 1000;
  h.restartWorker();
  const expired = await h.popup({ type: 'state' });
  expect(expired.pendingCaptures).toBe(0);
  expect(expired.captureStatus.detail).toContain('expired before it was saved');
});

test('dashboard opening follows the app origin and refuses remote destinations', async ({ page }) => {
  const h = await setup(page);
  expect((await h.popup({ type: 'open-dashboard' })).ok).toBe(true);
  expect(h.openedUrls).toEqual(['http://localhost:5173/']);
  h.setHealthUrl('https://example.com');
  expect((await h.popup({ type: 'open-dashboard' })).ok).toBe(false);
  h.setHealthUrl('http://localhost:5173/account?token=unsafe');
  expect((await h.popup({ type: 'open-dashboard' })).ok).toBe(false);
  expect(h.openedUrls).toHaveLength(1);
});

test('two tabs recover their own application and file identities without crossing job context', async ({ page }) => {
  const h = await setup(page);
  const contexts = [
    { company: 'Northstar', role: 'Product Designer', url: 'https://jobs.lever.co/northstar/role-123', jobId: 'role-123' },
    { company: 'Eaststar', role: 'Design Engineer', url: 'https://jobs.lever.co/eaststar/role-456', jobId: 'role-456' },
  ];
  await h.send({ type: 'remember', context: contexts[1], sessionId: h.session.id }, contexts[1].url, 0, 88);
  h.setOffline(true);
  for (const [index, context] of contexts.entries()) {
    const contents = `%PDF-tab-${index}`;
    const document = { kind: 'resume', name: 'resume.pdf', size: contents.length, mimeType: 'application/pdf', lastModified: 0, sha256: digest(contents), contentBase64: Buffer.from(contents).toString('base64') };
    const result = await h.send({ type: 'event', sessionId: h.session.id, event: { ...context, kind: 'document_selected', eventId: 'same-page-event-id', document } }, context.url, 0, index ? 88 : 77);
    expect(result.ok).toBe(true);
  }
  await expect.poll(() => h.saved['capture-journal-v1']?.pending?.length).toBe(2);
  h.restartWorker(); h.setOffline(false);
  await expect.poll(() => selected(h).length).toBe(2);
  expect(selected(h).map(event => [event.company, event.url, event.document?.sha256])).toEqual([
    ['Northstar', contexts[0].url, digest('%PDF-tab-0')],
    ['Eaststar', contexts[1].url, digest('%PDF-tab-1')],
  ]);
  expect(new Set(selected(h).map(event => event.sourceId)).size).toBe(2);
  expect(h.saved['context:77'].jobId).toBe('role-123');
  expect(h.saved['context:88'].jobId).toBe('role-456');
});

test('popup distinguishes a saved cloud copy, missing copy and disconnected pending save', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.route('http://127.0.0.1:5173/extension-popup-fixture/**', route => {
    const filename = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (!['popup.html', 'popup.css', 'popup.js'].includes(filename)) return route.abort();
    return route.fulfill({ contentType: filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(resolve('extension', filename), 'utf8') });
  });
  await page.addInitScript(() => {
    const state = window as any;
    state.__popupState = { ok: true, paired: true, connected: true, session: { id: 'session-popup', browserEnabled: true }, pendingCaptures: 0, captureError: null,
      captureStatus: { state: 'saved', detail: 'The file copy is saved in your account.', recent: [{ id: 'one', name: 'Résumé_Product_Designer_Version_2026_With_A_Long_Filename.pdf', state: 'saved', detail: 'The file copy is saved in your account.' }] } };
    state.chrome = { runtime: { sendMessage: async () => state.__popupState }, permissions: { request: async () => true }, tabs: { create: () => {} } };
  });
  await page.goto('/extension-popup-fixture/popup.html');
  await expect(page.locator('#capture-heading')).toHaveText('Saved');
  await expect(page.locator('#capture-recent')).toContainText('Résumé_Product_Designer');
  await expect(page.locator('#capture-retry')).toBeHidden();
  expect(await page.locator('#capture-notice').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('capture-popup.png'), fullPage: true });
  await page.evaluate(() => {
    const state = (window as any).__popupState;
    state.captureStatus.state = 'attention'; state.captureStatus.detail = 'File details were saved, but the copy is missing. Select the same file again to save it.';
    state.captureStatus.recent[0].state = 'attention'; state.captureStatus.recent[0].detail = state.captureStatus.detail;
  });
  await expect(page.locator('#capture-heading')).toHaveText('Needs attention', { timeout: 5000 });
  await expect(page.locator('#capture-notice')).toHaveAttribute('role', 'alert');
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).__popupState;
    state.connected = false; state.session = null; state.pendingCaptures = 1; state.connectionError = 'Open Apply to reconnect.';
    state.captureStatus.state = 'saving'; state.captureStatus.detail = 'Waiting for Apply to reconnect.';
  });
  await expect(page.locator('#status')).toHaveText('Connection unavailable', { timeout: 5000 });
  await expect(page.locator('#capture-heading')).toHaveText('Saving');
  await expect(page.getByRole('button', { name: 'Start browser tracking' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check saves' })).toBeVisible();
});

test('new successful captures never erase older unresolved failures from the bounded history', async ({ page }) => {
  const h = await setup(page);
  const context = { company: 'Northstar', role: 'Product Designer', url: page.url(), jobId: 'role-123' };
  await h.send({ type: 'document-detected', sessionId: h.session.id, context, eventId: 'older-interrupted',
    document: { kind: 'resume', name: 'missing.pdf', size: 10, mimeType: 'application/pdf', lastModified: 0, sha256: null } });
  h.restartWorker();
  expect((await h.popup({ type: 'state' })).captureStatus.state).toBe('attention');
  for (let index = 0; index < 10; index++) {
    await h.send({ type: 'event', sessionId: h.session.id, event: { ...context, kind: 'submission_pending', eventId: `new-capture-${index}`, documents: [] } });
  }
  await expect.poll(() => h.posted.length).toBe(10);
  const result = await h.popup({ type: 'state' });
  expect(result.captureStatus.recent.length).toBeLessThanOrEqual(8);
  expect(result.captureStatus.state).toBe('attention');
  expect(result.captureStatus.detail).toContain('Earlier captures need attention');
  expect(h.local['capture-interruption-v1'].attention).toBe(true);
});

test('transient outages retain the original copy beyond five failures and expire even while disconnected', async ({ page }) => {
  const h = await setup(page);
  h.failEvents(6);
  await select(page, '#resume-upload', '%PDF-long-outage');
  await expect.poll(() => h.saved['capture-journal-v1']?.pending[0]?.attempts).toBe(1);
  for (let attempts = 2; attempts <= 6; attempts++) {
    h.advanceTime(15_000);
    await h.popup({ type: 'retry-captures' });
    await expect.poll(() => h.saved['capture-journal-v1']?.pending[0]?.attempts).toBe(attempts);
  }
  expect((await h.popup({ type: 'state' })).pendingCaptures).toBe(1);
  await h.popup({ type: 'retry-captures' });
  await expect.poll(() => selected(h).length).toBe(1);
  expect(selected(h)[0].document?.contentBase64).toBe(Buffer.from('%PDF-long-outage').toString('base64'));
  expect(new Set(h.attempts.map(event => event.sourceId)).size).toBe(1);
  h.failEvents(1);
  await select(page, '#resume-upload', '%PDF-expired-offline');
  await expect.poll(() => h.saved['capture-journal-v1']?.pending[0]?.attempts).toBe(1);
  h.setOffline(true); h.advanceTime(5 * 60_000 + 1);
  await h.popup({ type: 'retry-captures' });
  await expect.poll(() => h.saved['capture-journal-v1']?.pending.length).toBe(0);
  const expired = await h.popup({ type: 'state' });
  expect(expired.connected).toBe(false);
  expect(expired.captureStatus.state).toBe('attention');
  expect(expired.captureStatus.detail).toContain('expired');
  expect(JSON.stringify(h.saved)).not.toContain('contentBase64');
});

test('a delayed sign-out response from the old account cannot clear the new account’s captures', async ({ page }) => {
  const h = await setup(page);
  const release = h.holdNextSession();
  const oldState = h.popup({ type: 'state' });
  await expect.poll(() => h.sessionIsHeld()).toBe(true);
  const paired = await h.popup({ type: 'pair', token: 'new-account-pairing-token' });
  expect(paired.ok).toBe(true);
  await select(page, '#resume-upload', '%PDF-new-account', { name: 'new-account.pdf' });
  await expect.poll(() => selected(h).length).toBe(1);
  release(401); await oldState;
  const result = await h.popup({ type: 'state' });
  expect(result.captureStatus.state).toBe('saved');
  expect(result.captureStatus.recent[0].name).toBe('new-account.pdf');
  expect(result.captureError).toBeNull();
  expect(h.saved['capture-journal-v1'].owner).toBe(digest('new-account-pairing-token'));
});
