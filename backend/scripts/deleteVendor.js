/**
 * Delete a vendor and all dependent rows, then ensure
 * raw_extractions.vendor_id has ON DELETE CASCADE.
 *
 * Usage: node scripts/deleteVendor.js <vendor-uuid>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const vendorId = process.argv[2];
if (!vendorId) {
  console.error('Usage: node scripts/deleteVendor.js <vendor-uuid>');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.SUPABASE_API || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function del(client, sql, params, label) {
  try {
    const r = await client.query(sql, params);
    console.log(`  ${label}: ${r.rowCount}`);
  } catch (err) {
    console.log(`  ${label}: skip — ${err.message.split('\n')[0]}`);
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const v = await client.query(
      `select id, phone, name from vendors where id = $1`,
      [vendorId]
    );
    if (!v.rows[0]) {
      console.log('Vendor not found:', vendorId);
      return;
    }
    console.log('Deleting vendor:', v.rows[0]);

    await client.query('begin');

    // Nested children first
    await del(
      client,
      `delete from verification_logs
        where verification_id in (
          select id from verification_results where vendor_id = $1
        )`,
      [vendorId],
      'verification_logs'
    );
    await del(
      client,
      `delete from sales_items
        where sales_transaction_id in (
          select id from sales_transactions where vendor_id = $1
        )`,
      [vendorId],
      'sales_items'
    );
    await del(
      client,
      `delete from purchase_items
        where purchase_transaction_id in (
          select id from purchase_transactions where vendor_id = $1
        )`,
      [vendorId],
      'purchase_items'
    );
    await del(
      client,
      `delete from ocr_items
        where ocr_document_id in (
          select id from ocr_documents where vendor_id = $1
        )`,
      [vendorId],
      'ocr_items'
    );
    await del(
      client,
      `delete from journal_lines
        where journal_entry_id in (
          select id from journal_entries where vendor_id = $1
        )`,
      [vendorId],
      'journal_lines'
    );

    // Clear journal FKs pointing at sales/purchase txns
    await del(
      client,
      `update journal_entries
          set sales_transaction_id = null,
              purchase_transaction_id = null
        where vendor_id = $1`,
      [vendorId],
      'journal_entries unlink txns'
    );

    for (const table of [
      'sales_transactions',
      'purchase_transactions',
      'verification_results',
      'ocr_documents',
      'inventory_movements',
      'product_price_history',
      'product_aliases',
      'product_master',
      'stock_ledger',
      'journal_entries',
      'raw_extractions',
      'products',
      'parties',
      'accounts',
    ]) {
      await del(
        client,
        `delete from ${table} where vendor_id = $1`,
        [vendorId],
        table
      );
    }

    // Ensure future deletes cascade from vendors → raw_extractions
    await client.query(`
      do $$
      begin
        if exists (
          select 1 from pg_constraint where conname = 'raw_extractions_vendor_id_fkey'
        ) then
          alter table raw_extractions drop constraint raw_extractions_vendor_id_fkey;
        end if;
        alter table raw_extractions
          add constraint raw_extractions_vendor_id_fkey
          foreign key (vendor_id) references vendors(id) on delete cascade;
      end $$;
    `);
    console.log('  fixed raw_extractions_vendor_id_fkey → ON DELETE CASCADE');

    const delV = await client.query(`delete from vendors where id = $1`, [
      vendorId,
    ]);
    console.log(`  vendors: ${delV.rowCount}`);

    await client.query('commit');
    console.log('Done.');
  } catch (err) {
    await client.query('rollback');
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
