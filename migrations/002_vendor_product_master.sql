-- ============================================================================
-- LedgerBot — Phase 2 schema
-- Vendor Product Master + Price Verification Engine
-- Run AFTER migrations/001_init.sql
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ----------------------------------------------------------------------------
-- Canonical status enums used by verification + notifications
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'verification_status_enum') then
    create type verification_status_enum as enum (
      'pending',
      'verified',
      'rejected',
      'needs_review',
      'price_updated',
      'accepted_with_warning'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'notification_status_enum') then
    create type notification_status_enum as enum (
      'pending',
      'sent',
      'failed',
      'read'
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Existing-table extensions
-- ----------------------------------------------------------------------------
alter table if exists journal_entries
  add column if not exists transaction_type text
    check (transaction_type in ('sale', 'purchase', 'payment', 'receipt', 'expense'));

alter table if exists journal_entries
  add column if not exists profit numeric(14, 2) not null default 0;

alter table if exists raw_extractions
  add column if not exists verification_status verification_status_enum default 'pending';

alter table if exists raw_extractions
  add column if not exists verification_summary jsonb;

-- ----------------------------------------------------------------------------
-- Required domain tables
-- ----------------------------------------------------------------------------
create table if not exists merchants (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null unique references vendors(id) on delete cascade,
  business_name text,
  currency text not null default 'INR',
  timezone text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  name text,
  phone text,
  role text not null default 'owner',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  party_id uuid unique references parties(id) on delete set null,
  name text not null,
  phone text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_categories (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  parent_id uuid references product_categories(id) on delete set null,
  category_name text not null,
  normalized_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_id, normalized_name)
);

create table if not exists product_master (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_name text not null,
  normalized_name text not null,
  category_id uuid references product_categories(id) on delete set null,
  brand text,
  sku text,
  barcode text,
  hsn_code text,
  gst_percent numeric(5, 2),
  purchase_price numeric(14, 2),
  selling_price numeric(14, 2),
  min_selling_price numeric(14, 2),
  max_selling_price numeric(14, 2),
  base_unit text not null default 'PCS',
  unit_conversion jsonb not null default '{}'::jsonb,
  package_size numeric(14, 3),
  currency text not null default 'INR',
  current_stock numeric(14, 3) not null default 0,
  min_stock numeric(14, 3),
  max_stock numeric(14, 3),
  reorder_level numeric(14, 3),
  supplier_party_id uuid references parties(id) on delete set null,
  preferred_supplier_id uuid references parties(id) on delete set null,
  last_purchase_date date,
  last_purchase_price numeric(14, 2),
  average_purchase_price numeric(14, 2),
  average_selling_price numeric(14, 2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_id, normalized_name)
);

create table if not exists product_aliases (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid not null references product_master(id) on delete cascade,
  alias_name text not null,
  normalized_alias text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (vendor_id, normalized_alias)
);

create table if not exists product_prices (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid not null references product_master(id) on delete cascade,
  supplier_party_id uuid references parties(id) on delete set null,
  price_type text not null check (price_type in ('purchase', 'selling')),
  unit text not null,
  amount numeric(14, 2) not null check (amount >= 0),
  currency text not null default 'INR',
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  is_active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_product_prices_active_unique
  on product_prices (
    vendor_id,
    product_id,
    price_type,
    unit,
    coalesce(supplier_party_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where is_active;

create table if not exists product_price_history (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid not null references product_master(id) on delete cascade,
  supplier_party_id uuid references parties(id) on delete set null,
  price_type text not null check (price_type in ('purchase', 'selling')),
  unit text not null,
  old_price numeric(14, 2),
  new_price numeric(14, 2) not null,
  reason text,
  updated_by text,
  created_at timestamptz not null default now()
);

create table if not exists supplier_products (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  supplier_party_id uuid not null references parties(id) on delete cascade,
  product_id uuid not null references product_master(id) on delete cascade,
  supplier_product_name text,
  supplier_sku text,
  last_purchase_price numeric(14, 2),
  last_purchase_date date,
  is_preferred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_id, supplier_party_id, product_id)
);

create table if not exists inventory (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid not null unique references product_master(id) on delete cascade,
  current_stock numeric(14, 3) not null default 0,
  reserved_stock numeric(14, 3) not null default 0,
  available_stock numeric(14, 3) generated always as (current_stock - reserved_stock) stored,
  average_cost numeric(14, 2),
  stock_valuation numeric(14, 2),
  updated_at timestamptz not null default now()
);

create table if not exists inventory_movements (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid not null references product_master(id) on delete cascade,
  movement_type text not null
    check (movement_type in ('purchase', 'sale', 'adjustment', 'opening', 'return')),
  quantity numeric(14, 3) not null,
  unit text not null,
  converted_quantity numeric(14, 3),
  reference_type text,
  reference_id uuid,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists purchase_transactions (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  source_extraction_id uuid references raw_extractions(id) on delete set null,
  supplier_party_id uuid references parties(id) on delete set null,
  invoice_number text,
  invoice_date date not null default current_date,
  subtotal numeric(14, 2),
  gst_total numeric(14, 2),
  total_amount numeric(14, 2) not null default 0,
  currency text not null default 'INR',
  verification_status verification_status_enum not null default 'pending',
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_transaction_id uuid not null references purchase_transactions(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid references product_master(id) on delete set null,
  product_name_raw text,
  quantity numeric(14, 3),
  unit text,
  unit_price numeric(14, 2),
  line_amount numeric(14, 2),
  gst_percent numeric(5, 2),
  verification_status verification_status_enum not null default 'pending',
  verification_notes jsonb,
  created_at timestamptz not null default now()
);

create table if not exists sales_transactions (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  source_extraction_id uuid references raw_extractions(id) on delete set null,
  customer_party_id uuid references parties(id) on delete set null,
  bill_number text,
  bill_date date not null default current_date,
  subtotal numeric(14, 2),
  gst_total numeric(14, 2),
  total_amount numeric(14, 2) not null default 0,
  expected_total numeric(14, 2),
  difference_amount numeric(14, 2),
  profit numeric(14, 2) not null default 0,
  currency text not null default 'INR',
  verification_status verification_status_enum not null default 'pending',
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists sales_items (
  id uuid primary key default gen_random_uuid(),
  sales_transaction_id uuid not null references sales_transactions(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid references product_master(id) on delete set null,
  product_name_raw text,
  quantity numeric(14, 3),
  unit text,
  unit_price numeric(14, 2),
  line_amount numeric(14, 2),
  cost_price numeric(14, 2),
  line_cost numeric(14, 2),
  line_profit numeric(14, 2),
  gst_percent numeric(5, 2),
  verification_status verification_status_enum not null default 'pending',
  verification_notes jsonb,
  created_at timestamptz not null default now()
);

create table if not exists ocr_documents (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  raw_extraction_id uuid references raw_extractions(id) on delete set null,
  input_type text,
  media_url text,
  ocr_text text,
  ocr_text_hash text,
  detected_language text,
  created_at timestamptz not null default now()
);

create table if not exists ocr_items (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  document_id uuid not null references ocr_documents(id) on delete cascade,
  line_no int,
  raw_name text,
  normalized_name text,
  quantity numeric(14, 3),
  unit text,
  unit_price numeric(14, 2),
  line_amount numeric(14, 2),
  gst_percent numeric(5, 2),
  mapped_product_id uuid references product_master(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists verification_results (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  raw_extraction_id uuid references raw_extractions(id) on delete set null,
  document_id uuid references ocr_documents(id) on delete set null,
  transaction_type text
    check (transaction_type in ('sale', 'purchase', 'inventory_bulk', 'unknown')),
  status verification_status_enum not null default 'pending',
  expected_total numeric(14, 2),
  detected_total numeric(14, 2),
  difference_amount numeric(14, 2),
  summary text,
  warnings jsonb,
  requires_confirmation boolean not null default true,
  resolution_action text,
  resolved_by text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists verification_logs (
  id uuid primary key default gen_random_uuid(),
  verification_result_id uuid not null references verification_results(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  journal_entry_id uuid references journal_entries(id) on delete cascade,
  transaction_ref text,
  amount numeric(14, 2) not null default 0,
  direction text check (direction in ('debit', 'credit')),
  account_name text,
  created_at timestamptz not null default now()
);

create table if not exists gst_records (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  transaction_type text check (transaction_type in ('sale', 'purchase')),
  transaction_id uuid,
  product_id uuid references product_master(id) on delete set null,
  taxable_amount numeric(14, 2),
  gst_percent numeric(5, 2),
  gst_amount numeric(14, 2),
  cgst_amount numeric(14, 2),
  sgst_amount numeric(14, 2),
  igst_amount numeric(14, 2),
  created_at timestamptz not null default now()
);

create table if not exists business_insights (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  insight_type text not null,
  insight_date date not null default current_date,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  channel text not null default 'whatsapp',
  status notification_status_enum not null default 'pending',
  title text,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id) on delete cascade,
  actor_type text not null default 'system',
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Query performance indexes
-- ----------------------------------------------------------------------------
create index if not exists idx_product_master_vendor_normalized
  on product_master (vendor_id, normalized_name);
create index if not exists idx_product_master_vendor_barcode
  on product_master (vendor_id, barcode);
create index if not exists idx_product_aliases_vendor_alias
  on product_aliases (vendor_id, normalized_alias);
create index if not exists idx_product_aliases_alias_trgm
  on product_aliases using gin (normalized_alias gin_trgm_ops);
create index if not exists idx_product_prices_vendor_product
  on product_prices (vendor_id, product_id, price_type, is_active, effective_from desc);
create index if not exists idx_inventory_product
  on inventory (vendor_id, product_id);
create index if not exists idx_inventory_movements_vendor_created
  on inventory_movements (vendor_id, created_at desc);
create index if not exists idx_ocr_documents_vendor_created
  on ocr_documents (vendor_id, created_at desc);
create index if not exists idx_verification_results_vendor_status
  on verification_results (vendor_id, status, created_at desc);
create index if not exists idx_sales_transactions_vendor_date
  on sales_transactions (vendor_id, bill_date desc);
create index if not exists idx_purchase_transactions_vendor_date
  on purchase_transactions (vendor_id, invoice_date desc);
create index if not exists idx_journal_entries_vendor_date_profit
  on journal_entries (vendor_id, entry_date, profit);

-- ----------------------------------------------------------------------------
-- Utility SQL functions
-- ----------------------------------------------------------------------------
create or replace function fn_today_profit(p_vendor_id uuid, p_date date default current_date)
returns table (
  profit_amount numeric,
  sales_amount numeric,
  estimated_cost numeric
) language sql as $$
  with sales_agg as (
    select
      coalesce(sum(st.total_amount), 0) as sales_amount,
      coalesce(sum(st.profit), 0) as profit_amount
    from sales_transactions st
    where st.vendor_id = p_vendor_id
      and st.bill_date = p_date
      and st.verification_status in ('verified', 'accepted_with_warning', 'price_updated')
  ),
  fallback as (
    select
      coalesce(sum(je.profit), 0) as profit_amount
    from journal_entries je
    where je.vendor_id = p_vendor_id
      and je.entry_date = p_date
  )
  select
    case
      when sa.profit_amount <> 0 then sa.profit_amount
      else fb.profit_amount
    end as profit_amount,
    sa.sales_amount as sales_amount,
    (sa.sales_amount - case when sa.profit_amount <> 0 then sa.profit_amount else fb.profit_amount end) as estimated_cost
  from sales_agg sa
  cross join fallback fb;
$$;
