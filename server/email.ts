import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import type { Inbox, Workspace } from '../shared/types.js';
import { Store, HttpError } from './store.js';
import { ingestEvent } from './events.js';
import { classifyEmail, emailEvent, matchEmail, type IncomingEmail } from './email-parser.js';
import { createVault } from './vault.js';
import type { CloudActor, CloudService, WorkspaceRepository } from './cloud.js';

type Tokens = { access_token: string; refresh_token?: string; expires_at: number };
type GmailPart = { mimeType?: string; filename?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: Array<{ name: string; value: string }> };
const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const oauthUrl = 'https://oauth2.googleapis.com/token';
const gmailUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_BODY_BYTES = 64_000;
const MAX_MIME_PARTS = 200;
const MAX_GOOGLE_JSON_BYTES = 2 * 1024 * 1024;
type BodyBudget = { bytes: number; parts: number };

export function extractBody(part: GmailPart, depth = 0): string {
  return extractPart(part, depth, { bytes: MAX_BODY_BYTES, parts: MAX_MIME_PARTS });
}
function decodePart(value: string | undefined, budget: BodyBudget): string {
  if (typeof value !== 'string' || !budget.bytes) return '';
  const bytes = Buffer.from(value.slice(0, Math.ceil(budget.bytes / 3) * 4), 'base64url').subarray(0, budget.bytes);
  budget.bytes -= bytes.length;
  return bytes.toString('utf8');
}
function extractPart(part: GmailPart, depth: number, budget: BodyBudget): string {
  if (depth > 20 || !part || typeof part !== 'object' || !budget.parts || !budget.bytes) return '';
  budget.parts--;
  if (part.filename) return '';
  if (part.mimeType === 'text/plain') return decodePart(part.body?.data, budget);
  const children = Array.isArray(part.parts) ? part.parts.slice(0, MAX_MIME_PARTS) : [];
  if (part.mimeType === 'multipart/alternative') {
    for (const child of children) {
      if (!budget.parts || !budget.bytes) break;
      if (child?.mimeType === 'text/plain') { const text = extractPart(child, depth + 1, budget); if (text.trim()) return text; }
    }
    for (const child of children) {
      if (!budget.parts || !budget.bytes) break;
      if (child?.mimeType === 'text/plain') continue;
      const text = extractPart(child, depth + 1, budget); if (text.trim()) return text;
    }
    return '';
  }
  const texts: string[] = [];
  for (const child of children) {
    if (!budget.parts || !budget.bytes) break;
    const text = extractPart(child, depth + 1, budget); if (text) texts.push(text);
  }
  if (texts.length) return texts.join('\n');
  if (part.mimeType === 'text/html') return htmlText(decodePart(part.body?.data, budget));
  return '';
}

function htmlText(html: string): string {
  const lower = html.toLowerCase();
  const text: string[] = [];
  const links: string[] = [];
  let cursor = 0; let quotes = 0; let raw: string | null = null;
  while (cursor < html.length) {
    if (raw) {
      let end = lower.indexOf(`</${raw}`, cursor);
      while (end >= 0 && !/[\s/>]/.test(lower[end + raw.length + 2] || '')) end = lower.indexOf(`</${raw}`, end + raw.length + 2);
      if (end < 0) break;
      cursor = end; raw = null;
    }
    const start = html.indexOf('<', cursor);
    if (!quotes) text.push(html.slice(cursor, start < 0 ? html.length : start));
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3; continue;
    }
    let end = start + 1; let quote = '';
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === html.length) break;
    cursor = end + 1;
    const tag = html.slice(start + 1, end);
    const match = /^\s*(\/?)\s*([a-z][a-z0-9]*)\b/i.exec(tag);
    if (!match) continue;
    const closing = !!match[1]; const name = match[2].toLowerCase();
    if (name === 'script' || name === 'style') { if (!closing) raw = name; continue; }
    if (name === 'blockquote') { quotes = Math.max(0, quotes + (closing ? -1 : 1)); continue; }
    if (quotes) continue;
    if (name === 'a') {
      if (closing) { const link = links.pop(); if (link) text.push(` ${link}`); }
      else {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        const value = href?.[1] ?? href?.[2] ?? '';
        links.push(/^https:\/\/[^\s<>"']+$/i.test(value) ? value : '');
      }
    }
    if (name === 'br' || (closing && ['p', 'div', 'li'].includes(name))) text.push('\n');
    else if (name !== 'a') text.push(' ');
  }
  return text.join('').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new HttpError(502, `Google request failed (${response.status}). Reconnect the inbox if access has expired.`);
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, 'Google returned an empty response. Try again.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_GOOGLE_JSON_BYTES) { await reader.cancel(); throw new HttpError(502, 'Google returned a response larger than 2 MB. Review the message in Gmail before syncing again.'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T; }
    catch { throw new HttpError(502, 'Google returned an invalid response. Try again.'); }
  } finally { reader.releaseLock(); }
}

