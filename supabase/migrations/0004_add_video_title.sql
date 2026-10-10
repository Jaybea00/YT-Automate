-- 0004_add_video_title.sql
-- Add title column to videos table for storing the selected script title upon approval.

ALTER TABLE videos
ADD COLUMN IF NOT EXISTS title TEXT;

-- Ensure script_approved_at column exists for tracking approval timestamp
ALTER TABLE videos
ADD COLUMN IF NOT EXISTS script_approved_at TIMESTAMPTZ;
