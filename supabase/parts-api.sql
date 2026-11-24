-- SJK Parts Costing — tables for the parts-api Edge Function (the interface in the Sales / Admin guides).
-- Run in Supabase → SQL Editor → New query → paste this file → Run. Safe to re-run: it only adds what's missing.
--
-- Row Level Security is ON with NO policies, so the browser (anon / publishable key) can't read or
-- write these tables at all. Only the parts-api Edge Function, which runs with the service-role key,
-- can. That keeps roles, password hashes and costing history off the internet.

-- ---------- people: one row per sign-in, with the role ----------
-- admin = the guide's "Editor" (changes costing and passwords; never asked for section passwords)
-- sales = the guide's "Viewer" (Find a part + Quote; sees costing read-only)
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  name        text not null default '',
  role        text not null default 'sales' check (role in ('admin', 'sales')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Every new sign-in (Authentication → Users → Add user) gets a profile automatically.
-- The first person ever becomes admin; everyone after that starts as sales.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, role, active)
  values (new.id, lower(new.email),
          coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
          case when exists (select 1 from public.profiles where role = 'admin' and active) then 'sales' else 'admin' end,
          true)
  on conflict (id) do nothing;
  return new;
end $$;

-- If the older schema.sql (full tool) was run, profiles exists with active defaulting to false. Fix that.
alter table public.profiles alter column active set default true;

-- Printed under "Prepared by" on the PDF proposal, e.g. "Juan Santos, Service Executive · 0917 …".
alter table public.profiles add column if not exists title  text not null default '';
alter table public.profiles add column if not exists mobile text not null default '';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- People who were added before this script ran: give them a profile too (oldest becomes admin if there is none).
insert into public.profiles (id, email, name, role, active)
select u.id, lower(u.email), split_part(u.email, '@', 1), 'sales', true from auth.users u
on conflict (id) do nothing;
update public.profiles set role = 'admin', active = true
where id = (select u.id from auth.users u join public.profiles p on p.id = u.id order by u.created_at limit 1)
  and not exists (select 1 from public.profiles where role = 'admin' and active);

-- ---------- the two shared records: 'current' (costing settings) and 'locks' (section passwords) ----------
create table if not exists public.shared_settings (
  name        text primary key check (name in ('current', 'locks')),
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Every costing save and password change, and who made it ("who changed the prices?").
create table if not exists public.settings_history (
  id          bigint generated always as identity primary key,
  name        text not null,
  value       jsonb not null,
  created_at  timestamptz not null default now()
);
alter table public.settings_history add column if not exists changed_by text not null default '';

-- Wrong section passwords, to slow down guessing (counted per person; column is called ip for history).
create table if not exists public.unlock_failures (
  id          bigint generated always as identity primary key,
  ip          text not null,
  at          timestamptz not null default now()
);
create index if not exists unlock_failures_ip_at on public.unlock_failures (ip, at);

-- Zoho CRM access token cache (used only by the parts-api function; Zoho limits how often new tokens may be made).
create table if not exists public.zoho_cache (
  name        text primary key,
  value       text not null,
  expires_at  timestamptz not null
);
alter table public.zoho_cache enable row level security;
revoke all on public.zoho_cache from anon, authenticated;
grant all on public.zoho_cache to service_role;

alter table public.profiles         enable row level security;
alter table public.shared_settings  enable row level security;
alter table public.settings_history enable row level security;
alter table public.unlock_failures  enable row level security;

-- The one browser rule: a signed-in person may read their OWN profile row (their role),
-- so sign-in works even before the parts-api function is deployed. Nobody can read anyone else's
-- row, and nobody can change roles from the browser. All other tables: no policies on purpose.
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles for select to authenticated using (id = auth.uid());

-- Table permissions (this project doesn't grant them automatically). The row rules above still apply:
-- signed-in people may only SELECT profiles, and only their own row. The browser gets nothing else.
grant usage on schema public to authenticated, service_role;
grant select on public.profiles to authenticated;
revoke all on public.shared_settings, public.settings_history, public.unlock_failures from anon, authenticated;
revoke insert, update, delete on public.profiles from anon, authenticated;
-- The parts-api function (service role) needs full access to its tables.
grant all on public.profiles, public.shared_settings, public.settings_history, public.unlock_failures to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Not used any more (sign-in replaced it). Safe to keep or delete:
-- drop table if exists public.unlock_tokens;