export function attachEmailRoutes(app: Express, store: Store, options: { dataDir: string; poll?: boolean; cloud?: CloudService; repository?: WorkspaceRepository }) {
  const vault = createVault(options.dataDir);
  const pending = new Map<string, { verifier: string; expiresAt: number; actor: CloudActor | null }>();
  const syncing = new Set<string>();
  const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:5173';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://127.0.0.1:4318/api/inboxes/google/callback';
  let stopped = false;

  const actorFor = (req: Request, workspace: Workspace = 'personal'): Promise<CloudActor | null> => options.cloud?.enabled && workspace === 'personal' ? options.cloud.authenticate(req) : Promise.resolve(null);
  const runtimeFor = (actor: CloudActor | null) => actor ? options.cloud!.runtimeFor(actor) : store;
  const run = <T>(workspace: Workspace, actor: CloudActor | null, write: boolean, action: (data: Store) => T | Promise<T>): Promise<T> => options.repository ? options.repository.run(workspace, actor, write, action) : Promise.resolve(action(store));
  const queue = (data: Store, mail: IncomingEmail) => {
    const id = hash(`${mail.workspace}:${mail.inboxId ?? 'import'}:${mail.id}`);
    data.setMeta(`email-review:${id}`, { ...mail, id, originalId: mail.id, kind: classifyEmail(mail).kind });
    return { queued: true, message: 'Choose an application to attach this email.', id };
  };
  const processEmail = (data: Store, mail: IncomingEmail, applicationId?: string) => {
    const application = applicationId ? data.getApplication(applicationId) : matchEmail(mail, data.listApplications(mail.workspace));
    if (applicationId && !application) throw new HttpError(404, 'Application not found.');
    if (!application) return queue(data, mail);
    if (application.workspace !== mail.workspace) throw new HttpError(409, 'Choose an application in the same workspace.');
    return ingestEvent(data, emailEvent(mail, application));
  };

  async function accessToken(runtime: Store, inboxId: string): Promise<string> {
    const encrypted = runtime.getMeta<string>(`inbox-token:${inboxId}`);
    if (!encrypted) throw new HttpError(409, 'Reconnect this inbox.');
    let tokens = vault.decrypt<Tokens>(encrypted);
    if (tokens.expires_at <= Date.now() + 60000) {
      if (!tokens.refresh_token) throw new HttpError(409, 'Reconnect this inbox to restore access.');
      const result = await requestJson<{ access_token: string; expires_in: number; refresh_token?: string }>(oauthUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }),
      });
      tokens = { ...tokens, ...result, expires_at: Date.now() + result.expires_in * 1000 };
      if (!runtime.getMeta(`inbox:${inboxId}`)) throw new HttpError(409, 'Inbox disconnected.');
      runtime.setMeta(`inbox-token:${inboxId}`, vault.encrypt(tokens));
    }
    return tokens.access_token;
  }

  async function syncInbox(id: string, actor: CloudActor | null = null) {
    if (options.cloud?.enabled && !actor) actor = await options.cloud.activeActor();
    const runtime = runtimeFor(actor);
    const syncKey = `${actor?.id ?? 'local'}:${id}`;
    const isCurrent = () => !stopped && !!runtime.getMeta(`inbox:${id}`) && (!actor || store.getMeta('activeCloudUser') === actor.id);
    const inbox = runtime.getMeta<Inbox>(`inbox:${id}`);
    if (!inbox) throw new HttpError(404, 'Inbox not found.');
    if (syncing.has(syncKey)) return { syncing: true, imported: 0, queued: 0 };
    if (!configured()) throw new HttpError(503, 'Google setup is required before syncing.');
    syncing.add(syncKey);
    let imported = 0; let queued = 0;
    const startedAt = new Date().toISOString();
    try {
      const token = await accessToken(runtime, id);
      const headers = { Authorization: `Bearer ${token}` };
      const since = inbox.lastSyncAt ? Math.floor((new Date(inbox.lastSyncAt).getTime() - 2 * 86400000) / 1000) : null;
      const query = `${since ? `after:${since}` : 'newer_than:30d'} {application assessment interview "coding challenge" "job offer" "employment offer"}`;
      let pageToken: string | undefined;
      let pages = 0;
      do {
        if (!isCurrent()) return { imported, queued };
        const params = new URLSearchParams({ q: query, maxResults: '100' });
        if (pageToken) params.set('pageToken', pageToken);
        const batch = await requestJson<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`${gmailUrl}/messages?${params}`, { headers });
        for (const stub of batch.messages ?? []) {
          if (!isCurrent()) return { imported, queued };
          if (await run('personal', actor, false, data => data.getMeta(`email-seen:${id}:${stub.id}`))) continue;
          const message = await requestJson<{ id: string; internalDate: string; payload: GmailPart }>(`${gmailUrl}/messages/${encodeURIComponent(stub.id)}?format=full`, { headers });
          if (!isCurrent()) return { imported, queued };
          const header = (name: string) => message.payload.headers?.find(item => item.name.toLowerCase() === name)?.value ?? '';
          const mail: IncomingEmail = { id: message.id, subject: header('subject'), from: header('from'), body: extractBody(message.payload).slice(0, 50000), receivedAt: new Date(Number(message.internalDate)).toISOString(), workspace: 'personal', inboxId: id, recipient: inbox.email };
          const outcome = await run('personal', actor, true, data => {
            const key = `email-seen:${id}:${stub.id}`;
            if (data.getMeta(key)) return 'seen';
            const result = classifyEmail(mail).kind !== 'note' || matchEmail(mail, data.listApplications('personal')) ? processEmail(data, mail) : null;
            data.setMeta(key, true);
            return result ? ('queued' in result ? 'queued' : 'imported') : 'seen';
          });
          if (outcome === 'queued') queued++;
          if (outcome === 'imported') imported++;
        }
        pageToken = batch.nextPageToken;
        pages++;
        if (pageToken && pages >= 20) throw new HttpError(429, 'Large mailbox sync paused. Sync again to continue; imported messages are saved.');
      } while (pageToken);
      if (isCurrent()) runtime.setMeta(`inbox:${id}`, { ...inbox, status: 'connected', error: null, lastSyncAt: startedAt });
      return { imported, queued };
    } catch (error) {
      if (isCurrent()) runtime.setMeta(`inbox:${id}`, { ...inbox, status: 'error', error: error instanceof HttpError ? error.message : 'Sync failed. Check your connection and try again.' });
      throw error;
    } finally { syncing.delete(syncKey); }
  }

  app.get('/api/inboxes', async (req, res) => res.json({ inboxes: runtimeFor(await actorFor(req)).listInboxes(), gmailConfigured: configured() }));
  app.post('/api/inboxes/google/connect', async (req, res) => {
    const actor = await actorFor(req);
    if (actor && store.getMeta('activeCloudUser') !== actor.id) throw new HttpError(409, 'Activate this account on the device before connecting Gmail.');
    if (!configured()) throw new HttpError(503, 'Google setup required. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the local .env file and register the callback URL shown in Connections.');
    for (const [key, value] of pending) if (value.expiresAt < Date.now()) pending.delete(key);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    pending.set(state, { verifier, expiresAt: Date.now() + 10 * 60000, actor });
    res.cookie('apply_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60000, path: '/api/inboxes/google' });
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly', access_type: 'offline', prompt: 'consent',
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  });
  app.get('/api/inboxes/google/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const cookieState = (req.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('apply_oauth_state='))?.slice('apply_oauth_state='.length);
    const entry = pending.get(state);
    pending.delete(state);
    res.clearCookie('apply_oauth_state', { path: '/api/inboxes/google' });
    if (!entry || entry.expiresAt < Date.now() || cookieState !== state) throw new HttpError(400, 'Connection expired. Start Connect Gmail again.');
    if (entry.actor && store.getMeta('activeCloudUser') !== entry.actor.id) throw new HttpError(409, 'The active account changed. Connect Gmail again.');
    const actor = entry.actor ? await options.cloud!.activeActor() : null;
    const runtime = runtimeFor(actor);
    if (req.query.error || typeof req.query.code !== 'string') { res.redirect(`${origin}/?connection=cancelled`); return; }
    const result = await requestJson<{ access_token: string; refresh_token?: string; expires_in: number }>(oauthUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: req.query.code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: entry.verifier }),
    });
    const profile = await requestJson<{ emailAddress: string }>(`${gmailUrl}/profile`, { headers: { Authorization: `Bearer ${result.access_token}` } });
    if (actor && store.getMeta('activeCloudUser') !== actor.id) throw new HttpError(409, 'The active account changed. Connect Gmail again.');
    const id = hash(profile.emailAddress.toLowerCase()).slice(0, 24);
    const previous = runtime.getMeta<string>(`inbox-token:${id}`);
    const refresh = result.refresh_token ?? (previous ? vault.decrypt<Tokens>(previous).refresh_token : undefined);
    runtime.setMeta(`inbox-token:${id}`, vault.encrypt({ access_token: result.access_token, refresh_token: refresh, expires_at: Date.now() + result.expires_in * 1000 }));
    const priorInbox = runtime.getMeta<Inbox>(`inbox:${id}`);
    runtime.setMeta(`inbox:${id}`, { id, provider: 'gmail', email: profile.emailAddress, status: 'connected', lastSyncAt: priorInbox?.lastSyncAt ?? null, error: null } satisfies Inbox);
    res.redirect(`${origin}/?connected=gmail`);
    void syncInbox(id, actor).catch(() => {});
  });
  app.post('/api/inboxes/:id/sync', async (req, res) => res.json(await syncInbox(String(req.params.id), await actorFor(req))));
  app.delete('/api/inboxes/:id', async (req, res) => {
    const actor = await actorFor(req); const runtime = runtimeFor(actor);
    const id = String(req.params.id);
    if (!runtime.getMeta(`inbox:${id}`)) throw new HttpError(404, 'Inbox not found.');
    const encrypted = runtime.getMeta<string>(`inbox-token:${id}`);
    runtime.deleteMeta(`inbox:${id}`); runtime.deleteMeta(`inbox-token:${id}`);
    await run('personal', actor, true, data => {
      for (const row of data.listMeta(`email-seen:${id}:`)) data.deleteMeta(row.key);
      for (const row of data.listMeta<IncomingEmail>('email-review:')) if (row.value.inboxId === id) data.deleteMeta(row.key);
    });
    if (encrypted) {
      const token = vault.decrypt<Tokens>(encrypted);
      try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.refresh_token ?? token.access_token }), signal: AbortSignal.timeout(5000) }); } catch { /* Local disconnection is complete even while offline. */ }
    }
    res.sendStatus(204);
  });

  const importSchema = z.object({ text: z.string().trim().min(1).max(100000), workspace: z.enum(['personal', 'demo']).default('personal'), applicationId: z.string().max(100).optional() }).strict();
  app.post('/api/email/import', async (req, res) => {
    const input = importSchema.parse(req.body);
    const subject = input.text.match(/^Subject:\s*(.+)$/im)?.[1] ?? input.text.split('\n')[0].slice(0, 200);
    const from = input.text.match(/^From:\s*(.+)$/im)?.[1] ?? 'Imported email';
    const mail: IncomingEmail = { id: hash(input.text), subject, from, body: input.text, receivedAt: new Date().toISOString(), workspace: input.workspace };
    res.json(await run(input.workspace, await actorFor(req, input.workspace), true, data => processEmail(data, mail, input.applicationId)));
  });
  app.get('/api/email/review', async (req, res) => {
    const workspace = z.enum(['personal', 'demo']).parse(req.query.workspace ?? 'personal');
    res.json({ items: await run(workspace, await actorFor(req, workspace), false, data => data.listMeta<IncomingEmail>('email-review:').map(row => row.value).filter(item => item.workspace === workspace)) });
  });
  const reviewWorkspace = (id: string): Workspace => store.getMeta<IncomingEmail>(`email-review:${id}`)?.workspace === 'demo' ? 'demo' : 'personal';
  app.post('/api/email/review/:id/assign', async (req, res) => {
    const { applicationId } = z.object({ applicationId: z.string().min(1).max(100) }).strict().parse(req.body);
    const workspace = reviewWorkspace(String(req.params.id));
    res.json(await run(workspace, await actorFor(req, workspace), true, data => {
      const key = `email-review:${String(req.params.id)}`;
      const mail = data.getMeta<IncomingEmail & { originalId: string }>(key);
      if (!mail) throw new HttpError(404, 'Email not found.');
      const result = processEmail(data, { ...mail, id: mail.originalId }, applicationId);
      data.deleteMeta(key);
      return result;
    }));
  });
  app.delete('/api/email/review/:id', async (req, res) => {
    const workspace = reviewWorkspace(String(req.params.id));
    await run(workspace, await actorFor(req, workspace), true, data => data.deleteMeta(`email-review:${String(req.params.id)}`));
    res.sendStatus(204);
  });

  const timer = options.poll === false ? null : setInterval(() => {
    if (stopped || !configured()) return;
    void (async () => {
      const actor = options.cloud?.enabled ? await options.cloud.activeActor() : null;
      for (const inbox of runtimeFor(actor).listInboxes()) void syncInbox(inbox.id, actor).catch(() => {});
    })().catch(() => {});
  }, 60000);
  timer?.unref();
  return { stop: () => { stopped = true; if (timer) clearInterval(timer); }, syncInbox };
}
