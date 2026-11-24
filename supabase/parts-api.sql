-- SJK Parts Costing — tables for the parts-api Edge Function (the interface in the Sales / Admin guides).
-- Run once: Supabase → SQL Editor → New query → paste this file → Run. Safe to re-run.
--
-- Row Level Security is ON with NO policies, so the browser (anon / publishable key) can't read or
-- write these tables at all. Only the parts-api Edge Function, which runs with the service-role key,
-- can. That keeps password hashes and unlock tokens off the internet.

-- The two shared records the tool uses: 'current' (costing settings) and 'locks' (section passwords).
create table if not exists public.shared_settings (
  name        text primary key check (name in ('current', 'locks')),
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Every costing save and password change, for "who changed the prices?" questions.
create table if not exists public.settings_history (
  id          bigint generated always as identity primary key,
  name        text not null,
  value       jsonb not null,
  created_at  timestamptz not null default now()
);

-- Tokens handed out when someone enters a correct section password (valid 12 hours).
create table if not exists public.unlock_tokens (
  token          text primary key,
  sections       text[] not null,
  setup_version  text not null default '',   -- Admin console password at the time; a new password ends old tokens
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);
create index if not exists unlock_tokens_expires on public.unlock_tokens (expires_at);

-- Failed password attempts, to slow down guessing (checked per IP address by the function).
create table if not exists public.unlock_failures (
  id          bigint generated always as identity primary key,
  ip          text not null,
  at          timestamptz not null default now()
);
create index if not exists unlock_failures_ip_at on public.unlock_failures (ip, at);

alter table public.shared_settings  enable row level security;
alter table public.settings_history enable row level security;
alter table public.unlock_tokens    enable row level security;
alter table public.unlock_failures  enable row level security;
-- (No policies on purpose.)
