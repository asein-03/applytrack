import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Application, Workspace } from '../shared/types.js';
import { HttpError, Store } from './store.js';
import { createVault } from './vault.js';

export interface CloudActor { id: string; email: string | null; accessToken: string; client: SupabaseClient; }
interface DeviceSession { userId: string; accessToken: string; refreshToken?: string; }
export interface WorkspaceState {
  version: 1; applications: Application[];
  metadata: Array<{ key: string; value: unknown }>;
  processed: Array<{ source: string; workspace: string; source_id: string; application_id: string; evidence_id: string }>;
}
export const DOCUMENT_BUCKET = 'apply-documents';
const stateMetadata = /^(evidence-task:|evidence-document:|email-review:|email-seen:|document-deletion:|deleted-event:|document-label:|reminder:)/;
export const emptyWorkspace = (): WorkspaceState => ({ version: 1, applications: [], metadata: [], processed: [] });

export function exportWorkspace(store: Store): WorkspaceState {
  return { version: 1, applications: store.listApplications('personal'), metadata: store.listMeta('').filter(item => stateMetadata.test(item.key)), processed: store.db.prepare("SELECT * FROM processed_events WHERE workspace='personal'").all() as unknown as WorkspaceState['processed'] };
}
export function hydrateWorkspace(state: WorkspaceState): Store {
  if (state.version !== 1 || !Array.isArray(state.applications) || !Array.isArray(state.metadata) || !Array.isArray(state.processed)) throw new HttpError(502, 'The cloud workspace has an unsupported format.');
  const store = new Store(':memory:');
  try {
    for (const app of state.applications) { if (app.workspace !== 'personal') throw new HttpError(502, 'The cloud workspace contains an invalid record.'); store.saveApplication(app); }
    for (const item of state.metadata) if (stateMetadata.test(item.key)) store.setMeta(item.key, item.value);
    for (const item of state.processed) store.db.prepare('INSERT OR IGNORE INTO processed_events VALUES (?,?,?,?,?)').run(item.source, 'personal', item.source_id, item.application_id, item.evidence_id);
    return store;
  } catch (error) { store.close(); throw error; }
}

/** Prefixes only device-runtime metadata. Application data uses WorkspaceRepository. */
export function scopedRuntime(store: Store, userId: string): Store {
  const prefix = `user:${userId}:`;
  const proxy = new Proxy(store, { get(target, property) {
    if (property === 'getMeta') return (key: string) => target.getMeta(prefix + key);
    if (property === 'setMeta') return (key: string, value: unknown) => target.setMeta(prefix + key, value);
    if (property === 'deleteMeta') return (key: string) => target.deleteMeta(prefix + key);
    if (property === 'listMeta') return (key: string) => target.listMeta(prefix + key).map(item => ({ ...item, key: item.key.slice(prefix.length) }));
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(proxy) : value;
  } });
  return proxy;
}

function isPublishableKey(value: string): boolean {
  if (value.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).role === 'anon'; } catch { return false; }
}

