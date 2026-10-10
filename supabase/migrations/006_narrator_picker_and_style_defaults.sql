-- 006_narrator_picker_and_style_defaults.sql
-- 1. Ensure unique index on narrators(provider_config_id, voice_id) for idempotent sync
create unique index if not exists narrators_provider_config_voice_idx 
  on narrators (provider_config_id, voice_id);

-- 2. Create style_narrator_defaults table
create table if not exists style_narrator_defaults (
  style text primary key,
  narrator_id uuid references narrators(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Add narrator_id to videos table if not present
alter table videos
  add column if not exists narrator_id uuid references narrators(id) on delete set null;

-- 4. Trigger for updated_at timestamp
drop trigger if exists style_narrator_defaults_updated on style_narrator_defaults;
create trigger style_narrator_defaults_updated before update on style_narrator_defaults
  for each row execute function yt_set_updated_at();
