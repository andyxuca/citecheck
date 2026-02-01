-- Create papers table to store uploaded research papers
create table if not exists public.papers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  file_name text not null,
  file_url text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create citations table to store extracted citations and verification results
create table if not exists public.citations (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.papers(id) on delete cascade,
  citation_text text not null,
  authors text,
  title text,
  year text,
  source text,
  is_verified boolean default false,
  verification_status text not null default 'pending' check (verification_status in ('pending', 'verified', 'not_found', 'error')),
  verification_details text,
  created_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table public.papers enable row level security;
alter table public.citations enable row level security;

-- RLS policies for papers table
create policy "Users can view their own papers" on public.papers
  for select using (auth.uid() = user_id);

create policy "Users can insert their own papers" on public.papers
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own papers" on public.papers
  for update using (auth.uid() = user_id);

create policy "Users can delete their own papers" on public.papers
  for delete using (auth.uid() = user_id);

-- RLS policies for citations table (users can access citations for their papers)
create policy "Users can view citations for their papers" on public.citations
  for select using (
    exists (
      select 1 from public.papers
      where papers.id = citations.paper_id
      and papers.user_id = auth.uid()
    )
  );

create policy "Users can insert citations for their papers" on public.citations
  for insert with check (
    exists (
      select 1 from public.papers
      where papers.id = citations.paper_id
      and papers.user_id = auth.uid()
    )
  );

create policy "Users can update citations for their papers" on public.citations
  for update using (
    exists (
      select 1 from public.papers
      where papers.id = citations.paper_id
      and papers.user_id = auth.uid()
    )
  );

create policy "Users can delete citations for their papers" on public.citations
  for delete using (
    exists (
      select 1 from public.papers
      where papers.id = citations.paper_id
      and papers.user_id = auth.uid()
    )
  );

-- Create indexes for better query performance
create index if not exists papers_user_id_idx on public.papers(user_id);
create index if not exists papers_status_idx on public.papers(status);
create index if not exists citations_paper_id_idx on public.citations(paper_id);
create index if not exists citations_verification_status_idx on public.citations(verification_status);
