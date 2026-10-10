-- 008_manual_visual_uploads.sql

-- 1. Add 'uploaded' to the asset_visual_type enum
ALTER TYPE asset_visual_type ADD VALUE IF NOT EXISTS 'uploaded';

-- 2. Add 'own_work' and 'purchased' to the license type enum if defined as an enum
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_license_type') THEN
    ALTER TYPE asset_license_type ADD VALUE IF NOT EXISTS 'own_work';
    ALTER TYPE asset_license_type ADD VALUE IF NOT EXISTS 'purchased';
  ELSIF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'license_type') THEN
    ALTER TYPE license_type ADD VALUE IF NOT EXISTS 'own_work';
    ALTER TYPE license_type ADD VALUE IF NOT EXISTS 'purchased';
  END IF;
END $$;

-- 3. If license_type column on video_assets is text with a check constraint, update it
DO $$
BEGIN
  -- Only update check constraint if license_type is not an enum (i.e. text/varchar)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'video_assets'
      AND column_name = 'license_type'
      AND data_type IN ('text', 'character varying')
  ) THEN
    ALTER TABLE video_assets DROP CONSTRAINT IF EXISTS video_assets_license_type_check;
    ALTER TABLE video_assets ADD CONSTRAINT video_assets_license_type_check
      CHECK (license_type IS NULL OR license_type IN (
        'royalty_free', 'public_domain', 'cc0', 'cc_by', 'fair_use', 'own_work', 'purchased'
      ));
  END IF;
END $$;

-- 4. Ensure unique index on video_assets(video_id, beat_index)
CREATE UNIQUE INDEX IF NOT EXISTS video_assets_video_beat_idx
  ON video_assets(video_id, beat_index);
