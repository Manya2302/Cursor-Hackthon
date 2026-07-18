-- Nirvha auth tables (run in Supabase SQL Editor)
-- Safe to run multiple times.

create extension if not exists pgcrypto;

create table if not exists auth_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  phone text not null unique,
  password_hash text,
  vendor_id uuid references vendors(id),
  whatsapp_greeted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists auth_otps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text not null,
  otp text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists auth_otps_phone_idx on auth_otps (phone);
create index if not exists auth_otps_email_idx on auth_otps (email);
