import { createClient } from '@supabase/supabase-js';
import { accountAuthentication } from './auth.ts';
import { AccountError, createAccountHandler, type DeletionLease } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10000)]) }) } };
const service = createClient(url, serviceKey, options);
const actorClient = (authorization?: string) => createClient(url, publicKey, { ...options, global: { ...options.global, ...(authorization ? { headers: { Authorization: authorization } } : {}) } });
const cleanup = async <T>(action: string, payload: Record<string, unknown>): Promise<T> => {
  const { data, error } = await service.rpc('apply_account_cleanup', { p_action: action, p_payload: payload });
  if (error) throw new AccountError(503, 'deletion_incomplete');
  return data as T;
};
const leasePayload = (lease: DeletionLease) => ({ userId: lease.userId, leaseId: lease.leaseId });
const handler = createAccountHandler({
  allowedOrigins: Deno.env.get('ACCOUNT_ALLOWED_ORIGINS')?.split(',').map(origin => origin.trim()).filter(Boolean),
  ...accountAuthentication(actorClient),
  backend: {
    begin: actor => cleanup('begin', { userId: actor.userId, sessionId: actor.sessionId }),
    files: lease => cleanup('files', leasePayload(lease)),
    async removeFiles(names) {
      const { error } = await service.storage.from('apply-documents').remove(names);
      if (error) throw new AccountError(503, 'deletion_incomplete');
    },
    async purgeWorkspace(lease) { await cleanup('purge_workspace', leasePayload(lease)); },
    async deleteAuthUser(userId) {
      const { error } = await service.auth.admin.deleteUser(userId, false);
      if (error && error.status !== 404) {
        const check = await service.auth.admin.getUserById(userId);
        if (!check.error || check.error.status !== 404) throw new AccountError(503, 'deletion_incomplete');
      }
    },
    finish: lease => cleanup('finish', leasePayload(lease)),
    async release(lease) { await cleanup('release', leasePayload(lease)); },
  },
});
Deno.serve(handler);
