-- Add additional fields to citations table for better tracking
ALTER TABLE citations ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE citations ADD COLUMN IF NOT EXISTS authors TEXT[];
ALTER TABLE citations ADD COLUMN IF NOT EXISTS score DECIMAL(4,3);
