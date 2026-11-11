import { TokenCipher, tokenContext } from './crypto.ts';
import { GmailHttpError, type GmailApi, type GmailLease, type GmailTokens } from './shared.ts';
import type { GmailStorage } from './storage.ts';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_CALLBACK = 'https://fbnmvajnvylkaegtkvsj.supabase.co/functions/v1/gmail';
export interface GoogleConfig { clientId: string; clientSecret: string; callbackUrl: string; }
export type Fetcher = typeof fetch;

export async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > maximumBytes) {
    await response.body?.cancel();
    throw new GmailHttpError(response.status, 'response_too_large');
  }
  if (!response.body) throw new GmailHttpError(response.status, 'invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw new GmailHttpError(response.status, 'response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new GmailHttpError(response.status, 'invalid_response'); }
}
export async function boundedJSON(response: Response, maximumBytes: number): Promise<unknown> {
  const text = await boundedText(response, maximumBytes);
  try { return JSON.parse(text); } catch { throw new GmailHttpError(response.status, 'invalid_response'); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GmailHttpError(502, 'invalid_response');
  return value as Record<string, unknown>;
}
function safeToken(value: unknown): value is string { return typeof value === 'string' && value.length >= 10 && value.length <= 16_384 && !/[\s\x00-\x1f\x7f]/.test(value); }
function parseTokens(body: Record<string, unknown>, previous?: GmailTokens): GmailTokens {
  const refreshToken = body.refresh_token ?? previous?.refreshToken;
  const scope = body.scope ?? previous?.scope;
  if (!safeToken(body.access_token) || !safeToken(refreshToken) || typeof scope !== 'string' || !scope.split(' ').includes(GMAIL_SCOPE)
    || typeof body.expires_in !== 'number' || body.expires_in < 1 || body.expires_in > 86_400
    || (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer')) throw new GmailHttpError(502, 'invalid_response');
  return { accessToken: body.access_token, refreshToken, scope, expiresAt: Date.now() + body.expires_in * 1000 };
}
export function authorizationUrl(config: GoogleConfig, state: string, challenge: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callbackUrl, response_type: 'code', scope: GMAIL_SCOPE,
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return url.href;
}
async function tokenRequest(config: GoogleConfig, parameters: Record<string, string>, fetcher: Fetcher, signal: AbortSignal, previous?: GmailTokens): Promise<GmailTokens> {
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal,
    body: new URLSearchParams({ ...parameters, client_id: config.clientId, client_secret: config.clientSecret }),
  });
  const body = record(await boundedJSON(response, 65_536));
  if (!response.ok) {
    if (body.error === 'invalid_grant') throw new GmailHttpError(401, 'reconnect_required');
    throw new GmailHttpError(response.status, response.status === 429 ? 'rate_limited' : 'unavailable');
  }
  return parseTokens(body, previous);
}
export function exchangeCode(config: GoogleConfig, code: string, verifier: string, fetcher: Fetcher, signal: AbortSignal): Promise<GmailTokens> {
  return tokenRequest(config, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.callbackUrl }, fetcher, signal);
}
export async function gmailProfile(accessToken: string, fetcher: Fetcher, signal: AbortSignal): Promise<{ email: string; historyId: string }> {
  const response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal });
  if (!response.ok) { await response.body?.cancel(); throw new GmailHttpError(response.status, 'unavailable'); }
  const body = record(await boundedJSON(response, 16_384));
  if (typeof body.emailAddress !== 'string' || body.emailAddress.length > 320 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(body.emailAddress)
    || typeof body.historyId !== 'string' || !/^\d{1,32}$/.test(body.historyId)) throw new GmailHttpError(502, 'invalid_response');
  return { email: body.emailAddress.toLowerCase(), historyId: body.historyId };
}
export async function revokeToken(token: string, fetcher: Fetcher, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }), redirect: 'error', signal });
    if (response.ok) { await response.body?.cancel(); return true; }
    // An already-invalid token has no remaining grant to revoke.
    const body = record(await boundedJSON(response, 16_384));
    return response.status === 400 && body.error === 'invalid_token';
  } catch { return false; }
}
export async function createGmailApi(options: { config: GoogleConfig; cipher: TokenCipher; storage: GmailStorage; lease: GmailLease; fetcher: Fetcher; signal: AbortSignal }): Promise<GmailApi> {
  const { config, cipher, storage, lease, fetcher, signal } = options;
  const context = tokenContext(lease.connection.userId, lease.connection.id, lease.connection.generation);
  let tokens = await cipher.open<GmailTokens>(lease.tokenCipher, context);
  if (!safeToken(tokens.accessToken) || !safeToken(tokens.refreshToken) || !Number.isFinite(tokens.expiresAt)) throw new GmailHttpError(502, 'invalid_response');
  const refresh = async () => {
    await storage.assertLease(lease);
    tokens = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, fetcher, signal, tokens);
    await storage.updateTokens(lease, await cipher.seal(tokens, context));
  };
  return {
    async request<T>(path: string, query: Record<string, string> = {}): Promise<T> {
      if (!/^(?:profile|messages|messages\/[a-zA-Z0-9_-]{1,128}|history)$/.test(path)) throw new GmailHttpError(400, 'invalid_response');
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
      for (const [key, value] of Object.entries(query)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) || value.length > 4096) throw new GmailHttpError(400, 'invalid_response');
        url.searchParams.set(key, value);
      }
      if (tokens.expiresAt <= Date.now() + 60_000) await refresh();
      for (let attempt = 0; attempt < 2; attempt++) {
        // Check the lease before reading Gmail: a disconnected inbox cannot keep making API requests.
        await storage.assertLease(lease);
        const response = await fetcher(url, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, redirect: 'error', signal });
        if (response.status === 401 && attempt === 0) { await response.body?.cancel(); await refresh(); continue; }
        if (!response.ok) {
          await response.body?.cancel();
          throw new GmailHttpError(response.status, response.status === 401 ? 'reconnect_required' : response.status === 429 ? 'rate_limited' : 'unavailable');
        }
        return await boundedJSON(response, query.format === 'raw' ? 3 * 1024 * 1024 : 512 * 1024) as T;
      }
      throw new GmailHttpError(401, 'reconnect_required');
    },
  };
}
