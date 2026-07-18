-- ============================================================================
-- LedgerBot — Product Master, Price Verification, Profit
-- Additive migration — does not wipe existing vendors/products/journals.
-- Run against Supabase SQL Editor or: psql $DATABASE_URL -f 002_product_master.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PRODUCT MASTER (single source of truth per vendor/merchant)
-- ---------------------------------------------------------------------------
create table if not exists product_master (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_name text not null,
  normalized_name text not null,
  category text,
  brand text,
  sku text,
  barcode text,
  hsn_code text,
  gst_pct numeric(5,2) not null default 0,
  purchase_price numeric(12,2) not null default 0,
  selling_price numeric(12,2) not null default 0,
  min_selling_price numeric(12,2),
  max_selling_price numeric(12,2),
  unit text not null default 'KG'
    check (unit in ('KG','GM','L','ML','PCS','PKT','BOX','BOTTLE','DOZEN')),
  package_size numeric,
  currency text not null default 'INR',
  current_stock numeric not null default 0,
  min_stock numeric not null default 0,
  max_stock numeric,
  reorder_level numeric not null default 5,
  supplier text,
  preferred_supplier text,
  last_purchase_date date,
  last_purchase_price numeric(12,2),
  avg_purchase_price numeric(12,2),
  avg_selling_price numeric(12,2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_product_master_vendor_norm
  on product_master (vendor_id, normalized_name);
create index if not exists idx_product_master_vendor_barcode
  on product_master (vendor_id, barcode) where barcode is not null;
create index if not exists idx_product_master_vendor_active
  on product_master (vendor_id) where active = true;

-- ---------------------------------------------------------------------------
-- 2. ALIASES (Sugar / ખાંડ / Sakhar → one product_id)
-- ---------------------------------------------------------------------------
create table if not exists product_aliases (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid not null references product_master(id) on delete cascade,
  alias text not null,
  alias_normalized text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_product_aliases_vendor_norm
  on product_aliases (vendor_id, alias_normalized);
create index if not exists idx_product_aliases_product
  on product_aliases (product_id);

-- ---------------------------------------------------------------------------
-- 3. PRICE HISTORY (never overwrite silently)
-- ---------------------------------------------------------------------------
create table if not exists product_price_history (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid not null references product_master(id) on delete cascade,
  field text not null check (field in ('purchase_price','selling_price','gst_pct')),
  old_price numeric(12,2),
  new_price numeric(12,2),
  reason text,
  source_extraction_id uuid,
  updated_by text default 'whatsapp',
  created_at timestamptz not null default now()
);

create index if not exists idx_price_history_product
  on product_price_history (product_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. INVENTORY MOVEMENTS
-- ---------------------------------------------------------------------------
create table if not exists inventory_movements (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid not null references product_master(id) on delete cascade,
  change numeric not null,
  reason text not null
    check (reason in ('sale','purchase','bulk_upload','correction','opening')),
  source_extraction_id uuid,
  new_stock_level numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_inv_movements_vendor_product
  on inventory_movements (vendor_id, product_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. OCR DOCUMENTS + ITEMS
-- ---------------------------------------------------------------------------
create table if not exists ocr_documents (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  extraction_id uuid references raw_extractions(id) on delete set null,
  media_url text,
  raw_ocr text,
  detected_language text,
  document_kind text not null default 'sale_bill'
    check (document_kind in ('sale_bill','purchase_invoice','stock_sheet','other')),
  created_at timestamptz not null default now()
);

create table if not exists ocr_items (
  id uuid primary key default gen_random_uuid(),
  ocr_document_id uuid not null references ocr_documents(id) on delete cascade,
  line_no int not null default 0,
  raw_name text,
  quantity numeric,
  unit text,
  unit_price numeric(12,2),
  line_amount numeric(12,2),
  matched_product_id uuid references product_master(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6. VERIFICATION RESULTS
-- ---------------------------------------------------------------------------
create table if not exists verification_results (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  extraction_id uuid references raw_extractions(id) on delete set null,
  ocr_document_id uuid references ocr_documents(id) on delete set null,
  status text not null default 'pending'
    check (status in (
      'pending','verified','rejected','needs_review',
      'accepted_with_warning','price_updated'
    )),
  kind text not null default 'sale'
    check (kind in ('sale','purchase')),
  report jsonb not null default '{}'::jsonb,
  expected_total numeric(12,2),
  ocr_total numeric(12,2),
  difference numeric(12,2),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_verification_vendor_status
  on verification_results (vendor_id, status, created_at desc);

create table if not exists verification_logs (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null references verification_results(id) on delete cascade,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7. SALES / PURCHASE TRANSACTIONS (with profit)
-- ---------------------------------------------------------------------------
create table if not exists sales_transactions (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  party_id uuid references parties(id) on delete set null,
  journal_entry_id uuid references journal_entries(id) on delete set null,
  extraction_id uuid references raw_extractions(id) on delete set null,
  verification_id uuid references verification_results(id) on delete set null,
  entry_date date not null default current_date,
  gross_amount numeric(12,2) not null default 0,
  cost_amount numeric(12,2) not null default 0,
  profit numeric(12,2) not null default 0,
  currency text not null default 'INR',
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_txn_vendor_date
  on sales_transactions (vendor_id, entry_date desc);

create table if not exists sales_items (
  id uuid primary key default gen_random_uuid(),
  sales_transaction_id uuid not null references sales_transactions(id) on delete cascade,
  product_id uuid references product_master(id) on delete set null,
  product_name text,
  quantity numeric not null default 0,
  unit text,
  unit_price numeric(12,2) not null default 0,
  line_amount numeric(12,2) not null default 0,
  cost_price numeric(12,2) not null default 0,
  line_profit numeric(12,2) not null default 0
);

create table if not exists purchase_transactions (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  party_id uuid references parties(id) on delete set null,
  journal_entry_id uuid references journal_entries(id) on delete set null,
  extraction_id uuid references raw_extractions(id) on delete set null,
  verification_id uuid references verification_results(id) on delete set null,
  entry_date date not null default current_date,
  gross_amount numeric(12,2) not null default 0,
  master_expected numeric(12,2) not null default 0,
  variance numeric(12,2) not null default 0,
  currency text not null default 'INR',
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_transaction_id uuid not null references purchase_transactions(id) on delete cascade,
  product_id uuid references product_master(id) on delete set null,
  product_name text,
  quantity numeric not null default 0,
  unit text,
  unit_price numeric(12,2) not null default 0,
  line_amount numeric(12,2) not null default 0,
  master_price numeric(12,2) not null default 0,
  line_variance numeric(12,2) not null default 0
);

-- ---------------------------------------------------------------------------
-- 8. ALTER EXISTING TABLES
-- ---------------------------------------------------------------------------
alter table products
  add column if not exists master_product_id uuid references product_master(id) on delete set null;

alter table journal_entries
  add column if not exists sales_transaction_id uuid,
  add column if not exists purchase_transaction_id uuid,
  add column if not exists profit numeric(12,2);

-- Soft FKs after sales/purchase tables exist (idempotent)
do $$ begin
  alter table journal_entries
    add constraint journal_entries_sales_txn_fkey
    foreign key (sales_transaction_id) references sales_transactions(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table journal_entries
    add constraint journal_entries_purchase_txn_fkey
    foreign key (purchase_transaction_id) references purchase_transactions(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 9. FUTURE AI STUBS (empty shells for later modules)
-- ---------------------------------------------------------------------------
create table if not exists product_categories (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  name text not null,
  unique (vendor_id, name)
);

create table if not exists business_insights (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  insight_type text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  channel text default 'whatsapp',
  message text,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id) on delete set null,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10. BACKFILL: products → product_master + aliases
-- ---------------------------------------------------------------------------
insert into product_master (
  id, vendor_id, product_name, normalized_name, category,
  selling_price, purchase_price, current_stock, reorder_level, supplier, unit
)
select
  gen_random_uuid(),
  p.vendor_id,
  p.product_name,
  lower(regexp_replace(trim(p.product_name), '\s+', ' ', 'g')),
  p.category,
  coalesce(p.price, 0),
  0,
  coalesce(p.stock, 0),
  coalesce(p.low_stock_threshold, 5),
  p.supplier,
  'KG'
from products p
where not exists (
  select 1 from product_master m
  where m.vendor_id = p.vendor_id
    and m.normalized_name = lower(regexp_replace(trim(p.product_name), '\s+', ' ', 'g'))
);

update products p
set master_product_id = m.id
from product_master m
where p.vendor_id = m.vendor_id
  and lower(regexp_replace(trim(p.product_name), '\s+', ' ', 'g')) = m.normalized_name
  and p.master_product_id is null;

insert into product_aliases (vendor_id, product_id, alias, alias_normalized)
select m.vendor_id, m.id, m.product_name, m.normalized_name
from product_master m
where not exists (
  select 1 from product_aliases a
  where a.vendor_id = m.vendor_id and a.alias_normalized = m.normalized_name
);

-- Today's profit helper
create or replace function fn_today_profit(p_vendor_id uuid, p_date date default current_date)
returns table (
  entry_date date,
  sales_count bigint,
  gross_amount numeric,
  cost_amount numeric,
  profit numeric
) language sql as $$
  select
    p_date,
    count(*)::bigint,
    coalesce(sum(st.gross_amount), 0),
    coalesce(sum(st.cost_amount), 0),
    coalesce(sum(st.profit), 0)
  from sales_transactions st
  where st.vendor_id = p_vendor_id
    and st.entry_date = p_date;
$$;
