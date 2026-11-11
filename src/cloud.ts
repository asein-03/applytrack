import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface CloudConfig {
  enabled: boolean;
  configured: boolean;
  url?: string;
  publishableKey?: string;
  mode?: string;
}

let config: CloudConfig | null = null;
let client: SupabaseClient | null = null;
let loading: Promise<CloudConfig> | null = null;
let callbackRead = false;
let callbackCode: string | null = null;
const callbackState = { error: '', recovery: false };
const callbackKeys = ['code', 'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'expires_in', 'expires_at', 'token_type', 'type', 'error', 'error_code', 'error_description', 'sb_flow_id'];

function readAuthCallback() {
  if (callbackRead) return;
  callbackRead = true;
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const hasTokens = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token'].some(key => url.searchParams.has(key) || fragment.has(key));
  const hasError = ['error', 'error_code', 'error_description'].some(key => url.searchParams.has(key) || fragment.has(key));
  const hasCode = url.searchParams.has('code') || fragment.has('code');
  if (!hasTokens && !hasError && !hasCode) return;
  callbackCode = !hasTokens && !hasError ? url.searchParams.get('code') : null;
  if (hasTokens) callbackState.error = 'This sign-in link is not supported. Sign in with your password or request a new email link.';
  else if (hasError || !callbackCode) callbackState.error = 'This email link is invalid or expired. Request a new link in this browser.';
  for (const key of callbackKeys) { url.searchParams.delete(key); fragment.delete(key); }
  url.hash = fragment.toString();
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function getAuthCallbackState() { return { ...callbackState }; }

export function loadCloudConfig(retry = false): Promise<CloudConfig> {
  readAuthCallback();
  if (retry) loading = null;
  if (!loading) loading = (async () => {
    const response = await fetch('/api/cloud/config');
    if (!response.ok) throw new Error('Could not reach the account service. Try again.');
    const value = await response.json() as CloudConfig;
    if (typeof value.enabled !== 'boolean' || typeof value.configured !== 'boolean') throw new Error('The account service returned an invalid configuration.');
    if (value.enabled && value.configured) {
      if (!value.url || !value.publishableKey) throw new Error('Cloud account configuration is incomplete.');
      const url = new URL(value.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Cloud account configuration is invalid.');
      if (!client || value.url !== config?.url || value.publishableKey !== config?.publishableKey) {
        const storage = window.applyDesktop?.authStorage;
        if (window.applyDesktop) {
          if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') throw new Error('Secure account storage is unavailable. Update ApplyTrack and reopen the app.');
          const key = `sb-${url.hostname.split('.')[0]}-auth-token`;
          for (const suffix of ['', '-code-verifier', '-user']) localStorage.removeItem(key + suffix);
        }
        client = createClient(value.url, value.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce', storage } });
      }
      if (callbackCode) {
        const code = callbackCode; callbackCode = null;
        const { data: listener } = client.auth.onAuthStateChange(event => { if (event === 'PASSWORD_RECOVERY') callbackState.recovery = true; });
        try {
          const { error } = await client.auth.exchangeCodeForSession(code);
          if (error) callbackState.error = 'This email link could not be verified here. Use the browser where you requested it, or request a new link in this browser.';
        } finally { listener.subscription.unsubscribe(); }
      }
    }
    config = value;
    return value;
  })();
  return loading;
}

export function getCloudClient() { return client; }

export async function getAccessToken(): Promise<string | null> {
  if (!config?.enabled) return null;
  if (!client) throw new Error('Cloud accounts are not configured.');
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error('Sign in to continue.');
  return data.session.access_token;
}

export function clearWorkspaceContext() {
  localStorage.removeItem('apply.workspace');
  localStorage.removeItem('apply.account');
}

export function prepareAccountWorkspace(userId: string) {
  if (localStorage.getItem('apply.account') !== userId) localStorage.removeItem('apply.workspace');
  localStorage.setItem('apply.account', userId);
}
