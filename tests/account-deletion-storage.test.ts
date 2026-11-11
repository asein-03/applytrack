import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const session = '33333333-3333-4333-8333-333333333333';
const otherSession = '44444444-4444-4444-8444-444444444444';
const inbox = '55555555-5555-4555-8555-555555555555';
const generation = '66666666-6666-4666-8666-666666666666';
const state = { version: 1, applications: [], metadata: [], processed: [] };
let db: PGlite;
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
async function rpc<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  return (await db.query<{ result: T }>('select public.apply_account_cleanup($1,$2::jsonb) as result', [action, JSON.stringify(payload)])).rows[0].result;
}
async function gmail<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  return (await db.query<{ result: T }>('select public.apply_gmail_store($1,$2::jsonb) as result', [action, JSON.stringify(payload)])).rows[0].result;
}
async function claims(role: string, user = owner, sessionId = session) { await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: user, session_id: sessionId })]); }
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private; create schema storage; create schema extensions; create schema net; create schema vault;
    grant usage on schema auth,storage,private to authenticated;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false,banned_until timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant select,insert,delete on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as $$select string_to_array(name,'/')$$;
    create table net.http_request_queue(id bigint); create table net._http_response(id bigint);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$select 42::bigint$$;
    create table vault.secrets(name text,secret text); create table vault.decrypted_secrets(name text,decrypted_secret text);
  `);
  for (const file of ['20261110200047_cloud_workspace.sql', '20261111033846_active_session_security.sql', '20261111041447_hosted_gmail.sql', '20261111043519_account_deletion.sql', '20261111044338_account_read_policies.sql']) {
    const sql = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
    await db.exec(sql.replace('create extension if not exists pg_net with schema extensions;', ''));
  }
});
beforeEach(async () => {
  await db.exec('reset role; truncate auth.users cascade; truncate storage.objects, private.apply_gmail_revocations;'); await claims('service_role');
  await db.query('insert into auth.users(id,email_confirmed_at) values($1,now()),($2,now())', [owner, other]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4)', [session, owner, otherSession, other]);
  for (const id of [owner, other]) {
    await db.query('insert into public.apply_workspaces(user_id,state) values($1,$2::jsonb)', [id, JSON.stringify(state)]);
    await db.query('insert into storage.objects(bucket_id,name) values(\'apply-documents\',$1)', [`${id}/application/resume.pdf`]);
  }
  await db.query('insert into private.apply_gmail_connections(id,user_id,email,email_hash,generation,token_cipher) values($1,$2,$3,$4,$5,$6)', [inbox, owner, 'person@candidate.example', 'a'.repeat(64), generation, 'synthetic-encrypted-token-value-for-test-only']);
  await db.query('insert into private.apply_gmail_jobs(connection_id,generation) values($1,$2)', [inbox, generation]);
});
after(async () => { await db.close(); });

test('only service operations with the current owner session can begin deletion', async () => {
  for (const role of ['anon', 'authenticated']) {
    const result = await db.query<{ rpc: boolean; table_read: boolean }>(`select has_function_privilege($1,'public.apply_account_cleanup(text,jsonb)','execute') as rpc,has_table_privilege($1,'private.apply_account_deletions','select') as table_read`, [role]);
    assert.deepEqual(result.rows[0], { rpc: false, table_read: false });
  }
  await claims('authenticated'); await assert.rejects(rpc('begin', { userId: owner, sessionId: session }), code('42501'));
  await claims('service_role'); await assert.rejects(rpc('begin', { userId: other, sessionId: session }), code('28000'));
  await db.query('delete from auth.sessions where id=$1', [session]);
  await assert.rejects(rpc('begin', { userId: owner, sessionId: session }), code('28000'));
});
test('intent blocks workspace, document and Gmail writes but preserves authentication for a retry', async () => {
  const oldLease = await gmail<{ leaseId: string }>('claim', { inboxId: inbox });
  const lease = await rpc<{ userId: string; leaseId: string }>('begin', { userId: owner, sessionId: session });
  await assert.rejects(gmail('workspace_commit', { inboxId: inbox, generation, leaseId: oldLease.leaseId, revision: 1, state }), code('40001'));
  assert.equal(await gmail('claim'), null);
  await assert.rejects(gmail('create_oauth', { userId: owner, sessionId: session, stateHash: 'b'.repeat(64), verifierCipher: 'synthetic-verifier-cipher-value-for-testing' }), code('28000'));
  await claims('authenticated'); await db.exec('set role authenticated');
  assert.equal((await db.query<{ active: boolean }>('select public.apply_has_active_session() as active')).rows[0].active, true);
  assert.equal((await db.query('select * from public.apply_workspaces')).rows.length, 0);
  await assert.rejects(db.query('insert into storage.objects(bucket_id,name) values(\'apply-documents\',$1)', [`${owner}/late-upload`]), code('42501'));
  assert.equal((await db.query('select * from storage.objects')).rows.length, 0);
  await claims('authenticated', other, otherSession);
  assert.equal((await db.query('select * from public.apply_workspaces')).rows.length, 1);
  assert.equal((await db.query('select * from storage.objects')).rows.length, 1);
  await db.exec('reset role'); await claims('service_role');
  await rpc('release', lease);
  const retry = await rpc<{ leaseId: string }>('begin', { userId: owner, sessionId: session }); assert.notEqual(retry.leaseId, lease.leaseId);
});
test('cleanup lists only owned storage, requires successful object removal, and keeps pending revocation after Auth deletion', async () => {
  const lease = await rpc<{ userId: string; leaseId: string }>('begin', { userId: owner, sessionId: session });
  assert.deepEqual(await rpc('files', lease), [`${owner}/application/resume.pdf`]);
  await assert.rejects(rpc('files', { ...lease, userId: other }), code('40001'));
  await assert.rejects(rpc('purge_workspace', lease), code('55000'));
  await assert.rejects(rpc('finish', lease), code('55000'));
  await db.query('delete from storage.objects where bucket_id=\'apply-documents\' and name=$1', [`${owner}/application/resume.pdf`]);
  await rpc('purge_workspace', lease);
  assert.deepEqual((await db.query('select user_id from public.apply_workspaces')).rows, [{ user_id: other }]);
  await db.query('delete from auth.users where id=$1', [owner]);
  assert.deepEqual(await rpc('finish', lease), { revocationPending: true });
  const revoke = await gmail<{ id: string; userId: string; leaseId: string }>('claim_revocation', { inboxId: inbox });
  assert.equal(revoke.userId, owner); assert.equal(revoke.id, inbox);
  await gmail('finish_revocation', { inboxId: revoke.id, leaseId: revoke.leaseId, success: true });
  assert.deepEqual(await rpc('finish', lease), { revocationPending: false });
  assert.equal((await db.query('select * from private.apply_account_deletions')).rows.length, 0);
  assert.equal((await db.query('select * from storage.objects')).rows.length, 1);
});
test('deletion leases reject concurrent and stale cleanup while expired attempts can resume', async () => {
  const lease = await rpc<{ userId: string; leaseId: string }>('begin', { userId: owner, sessionId: session });
  await assert.rejects(rpc('begin', { userId: owner, sessionId: session }), code('40001'));
  await db.query('update private.apply_account_deletions set leased_until=now()-interval \'1 second\' where user_id=$1', [owner]);
  await assert.rejects(rpc('files', lease), code('40001'));
  const retry = await rpc<{ userId: string; leaseId: string }>('begin', { userId: owner, sessionId: session });
  assert.notEqual(retry.leaseId, lease.leaseId);
  assert.equal((await db.query('select * from private.apply_gmail_revocations')).rows.length, 1);
  await assert.rejects(rpc('purge_workspace', lease), code('40001'));
});

test('workspace and document reads remain available in PostgREST read-only transactions', async () => {
  await claims('authenticated'); await db.exec('set role authenticated; begin read only;');
  try {
    assert.equal((await db.query('select * from public.apply_workspaces')).rows.length, 1);
    assert.equal((await db.query('select * from storage.objects')).rows.length, 1);
  } finally { await db.exec('rollback; reset role;'); }
  await claims('service_role');
  await rpc('begin', { userId: owner, sessionId: session });
  await claims('authenticated'); await db.exec('set role authenticated; begin read only;');
  try {
    assert.equal((await db.query('select * from public.apply_workspaces')).rows.length, 0);
    assert.equal((await db.query('select * from storage.objects')).rows.length, 0);
  } finally { await db.exec('rollback; reset role;'); }
});
