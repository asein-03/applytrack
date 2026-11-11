import { pkceChallenge, randomSecret, secretsEqual, sha256, stateContext, TokenCipher, tokenContext } from './crypto.ts';
import { authorizationUrl, boundedJSON, boundedText, createGmailApi, exchangeCode, gmailProfile, revokeToken, type Fetcher, type GoogleConfig } from './oauth.ts';
import { GmailHttpError, type GmailSyncContext, type GmailSyncResult, type GmailTokens } from './shared.ts';
import { GmailStorage, StorageError, type GmailIdentity } from './storage.ts';

export interface GmailDependencies {
  config: GoogleConfig | null;
  cipher: TokenCipher;
  authPage: string | null;
  authOrigin: string | null;
  authenticateBrowser(email: string, password: string): Promise<string | null>;
  workerSecret: string;
  storage: GmailStorage;
  authenticate(request: Request): Promise<GmailIdentity | null>;
  sync(context: GmailSyncContext): Promise<GmailSyncResult>;
  schedule(work: Promise<unknown>): void;
  fetcher?: Fetcher;
  allowedOrigins?: string[];
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const safeMessages: Record<string, string> = {
  reconnect_required: 'Reconnect Gmail to resume inbox checks.',
  rate_limited: 'Gmail is busy. Your next inbox check will retry automatically.',
  unavailable: 'Gmail could not be checked. ApplyTrack will retry automatically.',
};
function callbackPage(kind: 'success' | 'cancel' | 'error', cookie?: string): Response {
  const text = kind === 'success' ? 'Gmail connected. Return to ApplyTrack. Your inbox will appear there shortly.' : kind === 'cancel' ? 'Connection canceled. You can close this tab and return to ApplyTrack.' : 'Gmail was not connected. Return to ApplyTrack and try connecting again.';
  return new Response(text, { status: kind === 'error' ? 400 : 200, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}
function cookieValue(request: Request, name: string): string | null {
  const values = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
const cookieName = (stateHash: string) => `__Host-apply-gmail-${stateHash.slice(0, 16)}`;
const expiredCookie = (stateHash: string) => `${cookieName(stateHash)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
export function createGmailHandler(dependencies: GmailDependencies): (request: Request) => Promise<Response> {
  const { storage, cipher, config } = dependencies;
  const fetcher = dependencies.fetcher || fetch;
  const allowedOrigins = new Set(dependencies.allowedOrigins || ['http://localhost:5173', 'http://127.0.0.1:5173']);
  let authPage: URL | null = null;
  try {
    const parsed = new URL(dependencies.authPage || '');
    if (parsed.protocol === 'https:' && parsed.origin === dependencies.authOrigin && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) authPage = parsed;
  } catch { /* Gmail remains unavailable until a trusted sign-in page is configured. */ }
  const configured = Boolean(config && authPage && dependencies.workerSecret.length >= 32);
  const revokeQueued = async (inboxId?: string, signal = AbortSignal.timeout(10_000)): Promise<boolean> => {
    const lease = await storage.claimRevocation(inboxId);
    if (!lease) return true;
    let success = false;
    try {
      const tokens = await cipher.open<GmailTokens>(lease.tokenCipher, tokenContext(lease.userId, lease.id, lease.generation));
      success = await revokeToken(tokens.refreshToken, fetcher, signal);
    } catch { /* A failed revocation remains encrypted and is retried. */ }
    await storage.finishRevocation(lease, success);
    return success;
  };
  const runWorker = async (inboxId?: string) => {
    if (!config) return;
    const signal = AbortSignal.timeout(45_000);
    for (let index = 0; index < 3 && !signal.aborted; index++) {
      try { if (!await revokeQueued(undefined, signal)) break; } catch { break; }
    }
    for (let index = 0; index < (inboxId ? 1 : 3) && !signal.aborted; index++) {
      const lease = await storage.claim(inboxId);
      if (!lease) break;
      try {
        const gmail = await createGmailApi({ config, cipher, storage, lease, fetcher, signal });
        const result = await dependencies.sync({ connection: lease.connection, gmail, backend: storage.backend(lease), signal });
        const { phase, historyId, pageToken, baselineHistoryId, pendingMessageIds, pendingNextPageToken, pendingHistoryId, more } = result;
        await storage.finish(lease, { phase, historyId, pageToken, baselineHistoryId, pendingMessageIds, pendingNextPageToken, pendingHistoryId }, more);
      } catch (error) {
        if (error instanceof GmailHttpError && error.code === 'lease_lost') continue;
        try { await storage.fail(lease, error instanceof GmailHttpError ? error.code : 'unavailable'); } catch { /* An expired or canceled lease must not write. */ }
      }
    }
  };
  const schedule = (inboxId?: string) => dependencies.schedule(runWorker(inboxId).catch(() => undefined));
  const callback = async (request: Request): Promise<Response> => {
    if (!configured || !config || request.url.length > 16_384) return callbackPage('error');
    const url = new URL(request.url);
    const states = url.searchParams.getAll('state');
    if (states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0])) return callbackPage('error');
    const stateHash = await sha256(states[0]);
    const browserNonce = cookieValue(request, cookieName(stateHash));
    if (!browserNonce || !/^[A-Za-z0-9_-]{43}$/.test(browserNonce)) return callbackPage('error', expiredCookie(stateHash));
    let tokens: GmailTokens | undefined;
    try {
      const state = await storage.consumeOAuth(stateHash, await sha256(browserNonce));
      if (!state) return callbackPage('error');
      if (url.searchParams.has('error')) return callbackPage('cancel');
      const codes = url.searchParams.getAll('code');
      if (codes.length !== 1 || !codes[0] || codes[0].length > 8192) return callbackPage('error');
      const verifier = await cipher.open<string>(state.verifierCipher, stateContext(state.userId, state.stateHash));
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return callbackPage('error');
      const signal = AbortSignal.timeout(20_000);
      tokens = await exchangeCode(config, codes[0], verifier, fetcher, signal);
      const profile = await gmailProfile(tokens.accessToken, fetcher, signal);
      if (state.expectedEmail && profile.email !== state.expectedEmail.toLowerCase()) return callbackPage('error');
      const identity = { userId: state.userId, sessionId: state.sessionId };
      const emailHash = await sha256(profile.email);
      const target = await storage.target(identity, emailHash, state.inboxId);
      const generation = crypto.randomUUID();
      const tokenCipher = await cipher.seal(tokens, tokenContext(state.userId, target.id, generation));
      await storage.save(identity, { inboxId: target.id, email: profile.email, emailHash, generation, tokenCipher, existingGeneration: target.existingGeneration, stateHash: state.stateHash });
      schedule(target.id);
      return callbackPage('success', expiredCookie(stateHash));
    } catch {
      // Google revocation is grant-wide. Revoking an unsuccessful concurrent
      // authorization here could invalidate a separate connected inbox. Unstored
      // credentials are discarded; explicit Disconnect owns grant revocation.
      tokens = undefined;
      return callbackPage('error');
    }
  };
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const cors: Record<string, string> = origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...cors, 'Content-Type': 'application/json' } });
    if (request.method === 'GET') return callback(request);
    const isBrowserForm = request.method === 'POST' && request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded');
    if (origin && !allowedOrigins.has(origin) && !(isBrowserForm && origin === dependencies.authOrigin)) return json({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, ...cors, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600' } });
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    try {
      if (isBrowserForm) {
        if (!configured || !config || !authPage || origin !== dependencies.authOrigin) return json({ error: 'Browser authorization unavailable.' }, 403);
        const form = new URLSearchParams(await boundedText(new Response(request.body, { headers: request.headers }), 8192));
        const fields = ['action', 'state', 'email', 'password'];
        if (fields.some(key => form.getAll(key).length !== 1) || [...form.keys()].some(key => !fields.includes(key)) || form.get('action') !== 'browser_authorize') return json({ error: 'Invalid browser authorization.' }, 400);
        const stateValue = form.get('state') || '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(stateValue)) return json({ error: 'Invalid connection attempt.' }, 400);
        const failure = () => {
          const retry = new URL(authPage);
          retry.searchParams.set('state', stateValue);
          retry.searchParams.set('error', 'signin');
          return new Response(null, { status: 303, headers: { ...headers, Location: retry.href } });
        };
        const email = form.get('email') || '';
        const password = form.get('password') || '';
        const stateHash = await sha256(stateValue);
        if (email.length > 320 || !email.includes('@') || password.length < 1 || password.length > 1024 || !await storage.authorizeAttempt(stateHash)) return failure();
        const userId = await dependencies.authenticateBrowser(email, password);
        if (!userId) return failure();
        const browserNonce = randomSecret();
        const state = await storage.authorizeOAuth(stateHash, userId, await sha256(browserNonce));
        if (!state) return failure();
        const verifier = await cipher.open<string>(state.verifierCipher, stateContext(state.userId, state.stateHash));
        const url = authorizationUrl(config, stateValue, await pkceChallenge(verifier));
        return new Response(null, { status: 303, headers: { ...headers, Location: url, 'Set-Cookie': `${cookieName(stateHash)}=${browserNonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` } });
      }
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Use a JSON request.' }, 415);
      const body = await boundedJSON(new Response(request.body, { headers: request.headers }), 8192);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request.' }, 400);
      const payload = body as Record<string, unknown>;
      if (Object.keys(payload).some(key => !['action', 'inboxId'].includes(key))) return json({ error: 'Invalid request.' }, 400);
      if (payload.action === 'work') {
        const supplied = request.headers.get('X-Apply-Gmail-Worker') || '';
        if (!configured || supplied.length > 256 || !await secretsEqual(supplied, dependencies.workerSecret)) return json({ error: 'Worker authentication required.' }, 401);
        if (payload.inboxId !== undefined) return json({ error: 'Invalid request.' }, 400);
        schedule();
        return json({ accepted: true }, 202);
      }
      const identity = await dependencies.authenticate(request);
      if (!identity) return json({ error: 'Sign in to continue.' }, 401);
      if (!['connect', 'status', 'sync', 'disconnect'].includes(String(payload.action))) return json({ error: 'Invalid request.' }, 400);
      if (payload.inboxId !== undefined && (typeof payload.inboxId !== 'string' || !uuid.test(payload.inboxId))) return json({ error: 'Invalid inbox.' }, 400);
      if (payload.action === 'status') {
        const inboxes = await storage.status(identity);
        return json({ gmailConfigured: configured, inboxes: inboxes.map(inbox => ({ id: inbox.id, provider: 'gmail', email: inbox.email, status: inbox.status, lastSyncAt: inbox.lastSyncAt, connectedAt: inbox.connectedAt, syncing: inbox.syncing, error: inbox.error ? safeMessages[inbox.error] || safeMessages.unavailable : null })) });
      }
      if (payload.action === 'disconnect') {
        if (typeof payload.inboxId !== 'string') return json({ error: 'Choose an inbox.' }, 400);
        if (!await storage.disconnect(identity, payload.inboxId)) return json({ error: 'That inbox is unavailable.' }, 404);
        await revokeQueued(payload.inboxId);
        return json({ disconnected: true, revocationPending: await storage.revocationPending(identity, payload.inboxId) });
      }
      if (!configured || !config) return json({ error: 'Gmail connection is not configured yet.' }, 503);
      if (payload.action === 'connect') {
        const state = randomSecret();
        const stateHash = await sha256(state);
        const verifier = randomSecret(48);
        await storage.createOAuth({ stateHash, ...identity, verifierCipher: await cipher.seal(verifier, stateContext(identity.userId, stateHash)), inboxId: typeof payload.inboxId === 'string' ? payload.inboxId : null });
        const url = new URL(authPage!);
        url.searchParams.set('state', state);
        return json({ url: url.href });
      }
      if (typeof payload.inboxId !== 'string') return json({ error: 'Choose an inbox.' }, 400);
      await storage.enqueue(identity, payload.inboxId);
      schedule(payload.inboxId);
      return json({ syncing: true });
    } catch (error) {
      if (error instanceof GmailHttpError && error.code === 'response_too_large') return json({ error: 'Request is too large.' }, 413);
      if (error instanceof GmailHttpError && error.code === 'invalid_response') return json({ error: 'Invalid request.' }, 400);
      if (error instanceof StorageError && error.code === '54000') return json({ error: 'Too many requests. Try again shortly.' }, 429);
      if (error instanceof StorageError && error.code === '28000') return json({ error: 'Sign in or reconnect Gmail to continue.' }, 401);
      if (error instanceof StorageError && error.code === '22023') return json({ error: 'That inbox is unavailable.' }, 404);
      return json({ error: 'Gmail could not complete this request. Try again shortly.' }, 503);
    }
  };
}
