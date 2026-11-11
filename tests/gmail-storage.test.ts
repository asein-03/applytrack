import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { emptyCursor } from '../supabase/functions/gmail/shared.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const session = '33333333-3333-4333-8333-333333333333';
const otherSession = '44444444-4444-4444-8444-444444444444';
const identity = { userId: owner, sessionId: session };
const otherIdentity = { userId: other, sessionId: otherSession };
const cipher = 'v1.synthetic-nonce.synthetic-ciphertext-for-database-tests';
const emailHash = 'a'.repeat(64);
const browserHash = 'b'.repeat(64);
let db: PGlite;
async function rpc<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await db.query<{ result: T }>('select public.apply_gmail_store($1,$2::jsonb) as result', [action, JSON.stringify(payload)]);
  return result.rows[0].result;
}
async function oauth(who = identity, inboxId?: string) {
  const stateHash = randomUUID().replaceAll('-', '').repeat(2);
  await rpc('create_oauth', { ...who, stateHash, verifierCipher: cipher, inboxId });
  assert.equal(await rpc('authorize_attempt', { stateHash }), true);
  assert(await rpc('authorize_oauth', { stateHash, userId: who.userId, browserHash }));
  assert(await rpc('consume_oauth', { stateHash, browserHash }));
  return stateHash;
}
async function connect(who = identity, hash = emailHash, existingId?: string) {
  const stateHash = await oauth(who, existingId);
  const target = await rpc<{ id: string; existingGeneration: string | null }>('target', { ...who, emailHash: hash, inboxId: existingId });
  const payload = { ...who, inboxId: target.id, stateHash, emailHash: hash, email: 'applicant@example.com', existingGeneration: target.existingGeneration, generation: randomUUID(), tokenCipher: cipher };
  assert.equal(await rpc('save_connection', payload), true);
  return payload;
}
function code(expected: string) { return (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === expected); }

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private; create schema extensions; create schema net; create schema vault;
    grant usage on schema private, net to authenticated;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false,banned_until timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create table public.apply_workspaces(user_id uuid primary key references auth.users(id) on delete cascade,revision bigint not null check(revision>0),state jsonb not null check(jsonb_typeof(state)='object' and state->>'version'='1' and jsonb_typeof(state->'applications')='array'),updated_at timestamptz not null default now());
    alter table public.apply_workspaces enable row level security;
    alter table public.apply_workspaces force row level security;
    create table net.http_request_queue(id bigint);
    create table net._http_response(id bigint);
    grant select on net.http_request_queue,net._http_response to public,anon,authenticated;
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$select 42::bigint$$;
    create table vault.secrets(name text,secret text);
    create table vault.decrypted_secrets(name text,decrypted_secret text);
    grant select on vault.secrets,vault.decrypted_secrets to public,anon,authenticated;
  `);
  const migration = await readFile(new URL('../supabase/migrations/20261111041447_hosted_gmail.sql', import.meta.url), 'utf8');
  // pg_net performs outbound HTTP, unavailable in the embedded PostgreSQL engine.
  // Only its extension installation is substituted; all application SQL executes.
  await db.exec(migration.replace('create extension if not exists pg_net with schema extensions;', ''));
});
beforeEach(async () => {
  await db.exec(`reset role; select set_config('request.jwt.claims','{"role":"service_role"}',false); truncate auth.users cascade;`);
  await db.query('insert into auth.users(id,email_confirmed_at) values($1,now()),($2,now())', [owner, other]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4)', [session, owner, otherSession, other]);
});
after(async () => { await db.close(); });

test('private Gmail tables, dispatcher, and RPC are inaccessible to application roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    const result = await db.query<{ rpc: boolean; dispatch: boolean; table_read: boolean; queue_read: boolean; vault_read: boolean; vault_encrypted_read: boolean }>(`select
      has_function_privilege($1,'public.apply_gmail_store(text,jsonb)','execute') as rpc,
      has_function_privilege($1,'private.apply_dispatch_gmail()','execute') as dispatch,
      has_table_privilege($1,'private.apply_gmail_connections','select') as table_read,
      has_table_privilege($1,'net.http_request_queue','select') as queue_read,
      has_table_privilege($1,'vault.decrypted_secrets','select') as vault_read,
      has_table_privilege($1,'vault.secrets','select') as vault_encrypted_read`, [role]);
    assert.deepEqual(result.rows[0], { rpc: false, dispatch: false, table_read: false, queue_read: false, vault_read: false, vault_encrypted_read: false });
  }
  await db.exec(`select set_config('request.jwt.claims','{"role":"authenticated"}',false)`);
  await assert.rejects(rpc('status', identity), code('42501'));
  await db.exec('set role authenticated');
  await assert.rejects(rpc('status', identity), code('42501'));
  await assert.rejects(db.query('select * from private.apply_gmail_connections'), code('42501'));
});

test('OAuth authorization binds the user and browser, expires, limits attempts, and consumes once', async () => {
  const stateHash = 'c'.repeat(64);
  await rpc('create_oauth', { ...identity, stateHash, verifierCipher: cipher });
  assert.equal(await rpc('authorize_oauth', { stateHash, userId: other, browserHash }), null);
  assert.equal(await rpc('consume_oauth', { stateHash, browserHash }), null);
  for (let index = 0; index < 5; index++) assert.equal(await rpc('authorize_attempt', { stateHash }), true);
  assert.equal(await rpc('authorize_attempt', { stateHash }), false);
  assert(await rpc('authorize_oauth', { stateHash, userId: owner, browserHash }));
  assert.equal(await rpc('consume_oauth', { stateHash, browserHash: 'd'.repeat(64) }), null);
  assert(await rpc('consume_oauth', { stateHash, browserHash }));
  assert.equal(await rpc('consume_oauth', { stateHash, browserHash }), null);
  const expired = 'e'.repeat(64);
  await rpc('create_oauth', { ...identity, stateHash: expired, verifierCipher: cipher });
  await db.query('update private.apply_gmail_oauth set expires_at=now()-interval \'1 second\' where state_hash=$1', [expired]);
  assert.equal(await rpc('authorize_attempt', { stateHash: expired }), false);
  for (let index = 0; index < 4; index++) await rpc('create_oauth', { ...identity, stateHash: String(index).repeat(64), verifierCipher: cipher });
  await assert.rejects(rpc('create_oauth', { ...identity, stateHash: '9'.repeat(64), verifierCipher: cipher }), code('54000'));
});

test('disconnect cancels consumed callbacks and leases, and revocation blocks every owner until completed', async () => {
  const connection = await connect();
  const stateHash = await oauth(identity, connection.inboxId);
  const target = await rpc<{ id: string; existingGeneration: string }>('target', { ...identity, inboxId: connection.inboxId, emailHash });
  const lease = await rpc<{ leaseId: string }>('claim', { inboxId: connection.inboxId });
  assert(lease);
  assert.equal(await rpc('disconnect', { ...otherIdentity, inboxId: connection.inboxId }), null);
  assert.equal(await rpc('disconnect', { ...identity, inboxId: connection.inboxId }), true);
  await assert.rejects(rpc('save_connection', { ...connection, stateHash, generation: randomUUID(), existingGeneration: target.existingGeneration }), code('28000'));
  for (const action of ['assert_lease', 'workspace_read', 'workspace_commit', 'update_tokens', 'finish', 'fail']) {
    await assert.rejects(rpc(action, { inboxId: connection.inboxId, generation: connection.generation, leaseId: lease.leaseId, revision: 0, state: { version: 1, applications: [], metadata: [], processed: [] }, tokenCipher: cipher, cursor: emptyCursor(), more: false }), code('40001'));
  }
  await assert.rejects(rpc('target', { ...identity, emailHash }), code('55000'));
  await assert.rejects(rpc('target', { ...otherIdentity, emailHash }), code('55000'));
  assert.equal(await rpc('claim'), null);
  const revocation = await rpc<{ leaseId: string }>('claim_revocation', { inboxId: connection.inboxId });
  assert(revocation);
  assert.equal(await rpc('claim_revocation', { inboxId: connection.inboxId }), null);
  assert.equal(await rpc('revocation_pending', { ...identity, inboxId: connection.inboxId }), true);
  assert.equal(await rpc('revocation_pending', { ...otherIdentity, inboxId: connection.inboxId }), false);
  await rpc('finish_revocation', { inboxId: connection.inboxId, leaseId: revocation.leaseId, success: true });
  assert.equal(await rpc('revocation_pending', { ...identity, inboxId: connection.inboxId }), false);
  assert(await rpc('target', { ...otherIdentity, emailHash }));
});

test('new connection generation rejects stale callbacks and token/workspace/cursor writes', async () => {
  const connection = await connect();
  const firstLease = await rpc<{ leaseId: string }>('claim', { inboxId: connection.inboxId });
  const stateHash = await oauth(identity, connection.inboxId);
  const target = await rpc<{ existingGeneration: string }>('target', { ...identity, inboxId: connection.inboxId, emailHash });
  const replacement = await connect(identity, emailHash, connection.inboxId);
  assert.notEqual(replacement.generation, connection.generation);
  await assert.rejects(rpc('save_connection', { ...connection, stateHash, existingGeneration: target.existingGeneration }), code('40001'));
  for (const action of ['workspace_commit', 'update_tokens', 'finish']) await assert.rejects(rpc(action, { inboxId: connection.inboxId, generation: connection.generation, leaseId: firstLease.leaseId }), code('40001'));
  await assert.rejects(rpc('target', { ...otherIdentity, emailHash }), code('22023'));
});

test('workspace CAS is owner-bound and lease-expiry-safe; partial checks remain visibly syncing', async () => {
  const connection = await connect();
  const otherConnection = await connect(otherIdentity, 'f'.repeat(64));
  const lease = await rpc<{ leaseId: string }>('claim', { inboxId: connection.inboxId });
  const leaseArgs = { inboxId: connection.inboxId, generation: connection.generation, leaseId: lease.leaseId };
  const state = { version: 1, applications: [], metadata: [{ key: 'marker', value: 'owner-only' }], processed: [] };
  assert.equal(await rpc('workspace_commit', { ...leaseArgs, userId: other, revision: 0, state }), true);
  assert.equal(await rpc('workspace_commit', { ...leaseArgs, revision: 0, state }), false);
  const stored = await db.query<{ user_id: string }>('select user_id from public.apply_workspaces');
  assert.deepEqual(stored.rows, [{ user_id: owner }]);
  await assert.rejects(rpc('workspace_read', { ...leaseArgs, inboxId: otherConnection.inboxId }), code('40001'));
  await rpc('finish', { ...leaseArgs, cursor: { ...emptyCursor(), pendingMessageIds: ['message-one'] }, more: true });
  const status = await rpc<Array<{ syncing: boolean; lastSyncAt: string | null; tokenCipher?: string }>>('status', identity);
  assert.equal(status[0].syncing, true);
  assert.equal(status[0].lastSyncAt, null);
  assert.equal(status[0].tokenCipher, undefined);
  await db.query('update private.apply_gmail_jobs set due_at=now()-interval \'1 second\' where connection_id=$1', [connection.inboxId]);
  const newLease = await rpc<{ leaseId: string }>('claim', { inboxId: connection.inboxId });
  await assert.rejects(rpc('update_tokens', { ...leaseArgs, tokenCipher: cipher }), code('40001'));
  await db.query('update private.apply_gmail_jobs set leased_until=now()-interval \'1 second\' where connection_id=$1', [connection.inboxId]);
  await assert.rejects(rpc('finish', { ...leaseArgs, leaseId: newLease.leaseId, cursor: emptyCursor(), more: false }), code('40001'));
});

test('normal logout preserves cloud jobs, but revoked OAuth sessions and banned/deleted users stop writes', async () => {
  const connection = await connect();
  const pending = await oauth();
  await db.query('delete from auth.sessions where id=$1', [session]);
  assert.equal(await rpc('consume_oauth', { stateHash: pending, browserHash }), null);
  await assert.rejects(rpc('save_connection', { ...connection, stateHash: pending }), code('28000'));
  const lease = await rpc<{ leaseId: string }>('claim', { inboxId: connection.inboxId });
  assert(lease);
  await db.query('update auth.users set banned_until=now()+interval \'1 hour\' where id=$1', [owner]);
  await assert.rejects(rpc('workspace_read', { inboxId: connection.inboxId, generation: connection.generation, leaseId: lease.leaseId }), code('40001'));
  await db.query('update private.apply_gmail_jobs set leased_until=null where connection_id=$1', [connection.inboxId]);
  assert.equal(await rpc('claim', { inboxId: connection.inboxId }), null);
  await db.query('delete from auth.users where id=$1', [owner]);
  const rows = await db.query('select * from private.apply_gmail_connections');
  assert.equal(rows.rows.length, 0);
});

test('worker failures use bounded backoff and never persist provider error text', async () => {
  const connection = await connect();
  const lease = await rpc<{ leaseId: string }>('claim', { inboxId: connection.inboxId });
  await rpc('fail', { inboxId: connection.inboxId, generation: connection.generation, leaseId: lease.leaseId, code: 'private-provider-error' });
  const status = await rpc<Array<{ error: string; syncing: boolean }>>('status', identity);
  assert.equal(status[0].error, 'unavailable');
  assert.equal(status[0].syncing, false);
  const job = await db.query<{ attempts: number; seconds: number }>('select attempts,extract(epoch from due_at-now())::int as seconds from private.apply_gmail_jobs');
  assert.equal(job.rows[0].attempts, 1);
  assert(job.rows[0].seconds > 0 && job.rows[0].seconds <= 3600);
});

test('a user cannot save more than fifty cloud inboxes', async () => {
  for (let index = 0; index < 50; index++) {
    await db.query('insert into private.apply_gmail_connections(id,user_id,email,email_hash,generation,token_cipher) values($1,$2,$3,$4,$5,$6)', [randomUUID(), owner, 'applicant@example.com', index.toString(16).padStart(64, '0'), randomUUID(), cipher]);
  }
  const stateHash = await oauth();
  const target = await rpc<{ id: string }>('target', { ...identity, emailHash });
  await assert.rejects(rpc('save_connection', { ...identity, inboxId: target.id, stateHash, emailHash, email: 'applicant@example.com', existingGeneration: null, generation: randomUUID(), tokenCipher: cipher }), code('54000'));
});
