create extension if not exists pg_net with schema extensions;

create table private.apply_gmail_oauth (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references auth.sessions(id) on delete cascade,
  verifier_cipher text not null check (length(verifier_cipher) between 32 and 4096),
  inbox_id uuid,
  consumed_at timestamptz,
  browser_hash text,
  authorize_attempts integer not null default 0,
  expires_at timestamptz not null default (now() + interval '10 minutes')
);
create index apply_gmail_oauth_user on private.apply_gmail_oauth(user_id, expires_at);

create table private.apply_gmail_connections (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null check (length(email) between 3 and 320),
  email_hash text not null check (email_hash ~ '^[a-f0-9]{64}$'),
  generation uuid not null,
  token_cipher text not null check (length(token_cipher) between 32 and 65536),
  connected_at timestamptz not null default now(),
  sync_after timestamptz not null default (now() - interval '30 days'),
  last_sync_at timestamptz,
  status text not null default 'connected' check (status in ('connected','error','reconnect_required')),
  error_code text check (error_code in ('reconnect_required','rate_limited','unavailable')),
  cursor jsonb not null default '{"phase":"initial","historyId":null,"pageToken":null,"baselineHistoryId":null,"pendingMessageIds":[],"pendingNextPageToken":null,"pendingHistoryId":null}',
  unique(email_hash),
  check (jsonb_typeof(cursor) = 'object' and cursor->>'phase' in ('initial','history') and jsonb_typeof(cursor->'pendingMessageIds') = 'array' and jsonb_array_length(cursor->'pendingMessageIds') <= 1000 and octet_length(cursor::text) <= 262144)
);
create table private.apply_gmail_jobs (
  connection_id uuid primary key references private.apply_gmail_connections(id) on delete cascade,
  generation uuid not null,
  due_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  syncing boolean not null default true,
  lease_id uuid,
  leased_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0)
);
create index apply_gmail_jobs_due on private.apply_gmail_jobs(due_at);
create table private.apply_gmail_revocations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  generation uuid not null,
  token_cipher text not null,
  email_hash text not null,
  due_at timestamptz not null default now(),
  lease_id uuid,
  leased_until timestamptz,
  attempts integer not null default 0
);
create index apply_gmail_revocations_email on private.apply_gmail_revocations(email_hash);
create index apply_gmail_revocations_due on private.apply_gmail_revocations(due_at);

alter table private.apply_gmail_oauth enable row level security;
alter table private.apply_gmail_oauth force row level security;
alter table private.apply_gmail_connections enable row level security;
alter table private.apply_gmail_connections force row level security;
alter table private.apply_gmail_jobs enable row level security;
alter table private.apply_gmail_jobs force row level security;
alter table private.apply_gmail_revocations enable row level security;
alter table private.apply_gmail_revocations force row level security;
revoke all on private.apply_gmail_oauth, private.apply_gmail_connections, private.apply_gmail_jobs, private.apply_gmail_revocations from public, anon, authenticated;

create function private.apply_gmail_account_enabled(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users where id = p_user and email_confirmed_at is not null
    and not coalesce(is_anonymous,false) and (banned_until is null or banned_until <= now()));
