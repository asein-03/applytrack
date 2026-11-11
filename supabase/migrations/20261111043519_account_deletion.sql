-- Google revocation must outlive the account that authorized its encrypted token.
alter table private.apply_gmail_revocations drop constraint apply_gmail_revocations_user_id_fkey;
create index apply_gmail_revocations_user on private.apply_gmail_revocations(user_id);

create table private.apply_account_deletions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  lease_id uuid,
  leased_until timestamptz,
  attempts integer not null default 0,
  last_error text check (last_error in ('unavailable'))
);
alter table private.apply_account_deletions enable row level security;
alter table private.apply_account_deletions force row level security;
revoke all on private.apply_account_deletions from public, anon, authenticated;

-- This lock serializes existing document/workspace writes with deletion intent.
-- The caller's signed identity is the only account the RLS helper can inspect.
create function private.apply_account_available()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then return false; end if;
  perform 1 from auth.users where id=v_user for key share;
  return found and not exists (select 1 from private.apply_account_deletions where user_id=v_user);
end;
$$;
revoke all on function private.apply_account_available() from public, anon;
grant execute on function private.apply_account_available() to authenticated;
create policy "Block deleting Apply workspace" on public.apply_workspaces
  as restrictive for all to authenticated
  using ((select private.apply_account_available())) with check ((select private.apply_account_available()));
create policy "Block deleting Apply documents" on storage.objects
  as restrictive for all to authenticated
  using (bucket_id <> 'apply-documents' or (select private.apply_account_available()))
  with check (bucket_id <> 'apply-documents' or (select private.apply_account_available()));

create or replace function private.apply_gmail_account_enabled(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users where id=p_user and email_confirmed_at is not null
    and not coalesce(is_anonymous,false) and (banned_until is null or banned_until <= now()))
    and not exists (select 1 from private.apply_account_deletions where user_id=p_user);
$$;

create function public.apply_account_cleanup(p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := nullif(p_payload->>'userId','')::uuid;
  v_session uuid := nullif(p_payload->>'sessionId','')::uuid;
  v_lease uuid := nullif(p_payload->>'leaseId','')::uuid;
  v_job private.apply_account_deletions%rowtype;
  v_result jsonb;
  v_connection private.apply_gmail_connections%rowtype;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Service authentication required' using errcode='42501'; end if;
  if v_user is null then raise exception 'Account required' using errcode='22023'; end if;
  if p_action='begin' then
    perform 1 from auth.users where id=v_user and email_confirmed_at is not null and not coalesce(is_anonymous,false)
      and (banned_until is null or banned_until<=now()) for update;
    if not found or not exists (select 1 from auth.sessions where id=v_session and user_id=v_user and (not_after is null or not_after>now())) then raise exception 'Active account required' using errcode='28000'; end if;
    select * into v_job from private.apply_account_deletions where user_id=v_user for update;
    if found and v_job.leased_until>now() then raise exception 'Deletion in progress' using errcode='40001'; end if;
    v_lease:=gen_random_uuid();
    insert into private.apply_account_deletions(user_id,lease_id,leased_until,attempts) values(v_user,v_lease,now()+interval '60 seconds',1)
      on conflict(user_id) do update set lease_id=excluded.lease_id,leased_until=excluded.leased_until,attempts=private.apply_account_deletions.attempts+1,last_error=null;
    for v_connection in select * from private.apply_gmail_connections where user_id=v_user for update loop
      perform pg_advisory_xact_lock(hashtextextended(v_connection.email_hash,0));
      insert into private.apply_gmail_revocations(id,user_id,generation,token_cipher,email_hash)
        values(v_connection.id,v_connection.user_id,v_connection.generation,v_connection.token_cipher,v_connection.email_hash);
    end loop;
    delete from private.apply_gmail_connections where user_id=v_user;
    delete from private.apply_gmail_oauth where user_id=v_user;
    return jsonb_build_object('userId',v_user,'leaseId',v_lease);
  elsif p_action='finish' then
    if exists(select 1 from auth.users where id=v_user) then raise exception 'Account still exists' using errcode='55000'; end if;
    return jsonb_build_object('revocationPending',exists(select 1 from private.apply_gmail_revocations where user_id=v_user));
  end if;
  select * into v_job from private.apply_account_deletions where user_id=v_user for update;
  if not found or v_job.lease_id is distinct from v_lease or v_job.leased_until<=now() then raise exception 'Deletion lease expired' using errcode='40001'; end if;
  if p_action='files' then
    select coalesce(jsonb_agg(name),'[]'::jsonb) into v_result from (select name from storage.objects where bucket_id='apply-documents' and name like v_user::text||'/%' order by name limit 100) files;
    return v_result;
  elsif p_action='purge_workspace' then
    if exists(select 1 from storage.objects where bucket_id='apply-documents' and name like v_user::text||'/%') then raise exception 'Documents remain' using errcode='55000'; end if;
    delete from public.apply_workspaces where user_id=v_user;
    return 'true'::jsonb;
  elsif p_action='release' then
    update private.apply_account_deletions set lease_id=null,leased_until=null,last_error='unavailable' where user_id=v_user;
    return 'true'::jsonb;
  end if;
  raise exception 'Unknown account operation' using errcode='22023';
end;
$$;
revoke all on function public.apply_account_cleanup(text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_account_cleanup(text,jsonb) to service_role;
