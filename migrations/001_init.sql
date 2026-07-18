-- ============================================================================
-- LedgerBot — Phase 1 schema (Supabase / Postgres)
-- Run once against a fresh Supabase project (SQL Editor, or psql).
-- Creates tables, journal balance trigger, indexes, and RLS policies.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

create table vendors (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text not null unique,
  preferred_language text not null default 'auto'
    check (preferred_language in ('auto', 'gu', 'hi', 'en', 'hinglish')),
  created_at timestamptz not null default now()
);

create table parties (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id),
  name text not null,
  phone text,
  party_type text check (party_type in ('customer', 'supplier', 'both')),
  created_at timestamptz default now()
);

-- Same person cannot be created twice under different casing for one vendor
create unique index parties_vendor_id_lower_name_uidx
  on parties (vendor_id, lower(name));

create table accounts (
  id text primary key, -- deterministic slugs: 'cash', 'sales', 'debtor_<party_uuid>'
  vendor_id uuid references vendors(id),
  name text not null,
  account_type text not null
    check (account_type in ('asset', 'liability', 'income', 'expense', 'equity')),
  is_party boolean not null default false,
  party_id uuid references parties(id),
  created_at timestamptz default now()
);

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id),
  entry_date date not null,
  narration text,
  source_extraction_id uuid,
  linked_product_id text,
  quantity numeric,
  created_at timestamptz default now()
);

create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null
    references journal_entries(id) on delete cascade,
  account_id text not null references accounts(id),
  debit numeric(12, 2) not null default 0 check (debit >= 0),
  credit numeric(12, 2) not null default 0 check (credit >= 0)
);

create table products (
  id text primary key, -- external product code
  vendor_id uuid references vendors(id),
  product_name text not null,
  category text,
  stock numeric not null default 0,
  price numeric(12, 2) not null default 0,
  supplier text,
  low_stock_threshold numeric not null default 5,
  last_updated timestamptz not null default now()
);

create table stock_ledger (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id),
  product_id text references products(id),
  change numeric not null,
  reason text check (reason in ('sale', 'purchase', 'bulk_upload', 'correction')),
  source_extraction_id uuid,
  new_stock_level numeric not null,
  created_at timestamptz default now()
);

create table raw_extractions (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id),
  channel text not null default 'whatsapp',
  input_type text check (input_type in ('text', 'voice', 'image', 'csv')),
  raw_input text,
  media_url text,
  command text,
  llm_parsed jsonb,
  detected_language text,
  status text not null default 'pending_confirmation'
    check (status in (
      'pending_confirmation',
      'confirmed',
      'rejected',
      'auto_expired'
    )),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 2. CORE ACCOUNTING RULE — sum(debit) must equal sum(credit) per entry
-- Deferred so multi-line inserts in one transaction can balance at COMMIT.
-- ============================================================================

create or replace function check_journal_balance()
returns trigger
language plpgsql
as $$
declare
  v_entry_id uuid;
  v_total_debit numeric;
  v_total_credit numeric;
begin
  v_entry_id := coalesce(new.journal_entry_id, old.journal_entry_id);

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_total_debit, v_total_credit
    from journal_lines
   where journal_entry_id = v_entry_id;

  if v_total_debit <> v_total_credit then
    raise exception
      'Journal entry % is not balanced: total_debit=%, total_credit=%',
      v_entry_id, v_total_debit, v_total_credit;
  end if;

  return null;
end;
$$;

create constraint trigger trg_check_journal_balance
  after insert or update on journal_lines
  deferrable initially deferred
  for each row
  execute function check_journal_balance();

-- ============================================================================
-- 3. INDEXES
-- ============================================================================

create index idx_journal_entries_vendor_entry_date
  on journal_entries (vendor_id, entry_date);

create index idx_journal_lines_account_id
  on journal_lines (account_id);

create index idx_products_vendor_id
  on products (vendor_id);

create index idx_raw_extractions_vendor_id_status
  on raw_extractions (vendor_id, status);

-- ============================================================================
-- 4. ROW LEVEL SECURITY
-- Placeholder policies: vendor rows scoped to auth.uid().
-- Service-role backend bypasses RLS; real auth wiring comes later.
-- ============================================================================

alter table vendors enable row level security;
alter table parties enable row level security;
alter table accounts enable row level security;
alter table journal_entries enable row level security;
alter table journal_lines enable row level security;
alter table products enable row level security;
alter table stock_ledger enable row level security;
alter table raw_extractions enable row level security;

create policy vendor_isolation_vendors on vendors
  for all
  using (id = auth.uid())
  with check (id = auth.uid());

create policy vendor_isolation_parties on parties
  for all
  using (vendor_id = auth.uid())
  with check (vendor_id = auth.uid());

create policy vendor_isolation_accounts on accounts
  for all
  using (vendor_id = auth.uid())
  with check (vendor_id = auth.uid());

create policy vendor_isolation_journal_entries on journal_entries
  for all
  using (vendor_id = auth.uid())
  with check (vendor_id = auth.uid());

create policy vendor_isolation_journal_lines on journal_lines
  for all
  using (
    exists (
      select 1
        from journal_entries je
       where je.id = journal_lines.journal_entry_id
         and je.vendor_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
        from journal_entries je
       where je.id = journal_lines.journal_entry_id
         and je.vendor_id = auth.uid()
    )
  );

create policy vendor_isolation_products on products
  for all
  using (vendor_id = auth.uid())
  with check (vendor_id = auth.uid());

create policy vendor_isolation_stock_ledger on stock_ledger
  for all
  using (vendor_id = auth.uid())
  with check (vendor_id = auth.uid());

create policy vendor_isolation_raw_extractions on raw_extractions
  for all
  using (vendor_id = auth.uid())
  with check (vendor_id = auth.uid());
