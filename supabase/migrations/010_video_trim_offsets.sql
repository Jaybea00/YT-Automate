-- 010_video_trim_offsets.sql
-- Add start_offset_seconds and end_offset_seconds to video_assets for B-roll video clip trimming

ALTER TABLE video_assets
  ADD COLUMN IF NOT EXISTS start_offset_seconds NUMERIC(8, 2) DEFAULT 0.00;

ALTER TABLE video_assets
  ADD COLUMN IF NOT EXISTS end_offset_seconds NUMERIC(8, 2) DEFAULT NULL;
