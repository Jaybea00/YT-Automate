-- 007_visuals_stage.sql
-- 1. Ensure unique constraint on video_assets(video_id, beat_index) for idempotent provenance upserts
create unique index if not exists video_assets_video_beat_idx
  on video_assets(video_id, beat_index);

-- 2. Insert placeholder provider config for Pixabay stock provider (kind: 'stock')
-- Uses a placeholder secret_id. Replace with actual Supabase Vault secret_id after inserting the Pixabay API key into Vault.
insert into yt_provider_configs (id, kind, provider, label, default_model, secret_id, is_active)
values (
  '11111111-1111-1111-1111-111111111111',
  'stock',
  'pixabay',
  'Pixabay Stock Videos',
  null,
  '00000000-0000-0000-0000-000000000000',
  true
)
on conflict (id) do update set
  kind = excluded.kind,
  provider = excluded.provider,
  label = excluded.label,
  is_active = true;

-- 3. Ensure 'visuals' stage binding points to the Pixabay stock provider config
insert into yt_stage_bindings (stage, provider_config_id, max_retries)
values (
  'visuals',
  '11111111-1111-1111-1111-111111111111',
  2
)
on conflict (stage) do update set
  provider_config_id = excluded.provider_config_id,
  max_retries = excluded.max_retries;
