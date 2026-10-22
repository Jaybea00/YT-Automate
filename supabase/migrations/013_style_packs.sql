-- 013_style_packs.sql
-- New style packs: car, sport, finance, space_science, tech_review, history, mystery.
-- videos.style is a text column, so these need no change there. A video_style enum type also
-- exists (012 added vox_explainer to it); keep it in step in case anything still uses it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'video_style') THEN
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'car';
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'sport';
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'finance';
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'space_science';
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'tech_review';
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'history';
    ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'mystery';
  END IF;
END $$;
