import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CloudService, WorkspaceRepository, emptyWorkspace, type CloudActor, type CloudTransport, type WorkspaceState } from '../server/cloud.js';
import { Store, HttpError } from '../server/store.js';
import { createApp, apiErrorHandler } from '../server/app.js';
import { attachEmailRoutes } from '../server/email.js';

export class MemoryCloudTransport implements CloudTransport {
  states = new Map<string, { revision: number; state: WorkspaceState }>();
  attempts = 0;
  async read(actor: CloudActor) { return structuredClone(this.states.get(actor.id) ?? { revision: 0, state: emptyWorkspace() }); }
  async commit(actor: CloudActor, revision: number, state: WorkspaceState) {
    this.attempts++;
    if ((this.states.get(actor.id)?.revision ?? 0) !== revision) return false;
    this.states.set(actor.id, { revision: revision + 1, state: structuredClone(state) }); return true;
  }
}
export class MemoryFiles {
  values = new Map<string, Uint8Array>();
  failUpload = false; failRemove = false;
  beforeUpload?: () => Promise<void>;
  client(userId: string): SupabaseClient {
    const allowed = (path: string) => path.startsWith(`${userId}/`);
    return { storage: { from: () => ({
      upload: async (path: string, bytes: Uint8Array) => {
        await this.beforeUpload?.();
        if (this.failUpload || !allowed(path)) return { error: { statusCode: '403', message: 'Denied' } };
        if (this.values.has(path)) return { error: { statusCode: '409', message: 'Already exists' } };
        this.values.set(path, Uint8Array.from(bytes)); return { error: null };
      },
      download: async (path: string) => { const bytes = allowed(path) ? this.values.get(path) : null; return bytes ? { error: null, data: new Blob([Uint8Array.from(bytes)]) } : { error: { message: 'Not found' }, data: null }; },
      remove: async (paths: string[]) => {
        if (this.failRemove || paths.some(path => !allowed(path))) return { error: { message: 'Unavailable' } };
        for (const path of paths) this.values.delete(path); return { error: null };
      },
    }) } } as unknown as SupabaseClient;
  }
}
export class TestCloud extends CloudService {
  override readonly configured = true;
  actors = new Map<string, CloudActor>();
  override async verify(token: string): Promise<CloudActor> {
    const actor = this.actors.get(token);
    if (!actor) throw new HttpError(401, 'Sign in again.');
    return actor;
  }
}
export async function cloudFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'apply-cloud-'));
  const store = new Store(':memory:');
  const files = new MemoryFiles();
  const cloud = new TestCloud(store, directory, true);
  for (const [token, id] of [['alice', '11111111-1111-4111-8111-111111111111'], ['bob', '22222222-2222-4222-8222-222222222222']]) cloud.actors.set(token, { id, email: `${token}@example.test`, accessToken: token, client: files.client(id) });
  const transport = new MemoryCloudTransport();
  const repository = new WorkspaceRepository(store, cloud, transport);
  const { app, close } = createApp({ cloud, repository });
  const email = attachEmailRoutes(app, store, { dataDir: directory, cloud, repository, poll: false });
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const api = (path: string, options: RequestInit = {}, token: string | null = 'alice') => fetch(base + path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  return { store, cloud, repository, transport, files, api, async close() { email.stop(); await new Promise<void>(resolve => server.close(() => resolve())); close(); rmSync(directory, { recursive: true, force: true }); } };
}
export const post = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
