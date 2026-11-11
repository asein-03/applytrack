import { GmailHttpError, type GmailInbox, type GmailLease, type GmailSyncBackend, type GmailSyncCursor, type OAuthState } from './shared.ts';

interface RpcClient { rpc(name: string, arguments_: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }>; }
export interface GmailIdentity { userId: string; sessionId: string; }
export interface RevocationLease { id: string; userId: string; generation: string; tokenCipher: string; leaseId: string; }
export class StorageError extends Error {
  constructor(public readonly code: string) { super('Gmail storage operation could not be completed.'); }
}
export class GmailStorage {
  constructor(private readonly client: RpcClient) {}
  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc('apply_gmail_store', { p_action: action, p_payload: payload });
    if (error) {
      if (error.code === '40001') throw new GmailHttpError(409, 'lease_lost');
      throw new StorageError(error.code || 'unavailable');
    }
    return data as T;
  }
  async consumeDispatch(nonceHash: string, issuedAt: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('apply_gmail_consume_dispatch', { p_nonce_hash: nonceHash, p_issued_at: issuedAt });
    if (error) throw new StorageError(error.code || 'unavailable');
    return data === true;
  }
  createOAuth(state: Omit<OAuthState, 'expectedEmail'>): Promise<boolean> { return this.call('create_oauth', { ...state }); }
  authorizeAttempt(stateHash: string): Promise<boolean> { return this.call('authorize_attempt', { stateHash }); }
  authorizeOAuth(stateHash: string, userId: string, browserHash: string): Promise<OAuthState | null> { return this.call('authorize_oauth', { stateHash, userId, browserHash }); }
  consumeOAuth(stateHash: string, browserHash: string): Promise<OAuthState | null> { return this.call('consume_oauth', { stateHash, browserHash }); }
  target(identity: GmailIdentity, emailHash: string, inboxId: string | null): Promise<{ id: string; existingGeneration: string | null }> { return this.call('target', { ...identity, emailHash, inboxId }); }
  save(identity: GmailIdentity, connection: { inboxId: string; email: string; emailHash: string; generation: string; tokenCipher: string; existingGeneration: string | null; stateHash: string }): Promise<boolean> {
    return this.call('save_connection', { ...identity, ...connection });
  }
  status(identity: GmailIdentity): Promise<GmailInbox[]> { return this.call('status', { ...identity }); }
  enqueue(identity: GmailIdentity, inboxId: string): Promise<boolean> { return this.call('enqueue', { ...identity, inboxId }); }
  disconnect(identity: GmailIdentity, inboxId: string): Promise<boolean | null> { return this.call('disconnect', { ...identity, inboxId }); }
  claim(inboxId?: string): Promise<GmailLease | null> { return this.call('claim', { inboxId }); }
  private leasePayload(lease: GmailLease) { return { inboxId: lease.connection.id, generation: lease.connection.generation, leaseId: lease.leaseId }; }
  backend(lease: GmailLease): GmailSyncBackend {
    return {
      readWorkspace: () => this.call('workspace_read', this.leasePayload(lease)),
      commitWorkspace: (revision, state) => this.call('workspace_commit', { ...this.leasePayload(lease), revision, state }),
    };
  }
  assertLease(lease: GmailLease): Promise<boolean> { return this.call('assert_lease', this.leasePayload(lease)); }
  updateTokens(lease: GmailLease, tokenCipher: string): Promise<boolean> { return this.call('update_tokens', { ...this.leasePayload(lease), tokenCipher }); }
  finish(lease: GmailLease, cursor: GmailSyncCursor, more: boolean): Promise<boolean> { return this.call('finish', { ...this.leasePayload(lease), cursor, more }); }
  fail(lease: GmailLease, code: string): Promise<boolean> { return this.call('fail', { ...this.leasePayload(lease), code }); }
  revocationPending(identity: GmailIdentity, inboxId: string): Promise<boolean> { return this.call('revocation_pending', { ...identity, inboxId }); }
  claimRevocation(inboxId?: string): Promise<RevocationLease | null> { return this.call('claim_revocation', { inboxId }); }
  finishRevocation(lease: RevocationLease, success: boolean): Promise<boolean> { return this.call('finish_revocation', { inboxId: lease.id, leaseId: lease.leaseId, success }); }
}
