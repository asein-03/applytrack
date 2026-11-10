const API = 'http://127.0.0.1:4318';
const ORIGINS = [
  'https://boards.greenhouse.io/*', 'https://job-boards.greenhouse.io/*',
  'https://boards.eu.greenhouse.io/*', 'https://jobs.lever.co/*',
  'https://jobs.eu.lever.co/*', 'https://jobs.ashbyhq.com/*',
];
const supported = url => {
  try { return ORIGINS.some(origin => new URL(origin.replace('/*', '/')).hostname === new URL(url).hostname); }
  catch { return false; }
};
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const MAX_METADATA_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const ARCHIVE_TYPES = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };
const captureQueue = [];
const delivered = new Set();
const pageOperations = new Map();
let flushing = false;
let retryTimer;
let cachedState = null;
let cachedStateAt = 0;
let knownSessionId;
let lastCaptureError = '';
let retryMessage = '';

function updateBadge() {
  const error = lastCaptureError || retryMessage;
  const text = error ? '!' : captureQueue.length ? String(captureQueue.length) : '';
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color: error ? '#9b4b00' : '#242424' });
  void chrome.action.setTitle({ title: error ? `Apply: ${error}` : captureQueue.length ? `Apply: ${captureQueue.length} captures waiting to save` : 'Apply Companion' });
}
function captureFailure(message) { lastCaptureError = String(message).slice(0, 240); updateBadge(); }
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{6,100}$/.test(value)) throw new Error('Capture identity is invalid.');
  return value;
}
function cleanDocument(value, withContent = false) {
  if (!value || !['resume', 'cover_letter'].includes(value.kind) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 500 || /[\u0000-\u001f]/.test(value.name)) throw new Error('Document metadata is invalid.');
  if (!Number.isInteger(value.size) || value.size < 0 || value.size > MAX_METADATA_BYTES || !Number.isInteger(value.lastModified) || value.lastModified < 0) throw new Error('Document exceeds the capture limits.');
  if (typeof value.mimeType !== 'string' || value.mimeType.length > 200 || /[\u0000-\u001f]/.test(value.mimeType)) throw new Error('Document type is invalid.');
  if (value.sha256 !== null && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256))) throw new Error('Document fingerprint is invalid.');
  const result = { kind: value.kind, name: value.name, size: value.size, mimeType: value.mimeType.toLowerCase(), lastModified: value.lastModified, sha256: value.sha256 };
  if (withContent && value.contentBase64 !== undefined) {
    const type = ARCHIVE_TYPES[value.name.split('.').at(-1)?.toLowerCase()];
    if (!type || !['', type, 'application/octet-stream'].includes(result.mimeType) || value.size > MAX_ARCHIVE_BYTES || !value.sha256) throw new Error('Only PDF, DOC, DOCX and TXT documents up to 10 MB can be archived.');
    const content = value.contentBase64;
    if (typeof content !== 'string' || content.length > Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('Document copy is invalid.');
    const decodedSize = content.length / 4 * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
    if (decodedSize !== value.size) throw new Error('Document copy does not match its size.');
    result.contentBase64 = content;
  }
  return result;
}
function cleanDocuments(values) {
  if (!Array.isArray(values) || values.length > 2) throw new Error('A submission can contain one resume and one cover letter.');
  const result = values.map(value => cleanDocument(value));
  if (new Set(result.map(value => value.kind)).size !== result.length) throw new Error('Duplicate document kinds are not supported.');
  return result;
}
function cleanDocumentState(value, previous) {
  if (!value || !Array.isArray(value.selected) || value.selected.length > 2) throw new Error('Document selection state is invalid.');
  const selected = value.selected.map(entry => ({ selectionId: identifier(entry.selectionId), document: cleanDocument(entry.document) }));
  cleanDocuments(selected.map(entry => entry.document));
  return {
    selected,
    pending: value.pending ? { attemptId: identifier(value.pending.attemptId), documents: cleanDocuments(value.pending.documents) } : null,
    confirmedAttemptId: value.confirmedAttemptId ? identifier(value.confirmedAttemptId) : previous?.confirmedAttemptId || null,
  };
}
function cleanContext(value, sender) {
  if (typeof value?.company !== 'string' || !value.company.trim() || typeof value.role !== 'string' || !value.role.trim()) throw new Error('Company and role are required to identify this job.');
  const url = new URL(String(value.url));
  if (!supported(url.href) || url.origin !== new URL(sender.url || sender.tab.url).origin) throw new Error('Job context does not match this page.');
  return { company: value.company.slice(0, 200), role: value.role.slice(0, 300), url: url.href, jobId: String(value.jobId || '').slice(0, 200), description: String(value.description || '').slice(0, 15000), location: String(value.location || '').slice(0, 300) };
}
async function rememberContext(sender, current, value, documentState) {
  const context = cleanContext(value, sender);
  const key = `context:${sender.tab.id}`;
  const previous = (await chrome.storage.session.get(key))[key];
  const sameJob = previous?.sessionId === current.session.id && previous?.url === context.url;
  const saved = { ...context, hostname: new URL(sender.url || sender.tab.url).hostname, sessionId: current.session.id, savedAt: Date.now(),
    documentState: documentState ? cleanDocumentState(documentState, sameJob ? previous.documentState : null) : sameJob ? previous.documentState : { selected: [], pending: null, confirmedAttemptId: null },
  };
  await chrome.storage.session.set({ [key]: saved });
  return saved;
}
async function queueCapture(event, sessionId) {
  if (delivered.has(event.sourceId)) return { queued: false, saved: true };
  if (captureQueue.some(item => item.event.sourceId === event.sourceId)) return { queued: true };
  const queuedBytes = captureQueue.reduce((total, item) => total + (item.event.document?.contentBase64?.length || 0), 0);
  if (captureQueue.length >= 40 || queuedBytes + (event.document?.contentBase64?.length || 0) > 32 * 1024 * 1024) throw new Error('Capture queue is full. Reconnect the local app before selecting another document.');
  captureQueue.push({ event, sessionId, attempts: 0, createdAt: Date.now() });
  updateBadge();
  void flushCaptures();
  return { queued: true };
}
async function flushCaptures() {
  if (flushing || !captureQueue.length) return;
  flushing = true;
  clearTimeout(retryTimer);
  try {
    while (captureQueue.length) {
      const item = captureQueue[0];
      try {
        const current = await state();
        if (captureQueue[0] !== item) continue;
        if (!current.session?.browserEnabled || current.session.id !== item.sessionId) {
          captureQueue.shift(); captureFailure('An unsaved capture was discarded because its tracking session ended.'); continue;
        }
        if (Date.now() - item.createdAt > 5 * 60 * 1000) { captureQueue.shift(); captureFailure('A capture could not be saved. Re-select the document with the local app connected.'); continue; }
        await api('/api/events', { method: 'POST', body: JSON.stringify(item.event) });
        captureQueue.shift(); delivered.add(item.event.sourceId);
        if (delivered.size > 200) delivered.delete(delivered.values().next().value);
        retryMessage = ''; updateBadge();
      } catch (error) {
        item.attempts += 1;
        const permanent = error.status >= 400 && error.status < 500 && error.status !== 429;
        if (permanent || item.attempts >= 5) {
          captureQueue.shift(); captureFailure(`Capture not saved: ${error.message}`); continue;
        }
        retryMessage = 'Captures are waiting for the local app. Keep tracking on while it reconnects.'; updateBadge();
        retryTimer = setTimeout(() => { void flushCaptures(); }, 5000);
        break;
      }
    }
  } finally { flushing = false; updateBadge(); }
}


