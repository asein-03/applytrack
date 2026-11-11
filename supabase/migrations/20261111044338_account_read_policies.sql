-- PostgREST GET requests use read-only transactions, so SELECT policies cannot
-- take row locks. Keep the deletion barrier on writes and use a read-only guard.
create function private.apply_account_readable()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users where id=auth.uid())
    and not exists(select 1 from private.apply_account_deletions where user_id=auth.uid());
$$;
revoke all on function private.apply_account_readable() from public, anon;
grant execute on function private.apply_account_readable() to authenticated;

drop policy "Block deleting Apply workspace" on public.apply_workspaces;
create policy "Block deleting Apply workspace reads" on public.apply_workspaces
  as restrictive for select to authenticated using ((select private.apply_account_readable()));
create policy "Block deleting Apply workspace inserts" on public.apply_workspaces
  as restrictive for insert to authenticated with check ((select private.apply_account_available()));
create policy "Block deleting Apply workspace updates" on public.apply_workspaces
  as restrictive for update to authenticated using ((select private.apply_account_available())) with check ((select private.apply_account_available()));
create policy "Block deleting Apply workspace deletes" on public.apply_workspaces
  as restrictive for delete to authenticated using ((select private.apply_account_available()));

drop policy "Block deleting Apply documents" on storage.objects;
create policy "Block deleting Apply document reads" on storage.objects
  as restrictive for select to authenticated using (bucket_id <> 'apply-documents' or (select private.apply_account_readable()));
create policy "Block deleting Apply document inserts" on storage.objects
  as restrictive for insert to authenticated with check (bucket_id <> 'apply-documents' or (select private.apply_account_available()));
create policy "Block deleting Apply document updates" on storage.objects
  as restrictive for update to authenticated using (bucket_id <> 'apply-documents' or (select private.apply_account_available())) with check (bucket_id <> 'apply-documents' or (select private.apply_account_available()));
create policy "Block deleting Apply document deletes" on storage.objects
  as restrictive for delete to authenticated using (bucket_id <> 'apply-documents' or (select private.apply_account_available()));
