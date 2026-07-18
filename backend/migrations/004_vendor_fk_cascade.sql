-- Fix vendor_id foreign keys still on NO ACTION so deleting a vendor
-- cascades instead of failing with "still referenced from table ...".
-- Idempotent: safe to re-run.

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'parties_vendor_id_fkey') then
    alter table parties drop constraint parties_vendor_id_fkey;
  end if;
  alter table parties
    add constraint parties_vendor_id_fkey
    foreign key (vendor_id) references vendors(id) on delete cascade;

  if exists (select 1 from pg_constraint where conname = 'accounts_vendor_id_fkey') then
    alter table accounts drop constraint accounts_vendor_id_fkey;
  end if;
  alter table accounts
    add constraint accounts_vendor_id_fkey
    foreign key (vendor_id) references vendors(id) on delete cascade;

  if exists (select 1 from pg_constraint where conname = 'journal_entries_vendor_id_fkey') then
    alter table journal_entries drop constraint journal_entries_vendor_id_fkey;
  end if;
  alter table journal_entries
    add constraint journal_entries_vendor_id_fkey
    foreign key (vendor_id) references vendors(id) on delete cascade;

  if exists (select 1 from pg_constraint where conname = 'products_vendor_id_fkey') then
    alter table products drop constraint products_vendor_id_fkey;
  end if;
  alter table products
    add constraint products_vendor_id_fkey
    foreign key (vendor_id) references vendors(id) on delete cascade;

  if exists (select 1 from pg_constraint where conname = 'stock_ledger_vendor_id_fkey') then
    alter table stock_ledger drop constraint stock_ledger_vendor_id_fkey;
  end if;
  alter table stock_ledger
    add constraint stock_ledger_vendor_id_fkey
    foreign key (vendor_id) references vendors(id) on delete cascade;
end $$;
