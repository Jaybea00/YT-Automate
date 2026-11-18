-- 014_stickman_styles.sql
-- Stickman styles (the creator's own drawings): stickman_pov and stickman_bible.
-- Adds them to the video_style enum, which still constrains videos.style on this database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'video_style') THEN
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'stickman_pov';
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'stickman_bible';
  END IF;
END $$;
