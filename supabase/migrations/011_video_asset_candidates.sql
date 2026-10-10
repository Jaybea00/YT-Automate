-- 011_video_asset_candidates.sql
-- Add candidates_json to video_assets to store 3-5 pre-scraped alternative media candidates per beat
-- for 1-click swapping without re-running the scraping pipeline.

ALTER TABLE video_assets
  ADD COLUMN IF NOT EXISTS candidates_json JSONB DEFAULT '[]'::jsonb;
