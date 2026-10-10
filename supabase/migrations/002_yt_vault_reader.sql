create or replace function public.yt_read_vault_secret(secret_id uuid)
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where id = secret_id;
$$;
revoke all on function public.yt_read_vault_secret(uuid) from public, anon, authenticated;
grant execute on function public.yt_read_vault_secret(uuid) to service_role;
