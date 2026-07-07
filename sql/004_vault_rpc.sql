-- Vault access RPC. The vault schema is not exposed through the Data API, so
-- vault.decrypted_secrets cannot be read via supabase-js .schema('vault').
-- Expose a single service-role-only RPC instead (used by src/lib/vault.js).

create or replace function public.hs_get_secret(secret_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name;
$$;

revoke execute on function public.hs_get_secret(text) from public;
revoke execute on function public.hs_get_secret(text) from anon;
revoke execute on function public.hs_get_secret(text) from authenticated;
grant execute on function public.hs_get_secret(text) to service_role;
