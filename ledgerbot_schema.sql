-- ============================================================================
-- LedgerBot — Complete Database Schema (Supabase / Postgres)
-- Run this entire file once against a fresh Supabase project (SQL Editor,
-- or `psql` / `supabase db push`). It creates every table, the core
-- balance-enforcing trigger, indexes, RLS, and a set of callable functions
-- that the backend/AI uses to RETRIEVE statement data — the AI never
-- computes these numbers itself, it only calls these functions and formats
-- the result.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. CORE TABLES
-- ============================================================================

create table vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null unique,
  preferred_language text not null default 'auto'
    check (preferred_language in ('auto','gu','hi','en','hinglish')),
  created_at timestamptz not null default now()
);

create table parties (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  name text not null,
  phone text,
  party_type text not null default 'customer'
    check (party_type in ('customer','supplier','both')),
  created_at timestamptz not null default now()
);

create unique index idx_parties_vendor_name on parties(vendor_id, lower(name));

create table accounts (
  id text primary key,                      -- deterministic slug: 'cash', 'sales',
                                             -- 'debtor_<party_id>', 'creditor_<party_id>'
  vendor_id uuid not null references vendors(id) on delete cascade,
  name text not null,
  account_type text not null
    check (account_type in ('asset','liability','income','expense','equity')),
  is_party boolean not null default false,
  party_id uuid references parties(id) on delete set null,
  created_at timestamptz not null default now()
);

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  entry_date date not null,
  narration text default '',
  source_extraction_id uuid,
  linked_product_id text,
  quantity numeric,
  created_at timestamptz not null default now()
);

create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references journal_entries(id) on delete cascade,
  account_id text not null references accounts(id),
  debit numeric(12,2) not null default 0 check (debit >= 0),
  credit numeric(12,2) not null default 0 check (credit >= 0)
);

create table products (
  id text primary key,                      -- external product code, e.g. "101"
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_name text not null,
  category text,
  stock numeric not null default 0,
  price numeric(12,2) not null default 0,
  supplier text,
  low_stock_threshold numeric not null default 5,
  last_updated timestamptz not null default now()
);

create table stock_ledger (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id text not null references products(id) on delete cascade,
  change numeric not null,
  reason text not null
    check (reason in ('sale','purchase','bulk_upload','correction')),
  source_extraction_id uuid,
  new_stock_level numeric not null,
  created_at timestamptz not null default now()
);

