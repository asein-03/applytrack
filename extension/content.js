(() => {
  if (globalThis.__applyCompanionLoaded) return;
  globalThis.__applyCompanionLoaded = true;
  const SUPPORTED = /^(boards(?:\.eu)?\.greenhouse\.io|job-boards\.greenhouse\.io|jobs(?:\.eu)?\.lever\.co|jobs\.ashbyhq\.com)$/;
  const supported = window === window.top && SUPPORTED.test(location.hostname);
  const SUCCESS = [
    /your application (?:has been |was )?(?:successfully )?(?:submitted|received)/i,
    /we(?:'ve| have) received your application/i,
    /thank you for (?:your application|applying)/i,
    /application submitted successfully/i,
  ];
  const FAILURE = /(?:application|submission)[^.!\n]{0,45}(?:failed|not (?:been )?submitted|could not be submitted)|unable to submit (?:your )?application/i;
  const CONDITIONAL = /\b(?:if|once|when|after|until|unless|before|whether)\b[^.!?\n]{0,120}(?:your application|we(?:'ve| have) received|thank you for applying|application submitted)/i;
  let session = null;
  let context = null;
  let refreshAt = 0;
  let checking = false;
  let pendingTimer;
  const sent = new Set();
  const MAX_METADATA_BYTES = 25 * 1024 * 1024;
  const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
  const ALLOWED_TYPES = {
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain',
  };
  let activeKey = '';
  let selections = new Map();
  let inputs = new WeakMap();
  let pendingSubmission = null;
  let operations = Promise.resolve();
  let lastClickSubmit = null;
  const nonce = () => crypto.randomUUID();
  const metadata = value => ({ kind: value.kind, name: value.name, size: value.size, mimeType: value.mimeType, lastModified: value.lastModified, sha256: value.sha256 });
  const report = message => {
    console.warn('Apply Companion:', message);
    void chrome.runtime.sendMessage({ type: 'capture-error', message }).catch(() => {});
  };
  const request = async payload => {
    const result = await chrome.runtime.sendMessage(payload);
    if (!result?.ok) throw new Error(result?.error || 'Apply is unavailable.');
    return result;
  };
  const clean = (value, max = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const text = selectors => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = clean(node?.textContent);
      if (value) return value;
    }
    return '';
  };
  const canonicalUrl = () => {
    const url = new URL(location.href);
    url.hash = '';
    const jobId = url.searchParams.get('gh_jid');
    url.search = jobId ? `?gh_jid=${encodeURIComponent(jobId)}` : '';
    url.pathname = url.pathname.replace(/\/(?:apply|application|thank-you|thank_you|confirmation|success)\/?$/, '').replace(/\/$/, '');
    return url.href;
  };
  const jobPosting = () => {
    const search = value => {
      if (!value || typeof value !== 'object') return null;
      if (Array.isArray(value)) return value.map(search).find(Boolean) || null;
      if (value['@type'] === 'JobPosting' || value['@type']?.includes?.('JobPosting')) return value;
      return value['@graph'] ? search(value['@graph']) : null;
    };
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { const job = search(JSON.parse(node.textContent)); if (job) return job; } catch {}
    }
    return null;
  };
  const fromHtml = value => {
    const document = new DOMParser().parseFromString(String(value || ''), 'text/html');
    return clean(document.body.textContent, 15000);
  };
  function extract() {
    const job = jobPosting();
    const title = clean(job?.title) || text(['.posting-headline h2', '.ashby-job-posting-heading', '[data-testid="job-title"]', '.app-title', 'h1']);
    let company = clean(job?.hiringOrganization?.name) || text(['.company-name', '[data-testid="company-name"]', '.ashby-job-posting-company-name']);
    if (!company) {
      const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title;
      const at = metaTitle.match(/(?:Job Application for )?(.+?) at (.+?)(?:\s*\|.*)?$/i);
      if (at) company = clean(at[2]);
      const lever = metaTitle.match(/^(.+?)\s+[-–|]\s+(.+)$/);
      if (!company && lever && /lever/.test(location.hostname)) company = clean(lever[1]);
      const ashby = metaTitle.match(/^(.+?)\s+@\s+(.+)$/);
      if (!company && ashby) company = clean(ashby[2]);
    }
    const role = clean(title.replace(/^Job Application for\s+/i, '').replace(/\s+at\s+.+$/i, ''));
    if (!company || !role || SUCCESS.some(pattern => pattern.test(role))) return null;
    const address = job?.jobLocation?.address;
    const locationName = clean(address ? [address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean).join(', ') : '') || text(['.posting-categories .location', '.location', '[data-testid="job-location"]']);
    const description = job?.description ? fromHtml(job.description) : clean(document.querySelector('#content, .job-description, .posting-description, .ashby-job-posting-description')?.textContent, 15000);
    const url = canonicalUrl();
    const jobId = clean(job?.identifier?.value || new URL(url).searchParams.get('gh_jid') || new URL(url).pathname.split('/').filter(Boolean).at(-1), 200);
    return { company, role, url, jobId, description, location: locationName };
  }
  const jobKey = (job, sessionId) => job && sessionId ? `${sessionId}:${job.url}` : '';
  function resetCapture(nextKey, documentState) {
    activeKey = nextKey;
    selections = new Map();
    inputs = new WeakMap();
    pendingSubmission = null;
    lastClickSubmit = null;
    sent.clear();
    for (const item of documentState?.selected || []) {
      const file = metadata(item.document);
      selections.set(file.kind, { id: item.selectionId, file, ready: Promise.resolve(file) });
    }
    if (documentState?.pending) {
      pendingSubmission = {
        id: documentState.pending.attemptId,
        documents: documentState.pending.documents.map(metadata),
        entries: null,
      };
    }
    if (documentState?.confirmedAttemptId) sent.add(`submission_confirmed:${documentState.confirmedAttemptId}`);
  }
  async function refresh() {
    if (!supported) return;
    try {
      const result = await request({ type: 'state' });
      session = result.session;
      refreshAt = Date.now();
      if (!session?.browserEnabled || session.stoppedAt) {
        context = null;
        if (activeKey) resetCapture('');
        return;
      }
      const found = extract();
      const saved = found ? await request({ type: 'remember', context: found, sessionId: session.id }) : await request({ type: 'context' });
      context = found || saved.context;
      const nextKey = jobKey(context, session.id);
      if (activeKey !== nextKey) resetCapture(nextKey, saved.documentState || saved.context?.documentState);
    } catch {
      // Keep the current identity during temporary transport failures. Each event
      // is revalidated by the background worker before it reaches the API.
      refreshAt = 0;
    }
  }
  function persistState(confirmedAttemptId) {
    if (!session?.browserEnabled || !context || !activeKey) return Promise.resolve();
    return request({
      type: 'document-state', sessionId: session.id, context,
      documentState: {
        selected: [...selections.values()].map(entry => ({ selectionId: entry.id, document: metadata(entry.file) })),
        pending: pendingSubmission ? {
          attemptId: pendingSubmission.id,
          documents: (pendingSubmission.documents || pendingSubmission.entries.map(entry => entry.file)).map(metadata),
        } : null,
        ...(confirmedAttemptId ? { confirmedAttemptId } : {}),
      },
    });
  }
  function enqueue(operation) {
    operations = operations.then(operation).catch(error => report(error?.message || 'A capture could not be saved.'));
    return operations;
  }
  function activeContext() {
    if (!session?.browserEnabled || session.stoppedAt || !context || activeKey !== jobKey(context, session.id)) return null;
    if (canonicalUrl() !== context.url) return null;
    return { context: { ...context }, sessionId: session.id, key: activeKey };
  }
  async function emit(kind, captured, id, extra = {}) {
    const result = await request({ type: 'event', sessionId: captured.sessionId, event: {
      ...captured.context, kind, eventId: id, observedAt: new Date().toISOString(), ...extra,
    } });
    if (result.ignored) throw new Error('Tracking stopped before the capture could be saved.');
    return result;
  }
  function documentKind(input) {
    const labelled = (input.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    const labels = [...(input.labels || [])].map(label => label.textContent || '').join(' ');
    const ownLabel = [input.name, input.id, input.getAttribute('aria-label'), input.getAttribute('data-testid'), labelled, labels]
      .filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_-]+/g, ' ');
    if (/\bcover\s*letter\b/.test(ownLabel)) return 'cover_letter';
    if (/\b(?:resume|cv|curriculum\s+vitae)\b/.test(ownLabel)) return 'resume';
    return null;
  }
  function archiveType(file) {
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    const expected = ALLOWED_TYPES[extension];
    const actual = (file.type || '').toLowerCase();
    return expected && (!actual || actual === expected || actual === 'application/octet-stream') ? expected : null;
  }
  function toBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  }
  function removeSelection(previous, captured) {
    if (!previous || selections.get(previous.file.kind)?.id !== previous.id) return;
    selections.delete(previous.file.kind);
    void persistState().catch(error => report(error.message));
    enqueue(async () => {
      await previous.ready;
      if (activeKey !== captured.key) return;
      await emit('document_removed', captured, nonce(), { document: metadata(previous.file) });
    });
  }
  function onFileChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const kind = documentKind(input);
    if (!kind) return;
    // File references are captured synchronously, before the site can replace
    // its input and before any session checks or hashing await a promise.
    const files = [...(input.files || [])];
    const captured = activeContext();
    if (!captured) return;
    const previous = inputs.get(input);
    if (files.length !== 1) {
      removeSelection(previous, captured);
      inputs.delete(input);
      if (files.length > 1) report('Choose one resume or cover letter per field to capture its exact version.');
      return;
    }
    const file = files[0];
    if (file.size > MAX_METADATA_BYTES) {
      removeSelection(previous, captured);
      inputs.delete(input);
      report('This document exceeds the 25 MB capture limit.');
      return;
    }
    const entry = {
      id: nonce(), file: { kind, name: file.name, size: file.size, mimeType: file.type || archiveType(file) || 'application/octet-stream', lastModified: file.lastModified, sha256: null },
      contentBase64: undefined, ready: null,
    };
    inputs.set(input, entry);
    selections.set(kind, entry);
    void request({ type: 'document-detected', sessionId: captured.sessionId, context: captured.context, eventId: entry.id, document: metadata(entry.file) })
      .catch(error => report(error.message));
    entry.ready = (async () => {
      const current = await request({ type: 'state' });
      if (!current.session?.browserEnabled || current.session.id !== captured.sessionId || activeKey !== captured.key) throw new Error('Tracking stopped before the document could be captured.');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        entry.file.sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        if (file.size <= MAX_ARCHIVE_BYTES && archiveType(file)) entry.contentBase64 = toBase64(bytes);
      } catch {
        report('The file could not be read. Its name was recorded without a saved copy.');
      }
      return entry.file;
    })();
    // Observe rejection now even if another operation is ahead in the queue.
    void entry.ready.catch(() => {});
    void persistState().catch(error => report(error.message));
    enqueue(async () => {
      try {
        await entry.ready;
        if (activeKey !== captured.key) { report('Document capture ended when you left this job. Check its saved documents.'); return; }
        await emit('document_selected', captured, entry.id, {
          document: { ...metadata(entry.file), ...(entry.contentBase64 !== undefined ? { contentBase64: entry.contentBase64 } : {}) },
          requiresReview: !entry.file.sha256,
        });
        await persistState();
      } finally { entry.contentBase64 = undefined; }
    });
  }
  function captureSubmission(label, form, fromClick) {
    const captured = activeContext();
    if (!captured) return;
    if (!fromClick && lastClickSubmit?.form === form && Date.now() - lastClickSubmit.time < 600) return;
    if (fromClick) lastClickSubmit = { form, time: Date.now() };
    // Freeze the selected entries at the click. A replacement after this point
    // can never be promoted by this attempt's later confirmation.
    const attempt = { id: nonce(), entries: [...selections.values()], documents: null };
    pendingSubmission = attempt;
    void persistState().catch(error => report(error.message));
    enqueue(async () => {
      const settled = await Promise.allSettled(attempt.entries.map(entry => entry.ready));
      attempt.documents = attempt.entries.map(entry => metadata(entry.file));
      if (activeKey !== captured.key) return;
      await persistState();
      await emit('submission_pending', captured, attempt.id, {
        excerpt: label, documents: attempt.documents,
        requiresReview: settled.some(result => result.status === 'rejected') || attempt.documents.some(file => !file.sha256),
      });
    });
    setTimeout(() => { void check(); }, 1500);
  }
  function confirmSubmission(excerpt) {
    const captured = activeContext();
    if (!captured) return;
    if (!pendingSubmission) pendingSubmission = { id: nonce(), entries: null, documents: [] };
    const attempt = pendingSubmission;
    const key = `submission_confirmed:${attempt.id}`;
    if (sent.has(key)) return;
    sent.add(key);
    enqueue(async () => {
      if (attempt.entries) await Promise.allSettled(attempt.entries.map(entry => entry.ready));
      const documents = (attempt.documents || attempt.entries?.map(entry => entry.file) || []).map(metadata);
      try {
        if (activeKey !== captured.key) return;
        await emit('submission_confirmed', captured, attempt.id, { excerpt, documents, requiresReview: documents.some(file => !file.sha256) });
        await persistState(attempt.id);
      } catch (error) { sent.delete(key); throw error; }
    });
  }
  function successText() {
    if (FAILURE.test(document.body.innerText)) return null;
    const visibleError = [...document.querySelectorAll('[aria-invalid="true"],.error-message,.field-error,[data-testid="error-message"]')]
      .some(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' &&
        (node.getAttribute('aria-invalid') === 'true' || clean(node.innerText).length > 0));
    if (visibleError) return null;
    const nodes = document.querySelectorAll('h1,h2,h3,[role="status"],[role="alert"],#application_confirmation,.application-confirmation,.application-success,.post-application,main');
    for (const node of nodes) {
      if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') continue;
      const value = clean(node.innerText, 1400);
      if (value.length > 1200) continue;
      if (FAILURE.test(value) || CONDITIONAL.test(value)) continue;
      const match = SUCCESS.map(pattern => value.match(pattern)).find(Boolean);
      if (match) return value.slice(0, 1000);
    }
    return null;
  }
  async function check() {
    if (!supported || checking) return;
    checking = true;
    try {
      if (Date.now() - refreshAt > 10_000 || (context && canonicalUrl() !== context.url)) await refresh();
      if (!session?.browserEnabled) return;
      const success = successText();
      if (success) confirmSubmission(success);
    } catch {} finally { checking = false; }
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'extract') { sendResponse(extract()); return; }
    if (message.type === 'refresh') { refresh().then(check).then(() => sendResponse({ refreshed: true })); return true; }
  });
  if (supported) {
    document.addEventListener('change', onFileChange, true);
    document.addEventListener('reset', event => {
      const captured = activeContext();
      if (!captured || !(event.target instanceof HTMLFormElement)) return;
      const previous = [...event.target.querySelectorAll('input[type="file"]')].map(input => ({ input, entry: inputs.get(input) }));
      setTimeout(() => {
        if (event.defaultPrevented || activeKey !== captured.key) return;
        for (const { input, entry } of previous) {
          if (!input.files?.length) { removeSelection(entry, captured); inputs.delete(input); }
        }
      }, 0);
    }, true);
    document.addEventListener('click', event => {
      const button = event.target?.closest?.('button,input[type="submit"],[role="button"]');
      if (!button) return;
      const label = clean(button.textContent || button.value || button.getAttribute('aria-label'));
      if (/^(?:submit(?: application)?|send application|apply now)$/i.test(label)) captureSubmission(label, button.form || button.closest('form'), true);
    }, true);
    document.addEventListener('submit', event => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const submitter = event.submitter;
      const label = clean(submitter?.textContent || submitter?.value || submitter?.getAttribute('aria-label'));
      if (/^(?:submit(?: application)?|send application|apply now)$/i.test(label) || [...form.querySelectorAll('input[type="file"]')].some(documentKind)) captureSubmission(label || 'Application form submitted', form, false);
    }, true);
    new MutationObserver(() => {
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { void check(); }, 400);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'aria-hidden'] });
    addEventListener('popstate', () => { refreshAt = 0; void check(); });
    setInterval(() => { void check(); }, 5000);
    void refresh().then(check);
  }
})();
