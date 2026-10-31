-- Per-user access: which sections they may use, and which channel packages.
-- Run once in the Supabase SQL editor on an existing installation.

alter table public.app_users
  add column if not exists has_live boolean not null default true,
  add column if not exists has_vod  boolean not null default true,
  -- null or empty = every package the playlist carries
  add column if not exists allowed_genres text[];
