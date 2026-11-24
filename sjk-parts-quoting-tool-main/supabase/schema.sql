-- SJK Parts Quoting Tool — Supabase database (phase 1: shared data + real logins).
-- Run once in Supabase → SQL Editor → New query → paste this file → Run. Safe to re-run.
--
-- What it gives the tool:
--   profiles     one row per person (role admin/sales, title, office, Zoho user id, active)
--   settings     costing history; the newest row is live for everyone
--   part_edits   admin overrides per part (weight, category, dangerous goods, notes)
--   price_lists  published parts_data.json imports; the newest active one is live
--   quotes       every quote with its versions (whole quote kept as JSON, same shape as the app)
--   zoho_log     support log of Zoho requests
-- Row Level Security: sales see their own quotes; admins see everything and are the only ones
-- who can change costing, parts data and users. Deactivated people can read nothing.

-- ---------- people ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null unique,
  name          text not null default '',
  role          text not null default 'sales' check (role in ('admin', 'sales')),
  title         text not null default '',
  mobile        text not null default '',
  office        text not null default '',
  zoho_user_id  text not null default '',
  active        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$$;

-- A new login gets a profile automatically. The very first person becomes an active admin;
-- everyone after that starts INACTIVE until an admin activates them (the admin-users function
-- does this when it creates the account). So even if public sign-ups were left on by mistake,
-- a stranger who signs up can't read anything.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first boolean;
begin
  select not exists (select 1 from profiles) into first;
  insert into profiles (id, email, name, role, active)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
          case when first then 'admin' else 'sales' end, first)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Never leave the tool without an active admin.
create or replace function public.keep_one_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active)
     and not exists (select 1 from profiles where role = 'admin' and active and id <> old.id) then
    raise exception 'Keep at least one active admin.';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_keep_one_admin on public.profiles;
create trigger profiles_keep_one_admin before update on public.profiles
  for each row execute function public.keep_one_admin();

alter table public.profiles enable row level security;
drop policy if exists "profiles: read" on public.profiles;
create policy "profiles: read" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active_user());
drop policy if exists "profiles: admins update" on public.profiles;
create policy "profiles: admins update" on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- No insert/delete policy: accounts are created by the trigger / admin-users function only.

-- ---------- costing settings (append-only history) ----------
create table if not exists public.settings (
  id               text primary key default gen_random_uuid()::text,
  values           jsonb not null,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.profiles (id) default auth.uid(),
  created_by_name  text not null default ''
);
alter table public.settings enable row level security;
drop policy if exists "settings: read" on public.settings;
create policy "settings: read" on public.settings for select to authenticated using (public.is_active_user());
drop policy if exists "settings: admins add" on public.settings;
create policy "settings: admins add" on public.settings for insert to authenticated
  with check (public.is_admin() and created_by = auth.uid());

-- ---------- per-part admin edits ----------
create table if not exists public.part_edits (
  pn          text primary key,
  edit        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) default auth.uid()
);
alter table public.part_edits enable row level security;
drop policy if exists "part_edits: read" on public.part_edits;
create policy "part_edits: read" on public.part_edits for select to authenticated using (public.is_active_user());
drop policy if exists "part_edits: admins write" on public.part_edits;
create policy "part_edits: admins write" on public.part_edits for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- published price lists ----------
create table if not exists public.price_lists (
  id               bigint generated always as identity primary key,
  version          text not null default '',
  data             jsonb not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.profiles (id) default auth.uid(),
  created_by_name  text not null default ''
);
alter table public.price_lists enable row level security;
drop policy if exists "price_lists: read" on public.price_lists;
create policy "price_lists: read" on public.price_lists for select to authenticated using (public.is_active_user());
drop policy if exists "price_lists: admins write" on public.price_lists;
create policy "price_lists: admins write" on public.price_lists for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- quotes ----------
create table if not exists public.quotes (
  id          text primary key,
  created_by  uuid not null references public.profiles (id),
  status      text not null default 'draft',
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists quotes_created_by on public.quotes (created_by);
create index if not exists quotes_updated_at on public.quotes (updated_at desc);
alter table public.quotes enable row level security;
drop policy if exists "quotes: read own or admin" on public.quotes;
create policy "quotes: read own or admin" on public.quotes for select to authenticated
  using ((created_by = auth.uid() and public.is_active_user()) or public.is_admin());
drop policy if exists "quotes: add own" on public.quotes;
create policy "quotes: add own" on public.quotes for insert to authenticated
  with check ((created_by = auth.uid() and public.is_active_user()) or public.is_admin());
drop policy if exists "quotes: change own or admin" on public.quotes;
create policy "quotes: change own or admin" on public.quotes for update to authenticated
  using ((created_by = auth.uid() and public.is_active_user()) or public.is_admin())
  with check ((created_by = auth.uid() and public.is_active_user()) or public.is_admin());
-- No delete policy: quotes are never deleted (status lost/expired instead).

-- ---------- Zoho request log ----------
create table if not exists public.zoho_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid references public.profiles (id) default auth.uid(),
  entry       jsonb not null
);
alter table public.zoho_log enable row level security;
drop policy if exists "zoho_log: add" on public.zoho_log;
create policy "zoho_log: add" on public.zoho_log for insert to authenticated with check (public.is_active_user());
drop policy if exists "zoho_log: admins read" on public.zoho_log;
create policy "zoho_log: admins read" on public.zoho_log for select to authenticated using (public.is_admin());

-- ---------- live updates (costing saved by an admin reaches every open screen) ----------
do $$
declare t text;
begin
  foreach t in array array['settings', 'part_edits', 'price_lists', 'quotes', 'profiles'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