async function api(path, init = {}, tokenOverride) {
  const stored = await chrome.storage.local.get('token');
  const token = tokenOverride || stored.token;
  if (!token) throw new Error('Copy the pairing token from Connections in Apply.');
  const response = await fetch(`${API}${path}`, {
    ...init, signal: AbortSignal.timeout(10_000),
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  }).catch(() => { throw new Error('Start the local Apply app to connect.'); });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || `The tracker returned ${response.status}.`); error.status = response.status; throw error; }
  return body;
}

async function registerScripts() {
  const permissions = await chrome.permissions.getAll();
  const matches = ORIGINS.filter(origin => permissions.origins?.includes(origin));
  await chrome.scripting.unregisterContentScripts().catch(() => {});
  if (matches.length) {
    await chrome.scripting.registerContentScripts([{
      id: 'apply-job-tracker', matches, js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true,
    }]);
    const tabs = await chrome.tabs.query({ url: matches });
    await Promise.allSettled(tabs.filter(tab => tab.id).map(tab =>
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })));
  }
}

async function state() {
  const stored = await chrome.storage.local.get(['token']);
  if (!stored.token) return { paired: false, session: null };
  const { session } = await api('/api/sessions/current');
  cachedState = { paired: true, session }; cachedStateAt = Date.now();
  const sessionId = session?.browserEnabled && !session.stoppedAt ? session.id : null;
  if (knownSessionId !== sessionId) {
    knownSessionId = sessionId;
    const saved = await chrome.storage.session.get(null);
    const stale = Object.keys(saved).filter(key => key.startsWith('context:') && saved[key]?.sessionId !== sessionId);
    if (stale.length) await chrome.storage.session.remove(stale);
    const discarded = captureQueue.filter(item => item.sessionId !== sessionId).length;
    for (let index = captureQueue.length - 1; index >= 0; index -= 1) if (captureQueue[index].sessionId !== sessionId) captureQueue.splice(index, 1);
    if (discarded) captureFailure('Tracking ended before some captures were saved. Check the application documents.');
  }
  return { ...cachedState, pendingCaptures: captureQueue.length, captureError: lastCaptureError || retryMessage || null };
}
async function captureState() {
  try { return await state(); }
  catch (error) {
    if (cachedState?.session?.browserEnabled && Date.now() - cachedStateAt < 20_000) return cachedState;
    throw error;
  }
}

