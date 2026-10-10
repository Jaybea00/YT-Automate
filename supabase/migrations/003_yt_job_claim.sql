-- Atomic queued job claim RPC with SKIP LOCKED to prevent race conditions across concurrent workers.
create or replace function public.yt_claim_next_job()
returns setof public.yt_jobs
language sql
security definer
set search_path = ''
as $$
  update public.yt_jobs
  set status = 'running',
      updated_at = now()
  where id = (
    select id
    from public.yt_jobs
    where status = 'queued'
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.yt_claim_next_job() from public, anon, authenticated;
grant execute on function public.yt_claim_next_job() to service_role;
