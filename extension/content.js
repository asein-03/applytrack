(() => {
  if (globalThis.__applyCompanionLoaded) return;
  globalThis.__applyCompanionLoaded = true;
  const SUPPORTED = /^(boards(?:\.eu)?\.greenhouse\.io|job-boards\.greenhouse\.io|jobs(?:\.eu)?\.lever\.co|jobs\.ashbyhq\.com)$/;
  const supported = SUPPORTED.test(location.hostname);
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
    url.pathname = url.pathname.replace(/\/(?:apply|application)\/?$/, '').replace(/\/$/, '');
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
  async function refresh() {
    if (!supported) return;
    try {
      const result = await request({ type: 'state' });
      session = result.session;
      refreshAt = Date.now();
      if (!session?.browserEnabled || session.stoppedAt) { context = null; return; }
      const found = extract();
      if (found) {
        context = found;
        await request({ type: 'remember', context });
      } else {
        context = (await request({ type: 'context' })).context;
      }
    } catch { session = null; }
  }
  async function send(kind, excerpt) {
    if (!session?.browserEnabled || !context) return;
    const key = `${session.id}:${context.url}:${kind}`;
    if (sent.has(key)) return;
    const result = await request({ type: 'event', event: { ...context, kind, excerpt } });
    if (!result.ignored) sent.add(key);
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
      if (Date.now() - refreshAt > 10_000) await refresh();
      if (!session?.browserEnabled) return;
      const success = successText();
      if (success) await send('submission_confirmed', success);
    } catch {} finally { checking = false; }
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'extract') { sendResponse(extract()); return; }
    if (message.type === 'refresh') { refresh().then(check).then(() => sendResponse({ refreshed: true })); return true; }
  });
  if (supported) {
    document.addEventListener('click', async event => {
      const button = event.target.closest?.('button,input[type="submit"],[role="button"]');
      if (!button) return;
      const label = clean(button.textContent || button.value || button.getAttribute('aria-label'));
      if (!/^(?:submit(?: application)?|send application|apply now)$/i.test(label)) return;
      try {
        await refresh();
        await send('submission_pending', label);
        setTimeout(() => { void check(); }, 1500);
      } catch {}
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
