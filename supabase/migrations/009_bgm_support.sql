-- 009_bgm_support.sql
-- Add background music configuration to videos table

alter table videos
  add column if not exists bgm_track text default 'lofi',
  add column if not exists bgm_volume numeric(3,2) default 0.20,
  add column if not exists bgm_enabled boolean default true,
  add column if not exists bgm_custom_url text;
