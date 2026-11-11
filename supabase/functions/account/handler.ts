export interface AccountActor { userId: string; sessionId: string; email: string; }
export interface DeletionLease { userId: string; leaseId: string; }
export interface AccountDeletionBackend {
  begin(actor: AccountActor): Promise<DeletionLease>;
  files(lease: DeletionLease): Promise<string[]>;
  removeFiles(names: string[]): Promise<void>;
  purgeWorkspace(lease: DeletionLease): Promise<void>;
  deleteAuthUser(userId: string): Promise<void>;
  finish(lease: DeletionLease): Promise<{ revocationPending: boolean }>;
  release(lease: DeletionLease): Promise<void>;
}
export interface AccountDependencies {
  authenticate(request: Request): Promise<AccountActor | null>;
  verifyPassword(actor: AccountActor, password: string): Promise<boolean>;
  backend: AccountDeletionBackend;
  allowedOrigins?: string[];
}
export class AccountError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
const defaults = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4318', 'http://127.0.0.1:4318'];
const errors: Record<string, string> = {
  unauthorized: 'Sign in again before deleting your account.',
  reauthentication_failed: 'Your password could not be confirmed.',
  invalid_request: 'Confirm deletion and enter your current password.',
  origin_not_allowed: 'This app origin is not allowed.',
  rate_limited: 'Too many attempts. Wait before trying again.',
  deletion_incomplete: 'Account deletion did not finish. Retry to complete it. Gmail connections may already be disconnected.',
};
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '') || Number(request.headers.get('content-length') ?? 0) > 8192 || !request.body) throw new AccountError(400, 'invalid_request');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 8192) { await reader.cancel(); throw new AccountError(400, 'invalid_request'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new AccountError(400, 'invalid_request'); }
}
export async function deleteAccount(backend: AccountDeletionBackend, actor: AccountActor): Promise<{ deleted: true; revocationPending: boolean }> {
  let lease: DeletionLease | undefined;
  try {
    lease = await backend.begin(actor);
    if (lease.userId !== actor.userId || !/^[a-f0-9-]{36}$/i.test(lease.leaseId)) throw new AccountError(503, 'deletion_incomplete');
    const started = Date.now();
    for (let batch = 0; batch < 40 && Date.now() - started < 25000; batch++) {
      const names = await backend.files(lease);
      if (!Array.isArray(names) || names.length > 100 || names.some(name => typeof name !== 'string' || name.length > 2048 || !name.startsWith(`${actor.userId}/`))) throw new AccountError(503, 'deletion_incomplete');
      if (!names.length) {
        await backend.purgeWorkspace(lease);
        await backend.deleteAuthUser(actor.userId);
        // Auth and private data are already gone. A status lookup failure must
        // not ask someone to sign back into the account we just deleted.
        const result = await backend.finish(lease).catch(() => ({ revocationPending: true }));
        return { deleted: true, revocationPending: result.revocationPending };
      }
      await backend.removeFiles(names);
    }
    throw new AccountError(503, 'deletion_incomplete');
  } catch {
    if (lease?.userId === actor.userId) await backend.release(lease).catch(() => undefined);
    throw new AccountError(503, 'deletion_incomplete');
  }
}
export function createAccountHandler(dependencies: AccountDependencies) {
  const allowed = new Set(dependencies.allowedOrigins ?? defaults);
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (origin && allowed.has(origin)) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    try {
      if (origin && !allowed.has(origin)) throw new AccountError(403, 'origin_not_allowed');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Max-Age': '600' } });
      if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);
      const actor = await dependencies.authenticate(request);
      if (!actor) throw new AccountError(401, 'unauthorized');
      const body = await readBody(request);
      if (body.action !== 'delete' || body.confirmation !== 'DELETE' || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 1024 || Object.keys(body).some(key => !['action', 'confirmation', 'password'].includes(key))) throw new AccountError(400, 'invalid_request');
      if (!await dependencies.verifyPassword(actor, body.password)) throw new AccountError(403, 'reauthentication_failed');
      return respond(await deleteAccount(dependencies.backend, actor));
    } catch (error) {
      const known = error instanceof AccountError && errors[error.code];
      return respond({ error: known || errors.deletion_incomplete, code: known ? error.code : 'deletion_incomplete' }, known ? error.status : 503);
    }
  };
}
