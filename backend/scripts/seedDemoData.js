/**
 * Seed demo data for live demos / judge runs.
 * Usage: node scripts/seedDemoData.js [phone]
 * Default phone: 919999000001
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { parseCsv, validateRows } = require('../src/services/inventoryImport');
const { upsertProducts } = require('../src/services/inventoryUpsert');
const { ensureDefaultAccounts } = require('../src/services/ledger');
const dayjs = require('dayjs');

const DEMO_PHONE = (process.argv[2] || process.env.DEMO_VENDOR_PHONE || '919999000001').replace(
  /\D/g,
  ''
);
const DEMO_NAME = process.env.DEMO_VENDOR_NAME || 'Demo Kirana';

async function main() {
  const connectionString =
    process.env.DATABASE_URL || process.env.SUPABASE_API || '';
  if (!connectionString) {
    console.error('DATABASE_URL / SUPABASE_API not set');
    process.exit(1);
  }

  const pg = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pg.connect();

  try {
    await client.query('begin');

    const vendorRes = await client.query(
      `insert into vendors (phone, name, preferred_language)
       values ($1, $2, 'en')
       on conflict (phone) do update
         set name = excluded.name
       returning id, phone, name`,
      [DEMO_PHONE, DEMO_NAME]
    );
    const vendor = vendorRes.rows[0];
    console.log('Vendor:', vendor.id, vendor.phone);

    // Wipe prior demo journals / stock for this vendor (keep vendor row)
    await client.query(
      `delete from stock_ledger where vendor_id = $1`,
      [vendor.id]
    );
    await client.query(`delete from products where vendor_id = $1`, [vendor.id]);
    await client.query(
      `delete from journal_lines
        where journal_entry_id in (
          select id from journal_entries where vendor_id = $1
        )`,
      [vendor.id]
    );
    await client.query(`delete from journal_entries where vendor_id = $1`, [
      vendor.id,
    ]);
    await client.query(`delete from raw_extractions where vendor_id = $1`, [
      vendor.id,
    ]);
    // Keep parties/accounts for reuse; ensure defaults
    await ensureDefaultAccounts(client, vendor.id);

    const parties = [
      { name: 'Ramesh Traders', phone: '9876543210', role: 'customer' },
      { name: 'Om Trivedi', phone: '9974099063', role: 'customer' },
      { name: 'Sita Provisions', phone: '9123456780', role: 'customer' },
      { name: 'Amul Distributor', phone: '9988776655', role: 'supplier' },
      { name: 'Local Mill', phone: '9876501234', role: 'supplier' },
      { name: 'Wholesale Mart', phone: '9765432109', role: 'supplier' },
    ];

    const partyIds = {};
    for (const p of parties) {
      const ex = await client.query(
        `select id from parties where vendor_id = $1 and lower(name) = lower($2)`,
        [vendor.id, p.name]
      );
      let id = ex.rows[0]?.id;
      if (!id) {
        const r = await client.query(
          `insert into parties (vendor_id, name, phone, party_type)
           values ($1, $2, $3, $4)
           returning id`,
          [vendor.id, p.name, p.phone, p.role === 'supplier' ? 'supplier' : 'customer']
        );
        id = r.rows[0].id;
      } else {
        await client.query(
          `update parties set phone = coalesce($2, phone), party_type = $3
            where id = $1`,
          [id, p.phone, p.role === 'supplier' ? 'supplier' : 'customer']
        );
      }
      partyIds[p.name] = id;
      const acctId =
        p.role === 'supplier' ? `creditor_${id}` : `debtor_${id}`;
      const acctType = p.role === 'supplier' ? 'liability' : 'asset';
      await client.query(
        `insert into accounts (id, vendor_id, name, account_type, is_party, party_id)
         values ($1, $2, $3, $4, true, $5)
         on conflict (id) do nothing`,
        [acctId, vendor.id, p.name, acctType, id]
      );
    }

    await client.query('commit');

    // Products from sample CSV
    const csvPath = path.join(__dirname, '..', '..', 'sample_inventory.csv');
    const csvBuf = fs.readFileSync(csvPath);
    const { validRows } = validateRows(parseCsv(csvBuf));
    const inv = await upsertProducts(vendor.id, validRows, null);
    console.log('Products upserted:', inv.count);

    // Journal entries spanning last 2 months
    await client.query('begin');
    await ensureDefaultAccounts(client, vendor.id);

    const today = dayjs();
    const entries = [
      {
        date: today.subtract(45, 'day').format('YYYY-MM-DD'),
        narration: 'Opening capital',
        lines: [
          { account: 'cash', debit: 100000, credit: 0 },
          { account: 'capital', debit: 0, credit: 100000 },
        ],
      },
      {
        date: today.subtract(40, 'day').format('YYYY-MM-DD'),
        narration: 'Stock purchase — Local Mill',
        lines: [
          { account: 'purchases', debit: 15000, credit: 0 },
          { account: 'cash', debit: 0, credit: 15000 },
        ],
      },
      {
        date: today.subtract(35, 'day').format('YYYY-MM-DD'),
        narration: 'Cash sale — walk-in',
        lines: [
          { account: 'cash', debit: 3200, credit: 0 },
          { account: 'sales', debit: 0, credit: 3200 },
        ],
      },
      {
        date: today.subtract(30, 'day').format('YYYY-MM-DD'),
        narration: 'Credit sale — Ramesh Traders',
        lines: [
          { account: `debtor_${partyIds['Ramesh Traders']}`, debit: 5400, credit: 0 },
          { account: 'sales', debit: 0, credit: 5400 },
        ],
      },
      {
        date: today.subtract(28, 'day').format('YYYY-MM-DD'),
        narration: 'Payment received — Ramesh Traders',
        lines: [
          { account: 'cash', debit: 3000, credit: 0 },
          { account: `debtor_${partyIds['Ramesh Traders']}`, debit: 0, credit: 3000 },
        ],
      },
      {
        date: today.subtract(20, 'day').format('YYYY-MM-DD'),
        narration: 'Credit sale — Om Trivedi',
        lines: [
          { account: `debtor_${partyIds['Om Trivedi']}`, debit: 2100, credit: 0 },
          { account: 'sales', debit: 0, credit: 2100 },
        ],
      },
      {
        date: today.subtract(15, 'day').format('YYYY-MM-DD'),
        narration: 'Shop rent expense',
        lines: [
          { account: 'expenses', debit: 4000, credit: 0 },
          { account: 'cash', debit: 0, credit: 4000 },
        ],
      },
      {
        date: today.subtract(12, 'day').format('YYYY-MM-DD'),
        narration: 'Borrow from friend (loan)',
        lines: [
          { account: 'cash', debit: 10000, credit: 0 },
          { account: 'capital', debit: 0, credit: 10000 },
        ],
      },
      {
        date: today.subtract(10, 'day').format('YYYY-MM-DD'),
        narration: 'Cash sale — Sita Provisions',
        lines: [
          { account: 'cash', debit: 1800, credit: 0 },
          { account: 'sales', debit: 0, credit: 1800 },
        ],
      },
      {
        date: today.subtract(7, 'day').format('YYYY-MM-DD'),
        narration: 'Purchase — Amul Distributor',
        lines: [
          { account: 'purchases', debit: 6500, credit: 0 },
          { account: `creditor_${partyIds['Amul Distributor']}`, debit: 0, credit: 6500 },
        ],
      },
      {
        date: today.subtract(5, 'day').format('YYYY-MM-DD'),
        narration: 'Paid Amul Distributor',
        lines: [
          { account: `creditor_${partyIds['Amul Distributor']}`, debit: 4000, credit: 0 },
          { account: 'cash', debit: 0, credit: 4000 },
        ],
      },
      {
        date: today.subtract(3, 'day').format('YYYY-MM-DD'),
        narration: 'Owner drawings',
        lines: [
          { account: 'drawings', debit: 2000, credit: 0 },
          { account: 'cash', debit: 0, credit: 2000 },
        ],
      },
      {
        date: today.subtract(1, 'day').format('YYYY-MM-DD'),
        narration: 'Cash sale — today prep',
        lines: [
          { account: 'cash', debit: 2500, credit: 0 },
          { account: 'sales', debit: 0, credit: 2500 },
        ],
      },
      {
        date: today.format('YYYY-MM-DD'),
        narration: 'Payment received — Om Trivedi',
        lines: [
          { account: 'cash', debit: 1000, credit: 0 },
          { account: `debtor_${partyIds['Om Trivedi']}`, debit: 0, credit: 1000 },
        ],
      },
    ];

    for (const e of entries) {
      const je = await client.query(
        `insert into journal_entries (vendor_id, entry_date, narration)
         values ($1, $2::date, $3)
         returning id`,
        [vendor.id, e.date, e.narration]
      );
      const jeId = je.rows[0].id;
      for (const line of e.lines) {
        await client.query(
          `insert into journal_lines (journal_entry_id, account_id, debit, credit)
           values ($1, $2, $3, $4)`,
          [jeId, line.account, line.debit, line.credit]
        );
      }
    }

    await client.query('commit');
    console.log(`Seeded ${entries.length} journal entries for ${DEMO_NAME}`);
    console.log(`DEMO_VENDOR_ID=${vendor.id}`);
    console.log(`DEMO_VENDOR_PHONE=${vendor.phone}`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pg.end();
  }
}

main();
