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

export function loadCloudConfig(retry = false): Promise<CloudConfig> {
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
        client = createClient(value.url, value.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
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