async function notifyTabs() {
  const tabs = await chrome.tabs.query({ url: ORIGINS });
  await Promise.allSettled(tabs.filter(tab => tab.id).map(tab => chrome.tabs.sendMessage(tab.id, { type: 'refresh' })));
}

chrome.permissions.onAdded.addListener(() => { void registerScripts(); });
chrome.permissions.onRemoved.addListener(() => { void registerScripts(); });
chrome.runtime.onInstalled.addListener(() => {
  void registerScripts();
  chrome.alarms.create('refresh-session', { periodInMinutes: 0.5 });
});
chrome.runtime.onStartup.addListener(() => { void registerScripts(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refresh-session') { void notifyTabs(); void flushCaptures(); }
});
chrome.tabs.onRemoved.addListener(tabId => { void chrome.storage.session.remove(`context:${tabId}`); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isPopup = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL('popup.html'));
  const isPage = Boolean(sender.tab?.id && sender.frameId === 0 && supported(sender.url || sender.tab.url || ''));
  const handle = async () => {
    if (isPage) {
      const origin = `${new URL(sender.url || sender.tab.url).origin}/*`;
      if (!await chrome.permissions.contains({ origins: [origin] })) {
        return { paired: true, session: null, context: null, ignored: true };
      }
    }
    if (message.type === 'state' && (isPopup || isPage)) return state();
    if (message.type === 'retry-captures' && isPopup) { void flushCaptures(); return state(); }
    if (message.type === 'dismiss-capture-error' && isPopup) {
      if (!captureQueue.length) { lastCaptureError = ''; retryMessage = ''; updateBadge(); }
      return state();
    }
    if (message.type === 'capture-error' && isPage) { captureFailure(message.message || 'A capture could not be saved.'); return {}; }
    if (message.type === 'pair' && isPopup) {
      const token = String(message.token || '').trim();
      if (token.length < 16 || token.length > 300) throw new Error('Enter a valid pairing token.');
      await api('/api/sessions/current', {}, token);
      await chrome.storage.local.set({ token });
      return state();
    }
    if (message.type === 'start' && isPopup) {
      await registerScripts();
      const current = await state();
      const session = await api('/api/sessions', {
        method: 'POST', body: JSON.stringify({ browserEnabled: true, screenEnabled: Boolean(current.session?.screenEnabled) }),
      });
      await notifyTabs();
      return { session };
    }
    if (message.type === 'stop' && isPopup) {
      const current = await state();
      if (current.session?.screenEnabled) {
        await api('/api/sessions', { method: 'POST', body: JSON.stringify({ browserEnabled: false, screenEnabled: true }) });
      } else await api('/api/sessions/current', { method: 'DELETE' });
      await notifyTabs();
      return state();
    }
    if ((message.type === 'remember' || message.type === 'document-state') && isPage) {
      const current = await captureState();
      if (!current.session?.browserEnabled || (message.sessionId && message.sessionId !== current.session.id)) return { ignored: true };
      const saved = await rememberContext(sender, current, message.context, message.type === 'document-state' ? message.documentState : undefined);
      return { remembered: true, documentState: saved.documentState };
    }
    if (message.type === 'context' && isPage) {
      const current = await state();
      const key = `context:${sender.tab.id}`;
      const stored = (await chrome.storage.session.get(key))[key];
      if (!stored || stored.sessionId !== current.session?.id || Date.now() - stored.savedAt > 30 * 60 * 1000 ||
        stored.hostname !== new URL(sender.url || sender.tab.url).hostname) return { context: null };
      const currentUrl = new URL(sender.url || sender.tab.url);
      const pathParts = currentUrl.pathname.split('/').filter(Boolean);
      if (!stored.jobId || (!pathParts.includes(stored.jobId) && currentUrl.searchParams.get('gh_jid') !== stored.jobId)) {
        return { context: null };
      }
      return { context: stored };
    }
    if (message.type === 'event' && isPage) {
      const current = await captureState();
      if (!current.session?.browserEnabled || current.session.stoppedAt || (message.sessionId && message.sessionId !== current.session.id)) return { ignored: true };
      const event = message.event;
      if (!['submission_pending', 'submission_confirmed', 'document_selected', 'document_removed'].includes(event?.kind)) throw new Error('Unsupported capture event.');
      const context = cleanContext(event, sender);
      const eventId = event.eventId ? identifier(event.eventId) : 'legacy';
      const titles = { submission_pending: 'Application submit button clicked', submission_confirmed: 'Submission confirmation found on the page', document_selected: 'Application document selected', document_removed: 'Application document removed' };
      const cleanEvent = {
        ...context, source: 'browser', workspace: 'personal', kind: event.kind,
        summary: titles[event.kind], excerpt: String(event.excerpt || '').slice(0, 1000),
        observedAt: typeof event.observedAt === 'string' && Number.isFinite(Date.parse(event.observedAt)) ? new Date(event.observedAt).toISOString() : new Date().toISOString(),
        sourceId: `browser:${current.session.id}:${context.url.slice(0, 650)}:${event.kind}:${eventId}`,
        requiresReview: Boolean(event.requiresReview),
      };
      if (event.kind === 'document_selected' || event.kind === 'document_removed') {
        cleanEvent.document = cleanDocument(event.document, event.kind === 'document_selected');
      } else if (event.documents !== undefined) cleanEvent.documents = cleanDocuments(event.documents);
      return queueCapture(cleanEvent, current.session.id);
    }
    if (message.type === 'save-current' && isPopup) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a job posting first.');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      const extracted = await chrome.tabs.sendMessage(tab.id, { type: 'extract' });
      if (!extracted?.company || !extracted?.role) throw new Error('Could not identify this job. Add it from the dashboard instead.');
      return api('/api/events', { method: 'POST', body: JSON.stringify({
        ...extracted, source: 'manual', workspace: 'personal', kind: 'note',
        summary: 'Job saved from the browser',
        sourceId: `saved:${extracted.url}`,
      }) });
    }
    throw new Error('This action is unavailable.');
  };
  // Preserve the order in which one page selected, replaced and submitted files,
  // even when session requests finish at different times. Only metadata is stored.
  const previous = isPage ? pageOperations.get(sender.tab.id) : null;
  const operation = previous ? previous.catch(() => {}).then(handle) : handle();
  if (isPage) {
    pageOperations.set(sender.tab.id, operation);
    void operation.finally(() => {
      if (pageOperations.get(sender.tab.id) === operation) pageOperations.delete(sender.tab.id);
    }).catch(() => {});
  }
  operation.then(value => sendResponse({ ok: true, ...value })).catch(error => {
    if (isPage && ['event', 'document-state'].includes(message.type)) captureFailure(error.message);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});
