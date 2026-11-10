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

async function api(path, init = {}, tokenOverride) {
  const stored = await chrome.storage.local.get('token');
  const token = tokenOverride || stored.token;
  if (!token) throw new Error('Copy the pairing token from Connections in Apply.');
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  }).catch(() => { throw new Error('Start the local Apply app to connect.'); });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `The tracker returned ${response.status}.`);
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
  return { paired: true, session };
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
  if (alarm.name === 'refresh-session') void notifyTabs();
});
chrome.tabs.onRemoved.addListener(tabId => { void chrome.storage.session.remove(`context:${tabId}`); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isPopup = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL('popup.html'));
  const isPage = Boolean(sender.tab?.id && supported(sender.url || sender.tab.url || ''));
  const handle = async () => {
    if (isPage) {
      const origin = `${new URL(sender.url || sender.tab.url).origin}/*`;
      if (!await chrome.permissions.contains({ origins: [origin] })) {
        return { paired: true, session: null, context: null, ignored: true };
      }
    }
    if (message.type === 'state' && (isPopup || isPage)) return state();
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
    if (message.type === 'remember' && isPage) {
      const current = await state();
      if (!current.session?.browserEnabled) return { ignored: true };
      const context = message.context;
      if (typeof context?.company !== 'string' || typeof context?.role !== 'string') return { ignored: true };
      await chrome.storage.session.set({ [`context:${sender.tab.id}`]: {
        company: context.company.slice(0, 200), role: context.role.slice(0, 300),
        url: context.url, jobId: context.jobId, description: String(context.description || '').slice(0, 15000),
        location: String(context.location || '').slice(0, 300),
        hostname: new URL(sender.url || sender.tab.url).hostname,
        sessionId: current.session.id, savedAt: Date.now(),
      } });
      return { remembered: true };
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
      const current = await state();
      if (!current.session?.browserEnabled || current.session.stoppedAt) return { ignored: true };
      const event = message.event;
      if (!['submission_pending', 'submission_confirmed'].includes(event?.kind)) throw new Error('Unsupported capture event.');
      const cleanEvent = {
        company: String(event.company || '').slice(0, 200), role: String(event.role || '').slice(0, 300),
        url: String(event.url || sender.url || '').slice(0, 2000), jobId: String(event.jobId || '').slice(0, 200),
        description: String(event.description || '').slice(0, 15000), location: String(event.location || '').slice(0, 300),
        source: 'browser', workspace: 'personal', kind: event.kind,
        summary: event.kind === 'submission_pending' ? 'Application submit button clicked' : 'Submission confirmation found on the page',
        excerpt: String(event.excerpt || '').slice(0, 1000), observedAt: new Date().toISOString(),
        sourceId: `browser:${current.session.id}:${String(event.url).slice(0, 800)}:${event.kind}`,
        requiresReview: Boolean(event.requiresReview),
      };
      if (!cleanEvent.company || !cleanEvent.role) throw new Error('Company and role are required to identify this application.');
      return api('/api/events', { method: 'POST', body: JSON.stringify(cleanEvent) });
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
  handle().then(value => sendResponse({ ok: true, ...value })).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
