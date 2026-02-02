-- Add missing columns to papers table
alter table public.papers add column if not exists total_citations integer default 0;
alter table public.papers add column if not exists verified_citations integer default 0;
alter table public.papers add column if not exists unverified_citations integer default 0;

-- Make file_url nullable (we're not storing files, just processing them)
alter table public.papers alter column file_url drop not null;

-- Add source_url column to citations for linking to verified sources
alter table public.citations add column if not exists source_url text;

-- Update verification_status check constraint to include 'unverified'
alter table public.citations drop constraint if exists citations_verification_status_check;
alter table public.citations add constraint citations_verification_status_check 
  check (verification_status in ('pending', 'verified', 'not_found', 'uncertain', 'unverified', 'error'));
