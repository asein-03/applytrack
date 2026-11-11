import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CloudService } from '../server/cloud.js';
import { Store } from '../server/store.js';

test('account verification rejects unconfirmed, anonymous and revoked identities and fails closed when session checks fail', async () => {
  const runtime = new Store(':memory:');
  const cloud = new CloudService(runtime, '/unused', true);
  let user: Record<string, unknown> = { id: 'owner', email: 'owner@example.test', email_confirmed_at: '2026-11-10T12:00:00Z', is_anonymous: false };
  let active: boolean | null = true, rpcError: unknown = null;
  cloud.client = () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) }, rpc: async () => ({ data: active, error: rpcError }) }) as unknown as SupabaseClient;
  try {
    assert.equal((await cloud.verify('valid-token')).id, 'owner');
    active = false;
    await assert.rejects(() => cloud.verify('revoked-token'), error => (error as { status: number }).status === 401);
    active = null; rpcError = { message: 'Unavailable' };
    await assert.rejects(() => cloud.verify('valid-token'), error => (error as { status: number }).status === 503);
    active = true; rpcError = null; user = { ...user, email_confirmed_at: null };
    await assert.rejects(() => cloud.verify('unconfirmed-token'), error => (error as { status: number }).status === 401);
    user = { ...user, email_confirmed_at: '2026-11-10T12:00:00Z', is_anonymous: true };
    await assert.rejects(() => cloud.verify('anonymous-token'), error => (error as { status: number }).status === 401);
  } finally { runtime.close(); }
});
