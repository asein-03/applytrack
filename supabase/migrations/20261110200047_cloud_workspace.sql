create table public.apply_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  state jsonb not null check (jsonb_typeof(state) = 'object' and state->>'version' = '1' and jsonb_typeof(state->'applications') = 'array'),
  updated_at timestamptz not null default now()
);
alter table public.apply_workspaces enable row level security;
grant select, insert, update, delete on public.apply_workspaces to authenticated;
revoke all on public.apply_workspaces from anon;
create policy "Read own Apply workspace" on public.apply_workspaces for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own Apply workspace" on public.apply_workspaces for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own Apply workspace" on public.apply_workspaces for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own Apply workspace" on public.apply_workspaces for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.apply_commit_workspace(expected_revision bigint, next_state jsonb)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare committed_revision bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if expected_revision < 0 then raise exception 'Invalid revision' using errcode = '22023'; end if;
  if expected_revision = 0 then
    insert into public.apply_workspaces(user_id, revision, state)
      values (auth.uid(), 1, next_state)
      on conflict (user_id) do nothing
      returning revision into committed_revision;
  else
    update public.apply_workspaces set state = next_state, revision = revision + 1, updated_at = now()
      where user_id = auth.uid() and revision = expected_revision
      returning revision into committed_revision;
  end if;
  return committed_revision;
end;
$$;
revoke all on function public.apply_commit_workspace(bigint,jsonb) from public, anon;
grant execute on function public.apply_commit_workspace(bigint,jsonb) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('apply-documents','apply-documents',false,10485760,array['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','application/octet-stream'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "Read own Apply documents" on storage.objects for select to authenticated using (bucket_id = 'apply-documents' and (storage.foldername(name))[1] = (select auth.uid())::text and exists (select 1 from public.apply_workspaces where user_id = (select auth.uid())));
create policy "Upload own Apply documents" on storage.objects for insert to authenticated with check (bucket_id = 'apply-documents' and (storage.foldername(name))[1] = (select auth.uid())::text and exists (select 1 from public.apply_workspaces where user_id = (select auth.uid())));
create policy "Delete own Apply documents" on storage.objects for delete to authenticated using (bucket_id = 'apply-documents' and (storage.foldername(name))[1] = (select auth.uid())::text and exists (select 1 from public.apply_workspaces where user_id = (select auth.uid())));
