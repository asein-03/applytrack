import { z } from 'zod';
import type { GmailStatus, GmailSyncResult, GmailDisconnectResult } from '../shared/types.js';
import type { CloudActor, CloudService } from './cloud.js';
import { HttpError } from './store.js';
import { safeGmailAuthorizationUrl } from '../shared/gmail.js';

const inboxSchema = z.object({
  id: z.string().min(1).max(100), provider: z.literal('gmail'), email: z.email().max(320),
  status: z.enum(['connected', 'error', 'reconnect_required']), lastSyncAt: z.iso.datetime({ offset: true }).nullable(),
  connectedAt: z.iso.datetime({ offset: true }).optional(), syncing: z.boolean().optional(), error: z.string().max(1000).nullable().optional(),
});
const statusSchema = z.object({ gmailConfigured: z.boolean(), inboxes: z.array(inboxSchema).max(50) });
const syncSchema = z.object({ syncing: z.literal(true) });
export function gmailAuthorizationUrl(value: unknown): string {
  const url = safeGmailAuthorizationUrl(value);
  if (!url) throw new HttpError(502, 'Gmail returned an invalid connection link. Try again.');
  return url;
}

export class CloudGmail {
  private cache = new Map<string, { expires: number; status: GmailStatus }>();
  private loading = new Map<string, Promise<GmailStatus>>();
  private generation = new Map<string, number>();
  private invalidate(id: string) { this.generation.set(id, (this.generation.get(id) ?? 0) + 1); this.cache.delete(id); this.loading.delete(id); }
  constructor(private cloud: Pick<CloudService, 'url' | 'publishableKey'>, private request: typeof fetch = fetch) {}
  private async action(actor: CloudActor, action: 'status' | 'connect' | 'sync' | 'disconnect', inboxId?: string): Promise<unknown> {
    if (!this.cloud.url) throw new HttpError(503, 'Gmail connections are not available yet.');
    let response: Response;
    try {
      response = await this.request(`${this.cloud.url}/functions/v1/gmail`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${actor.accessToken}`, apikey: this.cloud.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(inboxId ? { inboxId } : {}) }), signal: AbortSignal.timeout(action === 'status' ? 6000 : 20000),
      });
    } catch { throw new HttpError(503, 'Gmail could not be reached. Try again shortly.'); }
    if (!response.ok) {
      const messages: Record<number, string> = { 401: 'Your ApplyTrack session expired. Sign in again.', 403: 'Gmail access is unavailable. Reconnect this inbox.', 404: 'Inbox not found.', 409: 'Gmail access changed. Reconnect this inbox.', 429: 'Gmail is busy. Try again shortly.', 503: 'Gmail connections are not available yet.' };
      throw new HttpError([401, 403, 404, 409, 429, 503].includes(response.status) ? response.status : 502, messages[response.status] ?? 'Gmail could not complete this request. Try again.');
    }
    if (response.status === 204) return {};
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, 'Gmail returned an empty response. Try again.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 256000) { await reader.cancel(); throw new HttpError(502, 'Gmail returned an invalid response. Try again.'); } chunks.push(value); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new HttpError(502, 'Gmail returned an invalid response. Try again.'); }
    } finally { reader.releaseLock(); }
  }
  async status(actor: CloudActor, fresh = false): Promise<GmailStatus> {
    const saved = this.cache.get(actor.id);
    if (!fresh && saved && saved.expires > Date.now()) return saved.status;
    const loading = this.loading.get(actor.id); if (loading) return loading;
    const generation = this.generation.get(actor.id) ?? 0;
    const task = (async () => {
      let status: GmailStatus;
      try {
        const parsed = statusSchema.parse(await this.action(actor, 'status'));
        status = { ...parsed, gmailSyncMode: 'cloud', gmailStatusError: null, inboxes: parsed.inboxes.map(inbox => ({ ...inbox, error: inbox.status === 'reconnect_required' ? 'Gmail access expired. Reconnect this inbox.' : inbox.status === 'error' ? 'The last inbox check failed. Try syncing again.' : null })) };
      } catch { status = { gmailConfigured: saved?.status.gmailConfigured ?? false, inboxes: saved?.status.inboxes ?? [], gmailSyncMode: 'cloud', gmailStatusError: 'Gmail status is unavailable. Your application tracking is still working.' }; }
      if (this.cache.size >= 30 && !this.cache.has(actor.id)) this.cache.delete(this.cache.keys().next().value!);
      if ((this.generation.get(actor.id) ?? 0) === generation) this.cache.set(actor.id, { status, expires: Date.now() + (status.gmailStatusError ? 5000 : 15000) });
      return status;
    })();
    this.loading.set(actor.id, task);
    try { return await task; } finally { if (this.loading.get(actor.id) === task) this.loading.delete(actor.id); }
  }
  async connect(actor: CloudActor, inboxId?: string) { const result = await this.action(actor, 'connect', inboxId) as { url?: unknown }; return { url: gmailAuthorizationUrl(result?.url) }; }
  async sync(actor: CloudActor, inboxId: string): Promise<GmailSyncResult> { const result = syncSchema.safeParse(await this.action(actor, 'sync', inboxId)); if (!result.success) throw new HttpError(502, 'Gmail returned an invalid sync response. Try again.'); this.invalidate(actor.id); return result.data; }
  async disconnect(actor: CloudActor, inboxId: string): Promise<GmailDisconnectResult> { const result = z.object({ disconnected: z.literal(true), revocationPending: z.boolean().optional() }).safeParse(await this.action(actor, 'disconnect', inboxId)); if (!result.success) throw new HttpError(502, 'Gmail returned an invalid disconnection response. Check the connection status.'); this.invalidate(actor.id); return result.data; }
}
const clients = new WeakMap<CloudService, CloudGmail>();
export function cloudGmail(cloud: CloudService) { let client = clients.get(cloud); if (!client) { client = new CloudGmail(cloud); clients.set(cloud, client); } return client; }
