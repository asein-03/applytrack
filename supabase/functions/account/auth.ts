import { AccountError, type AccountActor } from './handler.ts';
interface AccountUser { id: string; email?: string; email_confirmed_at?: string; is_anonymous?: boolean; }
interface AuthResponse { data: { user: AccountUser | null }; error: { status?: number } | null; }
export interface AccountAuthClient {
  auth: {
    getUser(token: string): Promise<AuthResponse>;
    signInWithPassword(input: { email: string; password: string }): Promise<AuthResponse>;
    signOut(input: { scope: 'local' }): Promise<unknown>;
  };
  rpc(name: string): PromiseLike<{ data: unknown; error: unknown }>;
}
export function accountAuthentication(clientFor: (authorization?: string) => AccountAuthClient) {
  return {
    async authenticate(request: Request): Promise<AccountActor | null> {
      const authorization = request.headers.get('Authorization') || '';
      if (!/^Bearer [A-Za-z0-9._-]{20,16384}$/.test(authorization)) return null;
      const token = authorization.slice(7); const client = clientFor(authorization);
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user?.email || !data.user.email_confirmed_at || data.user.is_anonymous) return null;
      const active = await client.rpc('apply_has_active_session');
      if (active.error || active.data !== true) return null;
      try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.sub !== data.user.id || typeof payload.session_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(payload.session_id)) return null;
        return { userId: data.user.id, sessionId: payload.session_id, email: data.user.email };
      } catch { return null; }
    },
    async verifyPassword(actor: AccountActor, password: string): Promise<boolean> {
      const verifier = clientFor();
      try {
        const { data, error } = await verifier.auth.signInWithPassword({ email: actor.email, password });
        if (error?.status === 429) throw new AccountError(429, 'rate_limited');
        if (error && ![400, 401, 403, 422].includes(error.status ?? 0)) throw new AccountError(503, 'deletion_incomplete');
        return !error && data.user?.id === actor.userId && !!data.user.email_confirmed_at && !data.user.is_anonymous;
      } finally {
        // This fresh verification session must never sign out existing devices.
        await verifier.auth.signOut({ scope: 'local' }).catch(() => undefined);
      }
    },
  };
}
