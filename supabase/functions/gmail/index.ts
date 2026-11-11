import { createClient } from '@supabase/supabase-js';
import { TokenCipher } from './crypto.ts';
import { createGmailHandler } from './handler.ts';
import { GMAIL_CALLBACK } from './oauth.ts';
import { GmailStorage } from './storage.ts';
import { syncConnection } from './sync.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
const url = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const clientId = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const cipher = new TokenCipher(Deno.env.get('GMAIL_TOKEN_ENCRYPTION_KEY') || '');
if (new URL(url).origin !== new URL(GMAIL_CALLBACK).origin) throw new Error('Gmail project configuration does not match.');
const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const handler = createGmailHandler({
  config: clientId && clientSecret ? { clientId, clientSecret, callbackUrl: GMAIL_CALLBACK } : null,
  authPage: Deno.env.get('GMAIL_AUTH_PAGE') || null,
  authOrigin: Deno.env.get('GMAIL_AUTH_ORIGIN') || null,
  workerSecret: Deno.env.get('GMAIL_WORKER_SECRET') || '',
  cipher,
  storage: new GmailStorage(service),
  allowedOrigins: Deno.env.get('GMAIL_ALLOWED_ORIGINS')?.split(',').map(value => value.trim()).filter(Boolean),
  sync: syncConnection,
  schedule: (promise) => EdgeRuntime.waitUntil(promise),
  async authenticateBrowser(email, password) {
    const client = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    try {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data.user || !data.user.email_confirmed_at || data.user.is_anonymous) return null;
      return data.user.id;
    } finally {
      // This is a separate short-lived verification session. Never sign out the
      // session that initiated Gmail connection or any other logged-in device.
      await client.auth.signOut({ scope: 'local' });
    }
  },
  async authenticate(request) {
    const authorization = request.headers.get('Authorization') || '';
    if (!/^Bearer [A-Za-z0-9._-]{20,16384}$/.test(authorization)) return null;
    const token = authorization.slice(7);
    const client = createClient(url, publicKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user || !data.user.email_confirmed_at || data.user.is_anonymous) return null;
    const active = await client.rpc('apply_has_active_session');
    if (active.error || active.data !== true) return null;
    try {
      // Read the session claim only after the Auth server verified this JWT and
      // the database verified the same signed session is still active.
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (typeof payload.session_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(payload.session_id) || payload.sub !== data.user.id) return null;
      return { userId: data.user.id, sessionId: payload.session_id };
    } catch { return null; }
  },
});
Deno.serve(handler);
