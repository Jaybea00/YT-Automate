-- YT Automation pipeline: provider configs, stage bindings, checkpointed jobs.
-- ADDITIVE ONLY: creates new yt_* objects. Does not alter or drop anything existing.
-- Safe to re-run (all statements use IF NOT EXISTS / CREATE OR REPLACE on yt_ names).
-- Apply manually in the Supabase SQL editor.

-- ---------------------------------------------------------------- helpers
create or replace function yt_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------- provider configuration
-- One row per provider account/key you plug in (e.g. "ElevenLabs main", "Local Kokoro").
create table if not exists yt_provider_configs (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('llm','image','tts','video')),
  provider       text not null,            -- adapter id in code, e.g. 'elevenlabs'
  label          text not null,            -- human name shown in your UI
  base_url       text,                     -- for self-hosted / OpenAI-compatible endpoints
  default_model  text,
  secret_id      uuid,                     -- Supabase Vault secret id. NEVER store raw keys in this table.
  options        jsonb not null default '{}'::jsonb,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Which provider/model handles which stage. Changing a row = swapping a provider, no code change.
create table if not exists yt_stage_bindings (
  stage              text primary key
                     check (stage in ('research','script','image','tts','thumbnail','metadata')),
  provider_config_id uuid not null references yt_provider_configs(id) on delete restrict,
  model              text,
  options            jsonb not null default '{}'::jsonb,
  max_retries        int not null default 1 check (max_retries between 0 and 5),
  updated_at         timestamptz not null default now()
);

-- ------------------------------------------------------------------- jobs
create table if not exists yt_jobs (
  id                 uuid primary key default gen_random_uuid(),
  topic              text not null,
  template           text not null,        -- e.g. 'tech-explainer', 'cinematic-documentary'
  status             text not null default 'queued'
                     check (status in ('queued','running','failed','done','cancelled')),
  script             jsonb,                -- approved script: scenes[], visual_style
  script_fingerprint text,                 -- sha256 of approved script; blocks stale-checkpoint reuse
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Stage-level checkpoint (coarse).
create table if not exists yt_job_stages (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references yt_jobs(id) on delete cascade,
  stage       text not null
              check (stage in ('research','script','image','tts','assembly','thumbnail','metadata')),
  status      text not null default 'pending'
              check (status in ('pending','running','done','failed','skipped')),
  started_at  timestamptz,
  finished_at timestamptz,
  error       text,
  unique (job_id, stage)
);

-- Unit-level checkpoint (fine): one row per scene per stage. This is what makes resume cheap.
create table if not exists yt_job_units (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references yt_jobs(id) on delete cascade,
  stage              text not null
                     check (stage in ('image','tts','assembly','thumbnail')),
  unit_index         int  not null,        -- scene number
  status             text not null default 'pending'
                     check (status in ('pending','running','done','failed')),
  provider_config_id uuid references yt_provider_configs(id) on delete set null,
  model              text,
  input_hash         text not null,        -- sha256(stage + input + provider + model + options)
  output_path        text,                 -- Storage path or local worker path
  duration_ms        int,
  cost_usd           numeric(10,4),
  attempts           int not null default 0,
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (job_id, stage, unit_index)
);

create index if not exists yt_job_units_lookup on yt_job_units (job_id, stage, status);

-- --------------------------------------------------------------- triggers
drop trigger if exists yt_provider_configs_updated on yt_provider_configs;
create trigger yt_provider_configs_updated before update on yt_provider_configs
  for each row execute function yt_set_updated_at();

drop trigger if exists yt_stage_bindings_updated on yt_stage_bindings;
create trigger yt_stage_bindings_updated before update on yt_stage_bindings
  for each row execute function yt_set_updated_at();

drop trigger if exists yt_jobs_updated on yt_jobs;
create trigger yt_jobs_updated before update on yt_jobs
  for each row execute function yt_set_updated_at();

drop trigger if exists yt_job_units_updated on yt_job_units;
create trigger yt_job_units_updated before update on yt_job_units
  for each row execute function yt_set_updated_at();

-- -------------------------------------------------------------------- RLS
-- Single-user tool: lock tables down and access them only server-side with the
-- service-role key (which bypasses RLS). No policies = no anon/authenticated access.
alter table yt_provider_configs enable row level security;
alter table yt_stage_bindings   enable row level security;
alter table yt_jobs             enable row level security;
alter table yt_job_stages       enable row level security;
alter table yt_job_units        enable row level security;

-- ------------------------------------------------------------------ Vault
-- Storing a provider key (run separately, once per key; requires Vault to be enabled
-- in your Supabase project). It returns a uuid: put that in yt_provider_configs.secret_id.
--
--   select vault.create_secret('<the-api-key>', 'elevenlabs_main', 'ElevenLabs main key');
--
-- The worker reads it server-side via the vault.decrypted_secrets view using the service role.