$$;
create function private.apply_gmail_session_enabled(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.apply_gmail_account_enabled(p_user) and exists (
    select 1 from auth.sessions where id = p_session and user_id = p_user and (not_after is null or not_after > now()));
$$;
revoke all on function private.apply_gmail_account_enabled(uuid), private.apply_gmail_session_enabled(uuid,uuid) from public, anon, authenticated;

-- The only data API entry point is service-only. Every worker mutation also checks
-- the current connection generation and a short lease, including workspace writes.
create function public.apply_gmail_store(p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := nullif(p_payload->>'userId','')::uuid;
  v_session uuid := nullif(p_payload->>'sessionId','')::uuid;
  v_id uuid := nullif(p_payload->>'inboxId','')::uuid;
  v_conn private.apply_gmail_connections%rowtype;
  v_job private.apply_gmail_jobs%rowtype;
  v_oauth private.apply_gmail_oauth%rowtype;
  v_revoke private.apply_gmail_revocations%rowtype;
  v_result jsonb;
  v_revision bigint;
  v_lease uuid;
  v_code text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Service authentication required' using errcode = '42501';
  end if;
  if p_action in ('create_oauth','target','save_connection','status','enqueue','disconnect')
    and not private.apply_gmail_session_enabled(v_user,v_session) then
    raise exception 'Active session required' using errcode = '28000';
  end if;

  if p_action = 'create_oauth' then
    perform 1 from auth.users where id = v_user for update;
    delete from private.apply_gmail_oauth where expires_at <= now();
    if (select count(*) from private.apply_gmail_oauth where user_id = v_user) >= 5 then
      raise exception 'Too many pending connections' using errcode = '54000';
    end if;
    if v_id is not null and not exists (select 1 from private.apply_gmail_connections where id = v_id and user_id = v_user) then
      raise exception 'Inbox unavailable' using errcode = '22023';
    end if;
    insert into private.apply_gmail_oauth(state_hash,user_id,session_id,verifier_cipher,inbox_id)
      values (p_payload->>'stateHash',v_user,v_session,p_payload->>'verifierCipher',v_id);
    return 'true'::jsonb;
  elsif p_action = 'authorize_attempt' then
    update private.apply_gmail_oauth set authorize_attempts=authorize_attempts+1
      where state_hash=p_payload->>'stateHash' and consumed_at is null and browser_hash is null and expires_at>now() and authorize_attempts<5
      and private.apply_gmail_session_enabled(user_id,session_id) returning * into v_oauth;
    return to_jsonb(found);
  elsif p_action = 'authorize_oauth' then
    update private.apply_gmail_oauth set browser_hash=p_payload->>'browserHash'
      where state_hash=p_payload->>'stateHash' and user_id=v_user and consumed_at is null and browser_hash is null and expires_at>now()
      and private.apply_gmail_session_enabled(user_id,session_id) returning * into v_oauth;
    if not found then return 'null'::jsonb; end if;
    return jsonb_build_object('stateHash',v_oauth.state_hash,'userId',v_oauth.user_id,'sessionId',v_oauth.session_id,'verifierCipher',v_oauth.verifier_cipher,'inboxId',v_oauth.inbox_id,'expectedEmail',null);
  elsif p_action = 'consume_oauth' then
    update private.apply_gmail_oauth set consumed_at=now() where state_hash=p_payload->>'stateHash' and consumed_at is null and browser_hash is not null and browser_hash=p_payload->>'browserHash' returning * into v_oauth;
    if not found or v_oauth.expires_at <= now() or not private.apply_gmail_session_enabled(v_oauth.user_id,v_oauth.session_id) then return 'null'::jsonb; end if;
    if v_oauth.inbox_id is not null then
      select * into v_conn from private.apply_gmail_connections where id = v_oauth.inbox_id and user_id = v_oauth.user_id;
      if not found then return 'null'::jsonb; end if;
    end if;
    return jsonb_build_object('stateHash',v_oauth.state_hash,'userId',v_oauth.user_id,'sessionId',v_oauth.session_id,
      'verifierCipher',v_oauth.verifier_cipher,'inboxId',v_oauth.inbox_id,'expectedEmail',v_conn.email);
  elsif p_action = 'target' then
    if exists (select 1 from private.apply_gmail_revocations where email_hash=p_payload->>'emailHash') then raise exception 'Revocation pending' using errcode = '55000'; end if;
    select * into v_conn from private.apply_gmail_connections where email_hash=p_payload->>'emailHash';
    if found and v_conn.user_id<>v_user then raise exception 'Inbox unavailable' using errcode='22023'; end if;
    if v_id is not null and (v_conn.id is null or v_conn.id <> v_id) then raise exception 'Choose the connected inbox' using errcode = '22023'; end if;
    return jsonb_build_object('id',coalesce(v_conn.id,gen_random_uuid()),'existingGeneration',v_conn.generation);
  elsif p_action = 'save_connection' then
    perform 1 from auth.users where id = v_user for update;
    perform pg_advisory_xact_lock(hashtextextended(p_payload->>'emailHash',0));
    if not private.apply_gmail_session_enabled(v_user,v_session) then raise exception 'Active session required' using errcode = '28000'; end if;
    delete from private.apply_gmail_oauth where state_hash=p_payload->>'stateHash' and user_id=v_user and session_id=v_session and consumed_at is not null and expires_at>now() returning * into v_oauth;
    if not found then raise exception 'Connection attempt unavailable' using errcode = '28000'; end if;
    select * into v_conn from private.apply_gmail_connections where id = v_id for update;
    if (nullif(p_payload->>'existingGeneration','') is not null and (v_conn.id is null or v_conn.generation <> (p_payload->>'existingGeneration')::uuid)) or (nullif(p_payload->>'existingGeneration','') is null and v_conn.id is not null) then raise exception 'Connection changed' using errcode = '40001'; end if;
    if exists (select 1 from private.apply_gmail_revocations where email_hash=p_payload->>'emailHash') then raise exception 'Revocation pending' using errcode = '55000'; end if;
    if v_conn.id is not null and (v_conn.user_id <> v_user or v_conn.email_hash <> p_payload->>'emailHash') then raise exception 'Inbox unavailable' using errcode = '22023'; end if;
    if v_conn.id is null and (select count(*) from private.apply_gmail_connections where user_id=v_user) >= 50 then raise exception 'Connection limit reached' using errcode = '54000'; end if;
    insert into private.apply_gmail_connections(id,user_id,email,email_hash,generation,token_cipher)
      values(v_id,v_user,p_payload->>'email',p_payload->>'emailHash',(p_payload->>'generation')::uuid,p_payload->>'tokenCipher')
      on conflict(id) do update set generation=excluded.generation,token_cipher=excluded.token_cipher,
        connected_at=now(),status='connected',error_code=null;
    delete from private.apply_gmail_jobs where connection_id = v_id;
    insert into private.apply_gmail_jobs(connection_id,generation) values(v_id,(p_payload->>'generation')::uuid);
    return 'true'::jsonb;
  elsif p_action = 'status' then
    select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'provider','gmail','email',c.email,'status',c.status,
      'lastSyncAt',c.last_sync_at,'connectedAt',c.connected_at,'error',c.error_code,
      'syncing',coalesce(j.syncing,false)) order by c.connected_at), '[]'::jsonb)
      into v_result from private.apply_gmail_connections c left join private.apply_gmail_jobs j on j.connection_id=c.id where c.user_id=v_user;
    return v_result;
  elsif p_action = 'enqueue' then
    select * into v_conn from private.apply_gmail_connections where id = v_id and user_id = v_user for update;
    if not found then raise exception 'Inbox unavailable' using errcode = '22023'; end if;
    if v_conn.status = 'reconnect_required' then raise exception 'Reconnect required' using errcode = '28000'; end if;
    select * into v_job from private.apply_gmail_jobs where connection_id=v_id;
    if not v_job.syncing and v_job.requested_at > now()-interval '15 seconds' then raise exception 'Check requested too recently' using errcode = '54000'; end if;
    update private.apply_gmail_jobs set due_at=least(due_at,now()), requested_at=now(),syncing=true where connection_id=v_id;
    return 'true'::jsonb;
  elsif p_action = 'disconnect' then
    perform 1 from auth.users where id=v_user for update;
    select * into v_conn from private.apply_gmail_connections where id=v_id and user_id=v_user;
    if not found then return 'null'::jsonb; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_conn.email_hash,0));
    select * into v_conn from private.apply_gmail_connections where id = v_id and user_id = v_user for update;
    if not found then return 'null'::jsonb; end if;
    insert into private.apply_gmail_revocations(id,user_id,generation,token_cipher,email_hash)
      values(v_conn.id,v_conn.user_id,v_conn.generation,v_conn.token_cipher,v_conn.email_hash);
    delete from private.apply_gmail_connections where id=v_id;
    delete from private.apply_gmail_oauth where user_id=v_user;
    return 'true'::jsonb;
  elsif p_action = 'claim' then
    select c.* into v_conn from private.apply_gmail_connections c join private.apply_gmail_jobs j on j.connection_id=c.id
      where j.due_at <= now() and (j.leased_until is null or j.leased_until <= now())
        and c.generation=j.generation and c.status <> 'reconnect_required'
        and private.apply_gmail_account_enabled(c.user_id) and (v_id is null or c.id=v_id)
      order by j.due_at for update of c skip locked limit 1;
    if not found then return 'null'::jsonb; end if;
    v_lease := gen_random_uuid();
    update private.apply_gmail_jobs set lease_id=v_lease,leased_until=now()+interval '90 seconds',syncing=true where connection_id=v_conn.id;
    return jsonb_build_object('leaseId',v_lease,'tokenCipher',v_conn.token_cipher,'connection',v_conn.cursor || jsonb_build_object(
      'id',v_conn.id,'userId',v_conn.user_id,'email',v_conn.email,'generation',v_conn.generation,
      'connectedAt',v_conn.connected_at,'lastSyncAt',v_conn.last_sync_at,'syncAfter',v_conn.sync_after));
  elsif p_action in ('assert_lease','workspace_read','workspace_commit','update_tokens','finish','fail') then
    select * into v_conn from private.apply_gmail_connections where id=v_id for update;
    if not found or v_conn.generation <> (p_payload->>'generation')::uuid or not private.apply_gmail_account_enabled(v_conn.user_id) then
      raise exception 'Lease unavailable' using errcode = '40001';
    end if;
    select * into v_job from private.apply_gmail_jobs where connection_id=v_id for update;
    if not found or v_job.lease_id is distinct from (p_payload->>'leaseId')::uuid or v_job.leased_until <= now() then
      raise exception 'Lease unavailable' using errcode = '40001';
    end if;
    if p_action = 'assert_lease' then return 'true'::jsonb;
    elsif p_action = 'workspace_read' then
      select jsonb_build_object('revision',revision,'state',state) into v_result from public.apply_workspaces where user_id=v_conn.user_id;
      return coalesce(v_result,'{"revision":0,"state":{"version":1,"applications":[],"metadata":[],"processed":[]}}'::jsonb);
    elsif p_action = 'workspace_commit' then
      if (p_payload->>'revision')::bigint = 0 then
        insert into public.apply_workspaces(user_id,revision,state) values(v_conn.user_id,1,p_payload->'state')
          on conflict(user_id) do nothing returning revision into v_revision;
      else
        update public.apply_workspaces set state=p_payload->'state',revision=revision+1,updated_at=now()
          where user_id=v_conn.user_id and revision=(p_payload->>'revision')::bigint returning revision into v_revision;
      end if;
      return to_jsonb(v_revision is not null);
    elsif p_action = 'update_tokens' then
      update private.apply_gmail_connections set token_cipher=p_payload->>'tokenCipher' where id=v_id;
    elsif p_action = 'finish' then
      update private.apply_gmail_connections set cursor=p_payload->'cursor',last_sync_at=case when coalesce((p_payload->>'more')::boolean,false) then last_sync_at else now() end,status='connected',error_code=null where id=v_id;
      update private.apply_gmail_jobs set lease_id=null,leased_until=null,attempts=0,syncing=coalesce((p_payload->>'more')::boolean,false),
        due_at=now() + case when coalesce((p_payload->>'more')::boolean,false) then interval '5 seconds' else interval '5 minutes' end where connection_id=v_id;
    else
      v_code := case when p_payload->>'code' in ('reconnect_required','rate_limited') then p_payload->>'code' else 'unavailable' end;
      update private.apply_gmail_connections set status=case when v_code='reconnect_required' then v_code else 'error' end,error_code=v_code where id=v_id;
      update private.apply_gmail_jobs set lease_id=null,leased_until=null,syncing=false,attempts=least(attempts+1,12),
        due_at=now()+make_interval(secs => (least(3600,30*power(2,least(attempts,7))))::integer) where connection_id=v_id;
    end if;
    return 'true'::jsonb;
  elsif p_action = 'revocation_pending' then
    if not private.apply_gmail_session_enabled(v_user,v_session) then raise exception 'Active session required' using errcode='28000'; end if;
    return to_jsonb(exists(select 1 from private.apply_gmail_revocations where id=v_id and user_id=v_user));
  elsif p_action = 'claim_revocation' then
    select * into v_revoke from private.apply_gmail_revocations where due_at<=now()
      and (leased_until is null or leased_until<=now()) and (v_id is null or id=v_id)
      order by due_at for update skip locked limit 1;
    if not found then return 'null'::jsonb; end if;
    v_lease := gen_random_uuid();
    update private.apply_gmail_revocations set lease_id=v_lease,leased_until=now()+interval '90 seconds' where id=v_revoke.id;
    return jsonb_build_object('id',v_revoke.id,'userId',v_revoke.user_id,'generation',v_revoke.generation,'tokenCipher',v_revoke.token_cipher,'leaseId',v_lease);
  elsif p_action = 'finish_revocation' then
    if coalesce((p_payload->>'success')::boolean,false) then
      delete from private.apply_gmail_revocations where id=v_id and lease_id=(p_payload->>'leaseId')::uuid;
    else
      update private.apply_gmail_revocations set lease_id=null,leased_until=null,attempts=least(attempts+1,12),
        due_at=now()+make_interval(secs => (least(3600,30*power(2,least(attempts,7))))::integer)
        where id=v_id and lease_id=(p_payload->>'leaseId')::uuid;
    end if;
    return 'true'::jsonb;
  end if;
  raise exception 'Unsupported Gmail operation' using errcode = '22023';
end;
$$;
revoke all on function public.apply_gmail_store(text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_gmail_store(text,jsonb) to service_role;

-- Vault holds the scheduler credential. Only the database owner can dispatch it.
-- The request queue contains HTTP headers transiently, so it is not client-readable.
revoke all on net.http_request_queue, net._http_response from public, anon, authenticated;
create function private.apply_dispatch_gmail()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_request bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name='apply_gmail_worker_secret';
  if v_secret is null then raise exception 'Gmail scheduler is not configured'; end if;
  select net.http_post(
    url := 'https://fbnmvajnvylkaegtkvsj.supabase.co/functions/v1/gmail',
    headers := jsonb_build_object('Content-Type','application/json','X-Apply-Gmail-Worker',v_secret),
    body := '{"action":"work"}'::jsonb, timeout_milliseconds := 5000) into v_request;
  return v_request;
end;
$$;
revoke all on function private.apply_dispatch_gmail() from public, anon, authenticated, service_role;