create table raw_extractions (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  channel text not null default 'whatsapp',
  input_type text not null check (input_type in ('text','voice','image','csv')),
  raw_input text,
  media_url text,
  command text,
  llm_parsed jsonb,
  detected_language text,
  status text not null default 'pending_confirmation'
    check (status in ('pending_confirmation','confirmed','rejected','auto_expired')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 2. THE CORE INTEGRITY GUARANTEE — enforced by the database, not the app
-- ============================================================================
-- Deferred so it checks at end-of-transaction, after ALL lines of one entry
-- have been inserted — not after each individual row.

create or replace function check_journal_balance() returns trigger as $$
declare
  v_entry_id uuid;
  v_total_debit numeric;
  v_total_credit numeric;
begin
  v_entry_id := coalesce(new.journal_entry_id, old.journal_entry_id);

  select coalesce(sum(debit),0), coalesce(sum(credit),0)
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
$$ language plpgsql;

create constraint trigger trg_check_journal_balance
after insert or update or delete on journal_lines
deferrable initially deferred
for each row execute function check_journal_balance();

-- ============================================================================
-- 3. INDEXES
-- ============================================================================

create index idx_journal_entries_vendor_date on journal_entries(vendor_id, entry_date);
create index idx_journal_lines_entry on journal_lines(journal_entry_id);
create index idx_journal_lines_account on journal_lines(account_id);
create index idx_products_vendor on products(vendor_id);
create index idx_stock_ledger_product on stock_ledger(product_id);
create index idx_raw_extractions_vendor_status on raw_extractions(vendor_id, status);
create index idx_accounts_vendor on accounts(vendor_id);

-- ============================================================================
-- 4. ROW LEVEL SECURITY (basic vendor-scoped isolation)
-- ============================================================================

alter table vendors enable row level security;
alter table parties enable row level security;
alter table accounts enable row level security;
alter table journal_entries enable row level security;
alter table journal_lines enable row level security;
alter table products enable row level security;
alter table stock_ledger enable row level security;
alter table raw_extractions enable row level security;

-- The backend uses the Supabase SERVICE ROLE key (bypasses RLS) for all
-- writes coming from WhatsApp. These policies matter once you expose any
-- data directly to a per-vendor logged-in frontend session later.
create policy vendor_isolation_parties on parties
  using (vendor_id = auth.uid());
create policy vendor_isolation_accounts on accounts
  using (vendor_id = auth.uid());
create policy vendor_isolation_journal_entries on journal_entries
  using (vendor_id = auth.uid());
create policy vendor_isolation_products on products
  using (vendor_id = auth.uid());
create policy vendor_isolation_stock_ledger on stock_ledger
  using (vendor_id = auth.uid());
create policy vendor_isolation_raw_extractions on raw_extractions
  using (vendor_id = auth.uid());

-- ============================================================================
-- 5. RETRIEVAL FUNCTIONS — this is what the AI/backend calls to build
-- statements. Every number here is computed by Postgres, never by the LLM.
-- Call these via supabase.rpc('function_name', { params }) from the backend.
-- ============================================================================

-- 5.1 Current balance of every account (powers dashboards + quick checks)
create or replace function fn_account_balances(p_vendor_id uuid)
returns table (
  account_id text,
  account_name text,
  account_type text,
  balance numeric
) language sql as $$
  select a.id, a.name, a.account_type,
         case when a.account_type in ('liability','income','equity')
              then coalesce(sum(jl.credit - jl.debit), 0)
              else coalesce(sum(jl.debit - jl.credit), 0)
         end as balance
    from accounts a
    left join journal_lines jl on jl.account_id = a.id
    left join journal_entries je on je.id = jl.journal_entry_id
   where a.vendor_id = p_vendor_id
   group by a.id, a.name, a.account_type;
$$;

-- 5.2 Profit & Loss for a date range
create or replace function fn_profit_loss(p_vendor_id uuid, p_start date, p_end date)
returns table (
  section text,
  amount numeric
) language sql as $$
  select
    case
      when a.account_type = 'income' then 'income'
      when a.account_type = 'expense' then 'expense'
    end as section,
    sum(case when a.account_type = 'income'
             then jl.credit - jl.debit
             else jl.debit - jl.credit end) as amount
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join accounts a on a.id = jl.account_id
   where je.vendor_id = p_vendor_id
     and je.entry_date between p_start and p_end
     and a.account_type in ('income','expense')
   group by a.account_type;
$$;

-- 5.3 Balance Sheet as of a date, with a self-checking "balanced" flag
create or replace function fn_balance_sheet(p_vendor_id uuid, p_as_of date)
returns table (
  assets numeric,
  liabilities numeric,
  equity numeric,
  balanced boolean
) language plpgsql as $$
declare
  v_assets numeric;
  v_liabilities numeric;
  v_equity numeric;
begin
  select coalesce(sum(jl.debit - jl.credit), 0) into v_assets
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join accounts a on a.id = jl.account_id
   where je.vendor_id = p_vendor_id and je.entry_date <= p_as_of
     and a.account_type = 'asset';

  select coalesce(sum(jl.credit - jl.debit), 0) into v_liabilities
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join accounts a on a.id = jl.account_id
   where je.vendor_id = p_vendor_id and je.entry_date <= p_as_of
     and a.account_type = 'liability';

  select coalesce(sum(jl.credit - jl.debit), 0) into v_equity
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join accounts a on a.id = jl.account_id
   where je.vendor_id = p_vendor_id and je.entry_date <= p_as_of
     and a.account_type = 'equity';

  return query
    select v_assets, v_liabilities, v_equity,
           (v_assets = v_liabilities + v_equity);
end;
$$;

-- 5.4 Cash flow: every line touching the 'cash' account, with the
-- offsetting account's type so the backend can bucket inflow/outflow.
create or replace function fn_cash_flow(p_vendor_id uuid, p_start date, p_end date)
returns table (
  entry_date date,
  narration text,
  amount numeric,
  direction text,
  offsetting_account_type text
) language sql as $$
  select je.entry_date, je.narration,
         (jl.debit - jl.credit) as amount,
         case when jl.debit > 0 then 'inflow' else 'outflow' end,
         other.account_type
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join journal_lines other_line on other_line.journal_entry_id = je.id
                                  and other_line.id <> jl.id
    join accounts other on other.id = other_line.account_id
   where je.vendor_id = p_vendor_id
     and jl.account_id = 'cash'
     and je.entry_date between p_start and p_end
   order by je.entry_date;
$$;

-- 5.5 Single account ledger (T-account / Dr.-Cr. view — powers the
-- classic ledger format and any party's udhaar balance)
create or replace function fn_ledger_account(
  p_vendor_id uuid, p_account_id text, p_start date, p_end date
)
returns table (
  entry_date date,
  narration text,
  debit numeric,
  credit numeric
) language sql as $$
  select je.entry_date, je.narration, jl.debit, jl.credit
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
   where je.vendor_id = p_vendor_id
     and jl.account_id = p_account_id
     and je.entry_date between p_start and p_end
   order by je.entry_date;
$$;

-- 5.6 Accounting Equation as of a date (thin wrapper for a one-line reply)
create or replace function fn_accounting_equation(p_vendor_id uuid, p_as_of date)
returns table (
  assets numeric,
  liabilities numeric,
  equity numeric,
  balanced boolean
) language sql as $$
  select * from fn_balance_sheet(p_vendor_id, p_as_of);
$$;

-- 5.7 Party (udhaar) ledger — billed vs paid vs pending for one person
create or replace function fn_party_ledger(p_vendor_id uuid, p_account_id text)
returns table (
  billed numeric,
  paid numeric,
  pending numeric
) language sql as $$
  select
    coalesce(sum(jl.debit), 0) as billed,
    coalesce(sum(jl.credit), 0) as paid,
    coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0) as pending
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
   where je.vendor_id = p_vendor_id
     and jl.account_id = p_account_id;
$$;

-- ============================================================================
-- 6. SEED: default chart-of-accounts entries every new vendor needs
-- Call this once per new vendor (e.g. right after inserting their vendors row)
-- ============================================================================

create or replace function fn_seed_default_accounts(p_vendor_id uuid)
returns void language sql as $$
  insert into accounts (id, vendor_id, name, account_type) values
    ('cash', p_vendor_id, 'Cash', 'asset'),
    ('sales', p_vendor_id, 'Sales', 'income'),
    ('purchases', p_vendor_id, 'Purchases', 'expense'),
    ('capital', p_vendor_id, 'Capital', 'equity'),
    ('drawings', p_vendor_id, 'Drawings', 'equity')
  on conflict (id) do nothing;
$$;
