import type { Application } from '../../../shared/types.ts';

export interface WorkspaceState {
  version: 1;
  applications: Application[];
  metadata: Array<{ key: string; value: unknown }>;
  processed: Array<{ source: string; workspace: string; source_id: string; application_id: string; evidence_id: string }>;
}
export interface GmailSyncCursor {
  phase: 'initial' | 'history';
  historyId: string | null;
  pageToken: string | null;
  baselineHistoryId: string | null;
  pendingMessageIds: string[];
  pendingNextPageToken: string | null;
  pendingHistoryId: string | null;
}
export interface GmailSyncConnection extends GmailSyncCursor {
  id: string;
  userId: string;
  email: string;
  generation: string;
  connectedAt: string;
  lastSyncAt: string | null;
  syncAfter: string;
}
export interface GmailSyncResult extends GmailSyncCursor {
  processed: number;
  imported: number;
  queued: number;
  more: boolean;
}
export interface GmailApi {
  request<T>(path: string, query?: Record<string, string>): Promise<T>;
}
export interface GmailSyncBackend {
  readWorkspace(): Promise<{ revision: number; state: WorkspaceState }>;
  commitWorkspace(revision: number, state: WorkspaceState): Promise<boolean>;
}
export interface GmailSyncContext {
  connection: GmailSyncConnection;
  gmail: GmailApi;
  backend: GmailSyncBackend;
  signal: AbortSignal;
}
export type GmailErrorCode = 'response_too_large' | 'invalid_response' | 'reconnect_required' | 'rate_limited' | 'unavailable' | 'lease_lost';
export class GmailHttpError extends Error {
  constructor(public readonly status: number, public readonly code: GmailErrorCode, message = 'Gmail could not complete this request.') { super(message); }
}
export interface GmailInbox {
  id: string;
  provider: 'gmail';
  email: string;
  status: 'connected' | 'error' | 'reconnect_required';
  lastSyncAt: string | null;
  connectedAt: string;
  error: string | null;
  syncing: boolean;
}
export interface GmailTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string; }
export interface OAuthState {
  stateHash: string;
  userId: string;
  sessionId: string;
  verifierCipher: string;
  inboxId: string | null;
  expectedEmail: string | null;
}
export interface GmailLease {
  connection: GmailSyncConnection;
  leaseId: string;
  tokenCipher: string;
}
export const emptyCursor = (): GmailSyncCursor => ({ phase: 'initial', historyId: null, pageToken: null, baselineHistoryId: null, pendingMessageIds: [], pendingNextPageToken: null, pendingHistoryId: null });
