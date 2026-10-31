-- SmartLive schema. Run once in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- Accounts that can sign in to SmartLive.
create table if not exists public.app_users (
  id            uuid primary key default gen_random_uuid(),
  username      text        not null unique,
  password_hash text        not null,
  display_name  text,
  role          text        not null default 'user' check (role in ('admin', 'user')),
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- IPTV lines attached to an account. A user may have more than one.
create table if not exists public.playlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references public.app_users(id) on delete cascade,
  name        text        not null default 'הפלייליסט שלי',
  host        text        not null,
  username    text        not null,
  password    text        not null,
  max_streams integer     not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists playlists_user_id_idx on public.playlists (user_id);
create unique index if not exists app_users_username_lower_idx on public.app_users (lower(username));

-- Only the server (service key) touches these tables; RLS with no policies
-- means the publishable key can read nothing.
alter table public.app_users enable row level security;
alter table public.playlists  enable row level security;
