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
const JOURNAL_KEY = 'capture-journal-v1';
const INTERRUPTION_KEY = 'capture-interruption-v1';
const MAX_PENDING = 40;
const MAX_RECENT = 8;
const MAX_AGE = 5 * 60 * 1000;
const captureQueue = [];
const delivered = new Set();
const pageOperations = new Map();
const recentCaptures = [];
const preparingCaptures = new Map();
let flushing = false;
let retryTimer;
let cachedState = null;
let cachedStateAt = 0;
let knownSessionId;
let lastCaptureError = '';
let retryMessage = '';
let olderCaptureIssue = false;
let captureOwner = '';
let captureEpoch = 0;
let persistence = Promise.resolve();

async function tokenFingerprint(token) {
  if (!token) return '';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function withoutFileBytes(event) {
  const clean = { ...event };
  if (event.document) { const { contentBase64: _bytes, ...document } = event.document; clean.document = document; }
  return clean;
}
function documentIdentity(event) {
  const file = event.document;
  return file?.sha256 ? `${event.url}:${file.kind}:${file.name}:${file.sha256}` : null;
}
function captureLabel(event) {
  if (event.kind === 'document_selected') return event.document.kind === 'resume' ? 'Résumé' : 'Cover letter';
  if (event.kind === 'document_removed') return 'Document removed';
  return event.kind === 'submission_confirmed' ? 'Submission confirmation' : 'Submit action';
}
function setCaptureRecord(item, state, detail) {
  const previous = recentCaptures.findIndex(record => record.id === item.event.sourceId);
  if (previous >= 0) recentCaptures.splice(previous, 1);
  recentCaptures.unshift({ id: item.event.sourceId, sessionId: item.sessionId, title: captureLabel(item.event),
    name: item.event.document?.name || `${item.event.company} · ${item.event.role}`,
    state, detail, documentIdentity: documentIdentity(item.event), updatedAt: Date.now() });
  if (recentCaptures.splice(MAX_RECENT).some(record => record.state === 'attention')) olderCaptureIssue = true;
}
function captureStatus() {
  const issues = recentCaptures.filter(record => record.state === 'attention').length + (lastCaptureError ? 1 : 0) + (olderCaptureIssue ? 1 : 0);
  const latest = recentCaptures[0];
  const state = issues ? 'attention' : captureQueue.length ? 'saving' : preparingCaptures.size ? 'detected' : latest?.state || 'idle';
  return { state, pending: captureQueue.length + preparingCaptures.size, issues,
    detail: lastCaptureError || (issues ? recentCaptures.find(record => record.state === 'attention')?.detail : retryMessage) ||
      (olderCaptureIssue ? 'Earlier captures need attention. Check your applications and any missing file copies.' : '') ||
      (captureQueue.length ? 'Keep tracking on while captures save.' : preparingCaptures.size ? 'Identifying the selected file before saving.' : latest?.detail) || 'No captures in this session yet.',
    recent: recentCaptures.map(({ documentIdentity: _identity, sessionId: _sessionId, ...record }) => record) };
}
function updateBadge() {
  const status = captureStatus();
  const text = status.issues ? '!' : status.pending ? String(status.pending) : '';
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color: status.issues ? '#9b4b00' : '#242424' });
  void chrome.action.setTitle({ title: status.state === 'idle' ? 'Apply Companion' : `Apply: ${status.detail}` });
}
function persistCaptures() {
  const pending = captureQueue.map(({ event, sessionId, attempts, createdAt, copyExpected }) => ({
    event: withoutFileBytes(event), sessionId, attempts, createdAt, copyExpected,
  }));
  const journal = { version: 1, owner: captureOwner, pending, preparing: [...preparingCaptures.values()], delivered: [...delivered], recent: [...recentCaptures], lastCaptureError, olderCaptureIssue };
  // Only this count-only marker is written to disk. File names, job details and
  // file bytes never enter persistent extension storage.
  const marker = { owner: captureOwner, pending: pending.length + preparingCaptures.size, attention: captureStatus().issues > 0, updatedAt: Date.now() };
  const operation = persistence.catch(() => {}).then(async () => {
    await chrome.storage.session.set({ [JOURNAL_KEY]: journal });
    if (marker.pending || marker.attention) await chrome.storage.local.set({ [INTERRUPTION_KEY]: marker });
    else await chrome.storage.local.remove(INTERRUPTION_KEY);
  });
  persistence = operation;
  return operation;
}
function rememberCaptureState() {
  void persistCaptures().catch(() => {
    lastCaptureError = 'Capture recovery could not be recorded. Keep this browser open and check saved documents.';
    updateBadge();
  });
}
function captureFailure(message) {
  lastCaptureError = String(message).slice(0, 240); updateBadge(); rememberCaptureState();
}
async function resetCaptures(owner) {
  captureEpoch++;
  clearTimeout(retryTimer);
  captureQueue.splice(0); preparingCaptures.clear(); delivered.clear(); recentCaptures.splice(0);
  cachedState = null; cachedStateAt = 0; knownSessionId = undefined;
  lastCaptureError = ''; retryMessage = ''; olderCaptureIssue = false; captureOwner = owner;
  const stored = await chrome.storage.session.get(null);
  const contexts = Object.keys(stored).filter(key => key.startsWith('context:'));
  if (contexts.length) await chrome.storage.session.remove(contexts);
  await persistCaptures(); updateBadge();
}
async function restoreCaptures() {
  const [local, stored] = await Promise.all([
    chrome.storage.local.get(['token', INTERRUPTION_KEY]), chrome.storage.session.get(JOURNAL_KEY),
  ]);
  captureOwner = await tokenFingerprint(local.token);
  const journal = stored[JOURNAL_KEY];
  const marker = local[INTERRUPTION_KEY];
  if (captureOwner && journal?.version === 1 && journal.owner === captureOwner) {
    for (const id of (Array.isArray(journal.delivered) ? journal.delivered : []).slice(-200)) if (typeof id === 'string') delivered.add(id);
    for (const record of (Array.isArray(journal.recent) ? journal.recent : []).slice(0, MAX_RECENT)) {
      if (typeof record?.id === 'string' && ['detected', 'saving', 'saved', 'attention'].includes(record.state)) recentCaptures.push(record);
    }
    for (const item of (Array.isArray(journal.preparing) ? journal.preparing : []).slice(0, MAX_PENDING)) {
      if (item?.event?.sourceId && item.event.document) setCaptureRecord(item, 'attention', 'File detection was interrupted. Check the application and select this file again.');
    }
    olderCaptureIssue = olderCaptureIssue || journal.olderCaptureIssue === true;
    lastCaptureError = typeof journal.lastCaptureError === 'string' ? journal.lastCaptureError.slice(0, 240) : '';
    for (const saved of (Array.isArray(journal.pending) ? journal.pending : []).slice(0, MAX_PENDING)) {
      if (!saved?.event?.sourceId || typeof saved.sessionId !== 'string' || !Number.isFinite(saved.createdAt)) continue;
      const item = { ...saved, event: withoutFileBytes(saved.event), attempts: Math.max(0, Number(saved.attempts) || 0), copyExpected: !!saved.copyExpected };
      if (Date.now() - item.createdAt > MAX_AGE) {
        setCaptureRecord(item, 'attention', 'This capture expired before it was saved. Check the application and select the file again if needed.');
        continue;
      }
      captureQueue.push(item);
      if (item.copyExpected) setCaptureRecord(item, 'attention', 'The browser restarted this capture. Its file copy needs to be checked; select the file again if it was not saved.');
    }
  } else if (captureOwner && marker?.owner === captureOwner && (marker.pending || marker.attention)) {
    lastCaptureError = marker.pending
      ? `The browser restarted with ${marker.pending} unconfirmed ${marker.pending === 1 ? 'capture' : 'captures'}. Check your applications and select any missing files again.`
      : 'A previous capture needs attention. Check your applications and select any missing files again.';
  }
  if (journal || marker) await persistCaptures();
  updateBadge();
}
const captureReady = restoreCaptures().catch(() => {
  lastCaptureError = 'Capture recovery is unavailable. Check your saved documents before applying.';
  updateBadge();
});

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
  await captureReady;
  if (delivered.has(event.sourceId)) return { queued: false, saved: true };
  preparingCaptures.delete(event.sourceId);
  const existing = captureQueue.find(item => item.event.sourceId === event.sourceId);
  if (existing) {
    if (event.document?.contentBase64 !== undefined && existing.event.document?.contentBase64 === undefined) {
      existing.event = event; existing.copyExpected = true; existing.attempts = 0;
      await persistCaptures(); void flushCaptures();
    }
    return { queued: true };
  }
  const queuedBytes = captureQueue.reduce((total, item) => total + (item.event.document?.contentBase64?.length || 0), 0);
  if (captureQueue.length + preparingCaptures.size >= MAX_PENDING || queuedBytes + (event.document?.contentBase64?.length || 0) > 32 * 1024 * 1024) throw new Error('Capture queue is full. Reconnect the Apply app before selecting another document.');
  const item = { event, sessionId, attempts: 0, createdAt: Date.now(), copyExpected: event.document?.contentBase64 !== undefined };
  captureQueue.push(item);
  setCaptureRecord(item, 'detected', event.document ? 'File detected. Waiting for the cloud save.' : 'Capture detected. Waiting to save.');
  await persistCaptures(); updateBadge();
  void flushCaptures();
  return { queued: true };
}
function savedDocument(item, response) {
  const file = item.event.document;
  return response.application?.documents?.find(document => (response.evidence?.documentId && document.id === response.evidence.documentId) ||
    (file?.sha256 && document.sha256 === file.sha256 && document.name === file.name && document.kind === file.kind));
}
function recordDelivery(item, response) {
  const document = savedDocument(item, response);
  if (item.event.kind === 'document_selected') {
    if (document?.stored) {
      const identity = documentIdentity(item.event);
      for (const record of recentCaptures) {
        if (identity && record.documentIdentity === identity && record.state === 'attention') {
          record.state = 'saved'; record.detail = 'The file copy is saved in your account.';
        }
      }
      setCaptureRecord(item, 'saved', 'The file copy is saved in your account.');
    } else if (item.copyExpected || response.evidence?.review === 'pending') {
      setCaptureRecord(item, 'attention', item.copyExpected
        ? 'File details were saved, but the copy is missing. Select the same file again to save it.'
        : 'File details need review in Apply. No file copy has been saved.');
    } else setCaptureRecord(item, 'detected', 'File details saved without a copy. Copies support PDF, DOC, DOCX and TXT files up to 10 MB.');
  } else if (response.evidence?.review === 'pending' || item.event.requiresReview) {
    setCaptureRecord(item, 'attention', 'Capture saved for review. Open the application to check it.');
  } else setCaptureRecord(item, 'saved', item.event.kind === 'submission_confirmed'
    ? 'Submission confirmation saved. Document copies have their own save status.'
    : item.event.kind === 'submission_pending' ? 'Submit action saved. Waiting for a confirmation from the job site.' : 'Document removal saved.');
}
async function flushCaptures() {
  await captureReady;
  if (flushing || !captureQueue.length) return;
  flushing = true;
  clearTimeout(retryTimer);
  try {
    while (captureQueue.length) {
      const item = captureQueue[0];
      const epoch = captureEpoch;
      try {
        if (Date.now() - item.createdAt > MAX_AGE) {
          captureQueue.shift(); setCaptureRecord(item, 'attention', 'This capture expired before it was saved. Check the application and select the file again if needed.');
          await persistCaptures(); continue;
        }
        const current = await state();
        if (captureQueue[0] !== item || epoch !== captureEpoch) continue;
        if (!current.session?.browserEnabled || current.session.id !== item.sessionId) {
          captureQueue.shift(); setCaptureRecord(item, 'attention', 'Tracking ended before this capture was saved. Check the application documents.');
          await persistCaptures(); continue;
        }
        const { token } = await chrome.storage.local.get('token');
        if (await tokenFingerprint(token) !== captureOwner || epoch !== captureEpoch) continue;
        setCaptureRecord(item, 'saving', item.copyExpected && item.event.document?.contentBase64 === undefined
          ? 'Checking the saved file after a browser interruption.' : 'Saving this capture to your account.');
        await persistCaptures(); updateBadge();
        const response = await api('/api/events', { method: 'POST', body: JSON.stringify(item.event) }, token);
        if (captureQueue[0] !== item || epoch !== captureEpoch) continue;
        // Metadata can commit before object storage. Keep the original bytes and
        // idempotency key until the private archive has also been confirmed.
        if (response.archiveError) {
          const error = new Error(String(response.archiveError)); error.status = 502; throw error;
        }
        captureQueue.shift(); delivered.add(item.event.sourceId);
        if (delivered.size > 200) delivered.delete(delivered.values().next().value);
        recordDelivery(item, response); retryMessage = '';
        await persistCaptures(); updateBadge();
      } catch (error) {
        if (captureQueue[0] !== item || epoch !== captureEpoch) continue;
        item.attempts += 1;
        const permanent = error.status >= 400 && error.status < 500 && error.status !== 429;
        if (permanent) {
          captureQueue.shift(); setCaptureRecord(item, 'attention', `Capture not saved: ${String(error.message).slice(0, 200)}`);
          await persistCaptures().catch(() => {}); updateBadge(); continue;
        }
        retryMessage = 'Captures are waiting for the Apply app. Keep tracking on while it reconnects.';
        setCaptureRecord(item, 'saving', retryMessage);
        await persistCaptures().catch(() => {}); updateBadge();
        retryTimer = setTimeout(() => { void flushCaptures(); }, Math.min(5000 * 2 ** Math.min(item.attempts - 1, 3), 30_000));
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

function stateWithCaptures(value) {
  const status = captureStatus();
  return { ...value, pendingCaptures: captureQueue.length + preparingCaptures.size, captureError: status.issues ? status.detail : retryMessage || null, captureStatus: status };
}
async function state() {
  await captureReady;
  const stored = await chrome.storage.local.get(['token']);
  const owner = await tokenFingerprint(stored.token);
  if (owner !== captureOwner) await resetCaptures(owner);
  if (!stored.token) return stateWithCaptures({ paired: false, session: null, connected: true });
  let session;
  try { ({ session } = await api('/api/sessions/current', {}, stored.token)); }
  catch (error) {
    if ([401, 403].includes(error.status) && owner === captureOwner) {
      await resetCaptures(captureOwner);
      lastCaptureError = 'Pair this extension with your signed-in Apply account to resume tracking.';
      await persistCaptures(); updateBadge();
    }
    throw error;
  }
  if (owner !== captureOwner) throw new Error('The paired account changed. Check the extension connection.');
  cachedState = { paired: true, session, connected: true }; cachedStateAt = Date.now();
  const sessionId = session?.browserEnabled && !session.stoppedAt ? session.id : null;
  if (knownSessionId !== sessionId) {
    knownSessionId = sessionId;
    const saved = await chrome.storage.session.get(null);
    const stale = Object.keys(saved).filter(key => key.startsWith('context:') && saved[key]?.sessionId !== sessionId);
    if (stale.length) await chrome.storage.session.remove(stale);
    let changed = false;
    for (let index = captureQueue.length - 1; index >= 0; index -= 1) {
      if (captureQueue[index].sessionId !== sessionId) {
        const [item] = captureQueue.splice(index, 1);
        setCaptureRecord(item, 'attention', 'Tracking ended before this capture was saved. Check the application documents.');
        changed = true;
      }
    }
    if (changed) { await persistCaptures(); updateBadge(); }
  }
  let changed = false;
  for (const [id, item] of preparingCaptures) {
    if (item.sessionId !== sessionId || Date.now() - item.createdAt > 30_000) {
      preparingCaptures.delete(id);
      setCaptureRecord(item, 'attention', 'File detection was interrupted. Check the application and select this file again.');
      changed = true;
    }
  }
  if (changed) { await persistCaptures(); updateBadge(); }
  return stateWithCaptures(cachedState);
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
chrome.runtime.onStartup.addListener(() => { void registerScripts(); void captureReady.then(() => flushCaptures()); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refresh-session') { void notifyTabs(); void flushCaptures(); }
});
chrome.tabs.onRemoved.addListener(tabId => { void chrome.storage.session.remove(`context:${tabId}`); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isPopup = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL('popup.html'));
  const isPage = Boolean(sender.tab?.id && sender.frameId === 0 && supported(sender.url || sender.tab.url || ''));
  const handle = async () => {
    await captureReady;
    if (isPage) {
      const origin = `${new URL(sender.url || sender.tab.url).origin}/*`;
      if (!await chrome.permissions.contains({ origins: [origin] })) {
        return { paired: true, session: null, context: null, ignored: true };
      }
    }
    if (message.type === 'state' && (isPopup || isPage)) {
      try { return await state(); }
      catch (error) {
        if (!isPopup) throw error;
        return stateWithCaptures({ paired: !!captureOwner, session: null, connected: false, connectionError: error.message });
      }
    }
    if (message.type === 'retry-captures' && isPopup) { void flushCaptures(); return state(); }
    if (message.type === 'dismiss-capture-error' && isPopup) {
      if (!captureQueue.length && !preparingCaptures.size) {
        lastCaptureError = ''; retryMessage = ''; olderCaptureIssue = false;
        for (let index = recentCaptures.length - 1; index >= 0; index--) if (recentCaptures[index].state === 'attention') recentCaptures.splice(index, 1);
        await persistCaptures(); updateBadge();
      }
      return state();
    }
    if (message.type === 'capture-error' && isPage) { captureFailure(message.message || 'A capture could not be saved.'); return {}; }
    if (message.type === 'pair' && isPopup) {
      const token = String(message.token || '').trim();
      if (token.length < 16 || token.length > 300) throw new Error('Enter a valid pairing token.');
      await api('/api/sessions/current', {}, token);
      await chrome.storage.local.set({ token });
      await resetCaptures(await tokenFingerprint(token));
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
    if (message.type === 'document-detected' && isPage) {
      const current = await captureState();
      if (!current.session?.browserEnabled || message.sessionId !== current.session.id) return { ignored: true };
      const context = cleanContext(message.context, sender);
      const document = cleanDocument(message.document);
      const eventId = identifier(message.eventId);
      const sourceId = `browser:${current.session.id}:${context.url.slice(0, 650)}:document_selected:${eventId}`;
      if (!preparingCaptures.has(sourceId) && captureQueue.length + preparingCaptures.size >= MAX_PENDING) throw new Error('Capture queue is full. Reconnect Apply before selecting another document.');
      const item = { event: { ...context, kind: 'document_selected', document, sourceId }, sessionId: current.session.id, createdAt: Date.now() };
      preparingCaptures.set(sourceId, item);
      setCaptureRecord(item, 'detected', 'File detected. Identifying its exact version before saving.');
      await persistCaptures(); updateBadge();
      return { detected: true };
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
    if (message.type === 'open-dashboard' && isPopup) {
      const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) })
        .catch(() => { throw new Error('Open the Apply desktop app to use your dashboard.'); });
      if (!response.ok) throw new Error('The Apply app could not be reached.');
      const health = await response.json();
      const url = new URL(health.dashboardUrl || 'http://localhost:5173');
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['4318', '5173'].includes(url.port) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('The dashboard address is invalid. Open Apply directly.');
      await chrome.tabs.create({ url: url.href });
      return {};
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
    if (isPage && ['event', 'document-state', 'document-detected'].includes(message.type)) captureFailure(error.message);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

// Worker wake-up can happen without a popup or alarm. Resume metadata delivery
// after restoring the journal; account and tracking checks still run per item.
void captureReady.then(() => { if (captureQueue.length) void flushCaptures(); });
