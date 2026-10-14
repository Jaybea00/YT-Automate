-- 012_visual_types_and_vox_style.sql
-- Values verified missing on 2026-10-13 by inserting probe rows into the live database.
-- Each statement only adds an allowed value; existing rows are unaffected.

-- Generated visuals that were rejected when saved ("invalid input value for enum asset_visual_type")
ALTER TYPE asset_visual_type ADD VALUE IF NOT EXISTS 'archive';
ALTER TYPE asset_visual_type ADD VALUE IF NOT EXISTS 'geo_map';
ALTER TYPE asset_visual_type ADD VALUE IF NOT EXISTS 'newspaper';
-- A beat rendered from several planned shots
ALTER TYPE asset_visual_type ADD VALUE IF NOT EXISTS 'composite';

-- Wikimedia Commons media (including real newspaper scans) is mostly CC BY-SA
ALTER TYPE license_type ADD VALUE IF NOT EXISTS 'cc_by_sa';

-- The Vox explainer script style added in the script-stage overhaul
ALTER TYPE video_style ADD VALUE IF NOT EXISTS 'vox_explainer';
