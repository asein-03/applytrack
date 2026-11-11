create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- This narrow helper reads only the caller's signed session identity. Keeping it
-- outside the exposed schema avoids granting clients access to auth tables.
create or replace function private.apply_session_active()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = nullif(auth.jwt()->>'session_id', '')::uuid
      and s.user_id = auth.uid()
      and u.email_confirmed_at is not null
      and not coalesce(u.is_anonymous, false)
      and (u.banned_until is null or u.banned_until <= now())
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function private.apply_session_active() from public, anon;
grant execute on function private.apply_session_active() to authenticated;

create or replace function public.apply_has_active_session()
returns boolean language sql stable security invoker set search_path = '' as $$
  select private.apply_session_active();
$$;
revoke all on function public.apply_has_active_session() from public, anon;
grant execute on function public.apply_has_active_session() to authenticated;

alter table public.apply_workspaces force row level security;
create policy "Require active Apply session" on public.apply_workspaces
  as restrictive for all to authenticated
  using ((select private.apply_session_active()))
  with check ((select private.apply_session_active()));
create policy "Require active Apply document session" on storage.objects
  as restrictive for all to authenticated
  using (bucket_id <> 'apply-documents' or (select private.apply_session_active()))
  with check (bucket_id <> 'apply-documents' or (select private.apply_session_active()));
