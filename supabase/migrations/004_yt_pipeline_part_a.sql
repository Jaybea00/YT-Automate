-- 004_yt_pipeline_part_a.sql
-- 1. Add video_id and stages columns to yt_jobs
alter table yt_jobs
  add column if not exists video_id uuid references videos(id) on delete set null,
  add column if not exists stages text[] not null default array['research','script','image','tts','assembly','thumbnail','metadata']::text[];

-- 2. Partial unique index on yt_jobs(video_id) for active jobs (idempotency)
create unique index if not exists yt_jobs_active_video_idx on yt_jobs(video_id)
  where status in ('queued','running');

-- 3. Add render_url column to videos table
alter table videos
  add column if not exists render_url text;

-- 4. Update check constraints to allow 'visuals' stage in yt_job_stages, yt_job_units, yt_stage_bindings
alter table yt_job_stages drop constraint if exists yt_job_stages_stage_check;
alter table yt_job_stages add constraint yt_job_stages_stage_check
  check (stage in ('research','script','image','visuals','tts','assembly','thumbnail','metadata'));

alter table yt_job_units drop constraint if exists yt_job_units_stage_check;
alter table yt_job_units add constraint yt_job_units_stage_check
  check (stage in ('image','visuals','tts','assembly','thumbnail'));

alter table yt_stage_bindings drop constraint if exists yt_stage_bindings_stage_check;
alter table yt_stage_bindings add constraint yt_stage_bindings_stage_check
  check (stage in ('research','script','image','visuals','tts','thumbnail','metadata'));

-- 5. Expand provider kind check to include 'stock' for Part C
alter table yt_provider_configs drop constraint if exists yt_provider_configs_kind_check;
alter table yt_provider_configs add constraint yt_provider_configs_kind_check
  check (kind in ('llm','image','tts','video','stock'));

-- 6. Repoint narrators table to yt_provider_configs and add provider_slug
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'narrators') then
    alter table narrators drop constraint if exists narrators_provider_config_id_fkey;
    alter table narrators add column if not exists provider_slug text;
    -- Make provider_config_id nullable in case old configs are deprecated
    alter table narrators alter column provider_config_id drop not null;
    alter table narrators add constraint narrators_yt_provider_config_id_fkey
      foreign key (provider_config_id) references yt_provider_configs(id) on delete set null;
  end if;
end $$;