export class CloudService {
  readonly url: string;
  readonly publishableKey: string;
  readonly configured: boolean;
  private vaultInstance?: ReturnType<typeof createVault>;
  private bindingGeneration = 0;
  private refreshInFlight: Promise<CloudActor> | null = null;
  private get vault() { return this.vaultInstance ??= createVault(this.dataDir); }
  constructor(readonly runtime: Store, private dataDir: string, readonly enabled: boolean) {
    this.url = process.env.SUPABASE_URL ?? '';
    this.publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
    this.configured = !!(this.url && this.publishableKey);
    if (this.configured && (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(this.url) || !isPublishableKey(this.publishableKey))) throw new Error('Use the project HTTPS URL and publishable key for Supabase.');
    // Capture requires a fresh device session after process restart.
    const previousUser = this.runtime.getMeta<string>('activeCloudUser');
    if (previousUser) scopedRuntime(this.runtime, previousUser).stopSession();
  }
  config() { return { enabled: this.enabled, configured: this.configured, ...(this.configured ? { url: this.url, publishableKey: this.publishableKey } : {}) }; }
  client(accessToken?: string) {
    if (!this.configured) throw new HttpError(503, 'Cloud storage is not configured. Set the Supabase project URL and publishable key.');
    return createClient(this.url, this.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}) });
  }
  async verify(accessToken: string): Promise<CloudActor> {
    if (!accessToken || accessToken.length > 16000) throw new HttpError(401, 'Sign in to your Apply account.');
    const client = this.client(accessToken);
    const { data, error } = await client.auth.getUser(accessToken);
    if (error && ![400, 401, 403, 404, 422].includes(error.status ?? 0)) throw new HttpError(503, 'Account verification is unavailable. Check your connection and retry.');
    if (error || !data.user) throw new HttpError(401, 'Your Apply session expired. Sign in again.');
    return { id: data.user.id, email: data.user.email ?? null, accessToken, client };
  }
  private isPairToken(token: string) {
    const expected = Buffer.from(this.runtime.getMeta<string>('extensionToken') ?? '');
    const actual = Buffer.from(token);
    return expected.length > 0 && actual.length === expected.length && timingSafeEqual(expected, actual);
  }
  async authenticate(request: Request): Promise<CloudActor> {
    const token = request.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (this.isPairToken(token)) return this.activeActor();
    return this.verify(token);
  }
  async bind(accessToken: string, refreshToken?: string): Promise<CloudActor> {
    const generation = ++this.bindingGeneration;
    const actor = await this.verify(accessToken);
    if (generation !== this.bindingGeneration) throw new HttpError(409, 'A newer account request replaced this session.');
    const previous = this.runtime.getMeta<string>('activeCloudUser');
    if (previous !== actor.id) {
      if (previous) scopedRuntime(this.runtime, previous).stopSession();
      this.runtime.setMeta('extensionToken', randomBytes(32).toString('hex'));
    }
    const previousEncrypted = this.runtime.getMeta<string>(`cloud-session:${actor.id}`);
    const previousSession = previousEncrypted ? this.vault.decrypt<DeviceSession>(previousEncrypted) : null;
    this.runtime.setMeta(`cloud-session:${actor.id}`, this.vault.encrypt({ userId: actor.id, accessToken, refreshToken: refreshToken ?? previousSession?.refreshToken } satisfies DeviceSession));
    this.runtime.setMeta('activeCloudUser', actor.id);
    return actor;
  }
  async activeActor(): Promise<CloudActor> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const id = this.runtime.getMeta<string>('activeCloudUser');
    const generation = this.bindingGeneration;
    const operation = this.resolveActiveActor().catch(error => {
      if (id && generation === this.bindingGeneration && this.runtime.getMeta('activeCloudUser') === id && error instanceof HttpError && [401, 403].includes(error.status)) this.unbind(id);
      throw error;
    });
    this.refreshInFlight = operation;
    try { return await operation; } finally { if (this.refreshInFlight === operation) this.refreshInFlight = null; }
  }
  private assertCurrentBinding(id: string, generation: number): void {
    if (this.runtime.getMeta('activeCloudUser') !== id) throw new HttpError(409, 'The active account changed.');
    if (generation !== this.bindingGeneration) throw new HttpError(503, 'Your account session was refreshed. Retry this capture.');
  }
  private async resolveActiveActor(): Promise<CloudActor> {
    const generation = this.bindingGeneration;
    const id = this.runtime.getMeta<string>('activeCloudUser');
    const encrypted = id ? this.runtime.getMeta<string>(`cloud-session:${id}`) : null;
    if (!id || !encrypted) throw new HttpError(401, 'Sign in to Apply and pair this extension again.');
    const session = this.vault.decrypt<DeviceSession>(encrypted);
    try {
      const actor = await this.verify(session.accessToken);
      this.assertCurrentBinding(id, generation);
      if (actor.id !== id || session.userId !== id) throw new HttpError(409, 'The active account changed.');
      return actor;
    }
    catch (error) {
      this.assertCurrentBinding(id, generation);
      if (!(error instanceof HttpError) || error.status !== 401 || !session.refreshToken) throw error;
      const { data, error: refreshError } = await this.client().auth.refreshSession({ refresh_token: session.refreshToken });
      this.assertCurrentBinding(id, generation);
      if (refreshError && ![400, 401, 403, 404, 422].includes(refreshError.status ?? 0)) throw new HttpError(503, 'Account refresh is unavailable. Check your connection and retry.');
      if (refreshError || !data.session || data.user?.id !== id) throw new HttpError(401, 'Sign in to Apply again to resume tracking.');
      const actor = await this.verify(data.session.access_token);
      this.assertCurrentBinding(id, generation);
      if (actor.id !== id) throw new HttpError(409, 'The active account changed.');
      this.runtime.setMeta(`cloud-session:${id}`, this.vault.encrypt({ userId: id, accessToken: data.session.access_token, refreshToken: data.session.refresh_token } satisfies DeviceSession));
      return actor;
    }
  }
  unbind(userId: string) {
    const activeUser = this.runtime.getMeta<string>('activeCloudUser');
    if (!activeUser) return;
    if (activeUser !== userId) throw new HttpError(409, 'This is not the active device account.');
    this.bindingGeneration++;
    scopedRuntime(this.runtime, userId).stopSession();
    this.runtime.deleteMeta(`cloud-session:${userId}`); this.runtime.deleteMeta('activeCloudUser');
    this.runtime.setMeta('extensionToken', randomBytes(32).toString('hex'));
  }
  runtimeFor(actor: CloudActor) { return scopedRuntime(this.runtime, actor.id); }
}

export interface CloudTransport {
  read(actor: CloudActor): Promise<{ revision: number; state: WorkspaceState }>;
  commit(actor: CloudActor, revision: number, state: WorkspaceState): Promise<boolean>;
}
export const supabaseTransport: CloudTransport = {
  async read(actor) {
    const { data, error } = await actor.client.from('apply_workspaces').select('revision,state').eq('user_id', actor.id).maybeSingle();
    if (error) throw new HttpError(502, 'Cloud applications could not be loaded. Check the connection and retry.');
    return data ? { revision: Number(data.revision), state: data.state as WorkspaceState } : { revision: 0, state: emptyWorkspace() };
  },
  async commit(actor, revision, state) {
    const { data, error } = await actor.client.rpc('apply_commit_workspace', { expected_revision: revision, next_state: state });
    if (error) throw new HttpError(502, 'Cloud changes could not be saved. Check the connection and retry.');
    return data !== null;
  },
};

export class WorkspaceRepository {
  constructor(readonly local: Store, readonly cloud: CloudService, private transport: CloudTransport = supabaseTransport) {}
  async run<T>(workspace: Workspace, actor: CloudActor | null, write: boolean, action: (store: Store) => T | Promise<T>): Promise<T> {
    if (!this.cloud.enabled || workspace === 'demo') return action(this.local);
    if (!actor) throw new HttpError(this.cloud.configured ? 401 : 503, this.cloud.configured ? 'Sign in to load your applications.' : 'Cloud storage is not configured.');
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.transport.read(actor);
      const memory = hydrateWorkspace(current.state);
      try {
        const result = await action(memory);
        if (!write) return result;
        const next = exportWorkspace(memory);
        if (JSON.stringify(current.state) === JSON.stringify(next) || await this.transport.commit(actor, current.revision, next)) return result;
      } finally { memory.close(); }
    }
    throw new HttpError(409, 'Your applications changed on another device. Try again.');
  }
}
