create table private.apply_gmail_dispatch_tickets (
  nonce_hash text primary key check (nonce_hash ~ '^[a-f0-9]{64}$'),
  issued_at bigint not null,
  expires_at timestamptz not null default (now()+interval '90 seconds')
);
alter table private.apply_gmail_dispatch_tickets enable row level security;
alter table private.apply_gmail_dispatch_tickets force row level security;
revoke all on private.apply_gmail_dispatch_tickets from public, anon, authenticated;

create function public.apply_gmail_consume_dispatch(p_nonce_hash text,p_issued_at bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Service authentication required' using errcode='42501'; end if;
  delete from private.apply_gmail_dispatch_tickets where nonce_hash=p_nonce_hash and issued_at=p_issued_at and expires_at>now();
  return found;
end;
$$;
revoke all on function public.apply_gmail_consume_dispatch(text,bigint) from public,anon,authenticated;
grant execute on function public.apply_gmail_consume_dispatch(text,bigint) to service_role;

-- Managed pg_net queues can be readable to database roles. Queue only a signed,
-- one-use dispatch ticket; the signing key never leaves Vault or Edge secrets.
create or replace function private.apply_dispatch_gmail()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_nonce text; v_issued bigint; v_signature text; v_message text; v_request bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name='apply_gmail_worker_secret';
  if v_secret is null or length(v_secret)<32 then raise exception 'Gmail scheduler is not configured'; end if;
  delete from private.apply_gmail_dispatch_tickets where expires_at<=now();
  v_nonce:=encode(extensions.gen_random_bytes(32),'hex');
  v_issued:=floor(extract(epoch from clock_timestamp()))::bigint;
  v_message:='applytrack-gmail-dispatch-v1'||E'\nPOST\n/functions/v1/gmail\nwork\n'||v_issued::text||E'\n'||v_nonce;
  v_signature:=encode(extensions.hmac(convert_to(v_message,'UTF8'),convert_to(v_secret,'UTF8'),'sha256'),'hex');
  insert into private.apply_gmail_dispatch_tickets(nonce_hash,issued_at)
    values(encode(extensions.digest(convert_to(v_nonce,'UTF8'),'sha256'),'hex'),v_issued);
  select net.http_post(
    url:='https://fbnmvajnvylkaegtkvsj.supabase.co/functions/v1/gmail',
    headers:=jsonb_build_object('Content-Type','application/json','X-Apply-Gmail-Dispatch-Version','1',
      'X-Apply-Gmail-Timestamp',v_issued::text,'X-Apply-Gmail-Nonce',v_nonce,'X-Apply-Gmail-Signature',v_signature),
    body:='{"action":"work"}'::jsonb,timeout_milliseconds:=5000) into v_request;
  return v_request;
end;
$$;
revoke all on function private.apply_dispatch_gmail() from public,anon,authenticated,service_role;
