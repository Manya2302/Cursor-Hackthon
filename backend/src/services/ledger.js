const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString =
    process.env.DATABASE_URL || process.env.SUPABASE_API || '';
  if (!connectionString) return null;
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

async function ensureDefaultAccounts(client, vendorId) {
  await client.query(
    `insert into accounts (id, vendor_id, name, account_type, is_party)
     values
       ('cash', $1, 'Cash', 'asset', false),
       ('sales', $1, 'Sales', 'income', false),
       ('purchases', $1, 'Purchases', 'expense', false),
       ('capital', $1, 'Capital', 'equity', false)
     on conflict (id) do nothing`,
    [vendorId]
  );
}

async function ensurePartyAndDebtor(client, vendorId, partyName) {
  if (!partyName) return null;

  const existing = await client.query(
    `select id, name from parties
      where vendor_id = $1 and lower(name) = lower($2)
      limit 1`,
    [vendorId, partyName]
  );

  let partyId;
  if (existing.rows[0]) {
    partyId = existing.rows[0].id;
  } else {
    const inserted = await client.query(
      `insert into parties (vendor_id, name, party_type)
       values ($1, $2, 'customer')
       returning id`,
      [vendorId, partyName]
    );
    partyId = inserted.rows[0].id;
  }

  const accountId = `debtor_${partyId}`;
  await client.query(
    `insert into accounts (id, vendor_id, name, account_type, is_party, party_id)
     values ($1, $2, $3, 'asset', true, $4)
     on conflict (id) do nothing`,
    [accountId, vendorId, `${partyName} (Receivable)`, partyId]
  );

  return { partyId, accountId, name: partyName };
}

/**
 * Post a confirmed transaction extraction into journal_entries + journal_lines.
 * Uses only amounts stated in llm_parsed payments (never invents totals).
 */
async function postTransaction(vendorId, extraction) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const parsed =
    typeof extraction.llm_parsed === 'string'
      ? JSON.parse(extraction.llm_parsed)
      : extraction.llm_parsed;

  const client = await pg.connect();
  try {
    await client.query('begin');
    await ensureDefaultAccounts(client, vendorId);

    const payments = Array.isArray(parsed.payments) ? parsed.payments : [];
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const partyName = parsed.party?.name || null;

    const lines = [];
    let cashTotal = 0;
    let udhaarTotal = 0;

    for (const p of payments) {
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const method = String(p.method || '').toLowerCase();
      if (method === 'udhaar' || method === 'credit') {
        udhaarTotal += amount;
      } else {
        cashTotal += amount;
      }
    }

    // If only a single stated total and no payment split, treat as cash
    if (cashTotal === 0 && udhaarTotal === 0 && parsed.total_amount != null) {
      const t = Number(parsed.total_amount);
      if (Number.isFinite(t) && t > 0) cashTotal = t;
    }

    const salesTotal = cashTotal + udhaarTotal;
    if (salesTotal <= 0) {
      throw new Error('No payment amounts found to post');
    }

    let debtor = null;
    if (udhaarTotal > 0 || partyName) {
      debtor = await ensurePartyAndDebtor(
        client,
        vendorId,
        payments.find((p) => p.party_name)?.party_name || partyName
      );
    }

    if (cashTotal > 0) {
      lines.push({ account_id: 'cash', debit: cashTotal, credit: 0 });
    }
    if (udhaarTotal > 0) {
      if (!debtor) throw new Error('Udhaar amount needs a party name');
      lines.push({ account_id: debtor.accountId, debit: udhaarTotal, credit: 0 });
    }
    lines.push({ account_id: 'sales', debit: 0, credit: salesTotal });

    const itemLabel = items
      .filter((i) => i?.name)
      .map((i) =>
        [i.quantity != null ? `${i.quantity}${i.unit || ''}` : null, i.name]
          .filter(Boolean)
          .join(' ')
      )
      .join(', ');

    const narration =
      extraction.raw_input ||
      `Sale${itemLabel ? `: ${itemLabel}` : ''} (confirmed)`;

    const entry = await client.query(
      `insert into journal_entries
         (vendor_id, entry_date, narration, source_extraction_id, quantity)
       values ($1, current_date, $2, $3, $4)
       returning id`,
      [
        vendorId,
        narration,
        extraction.id,
        items[0]?.quantity != null ? items[0].quantity : null,
      ]
    );
    const entryId = entry.rows[0].id;

    for (const line of lines) {
      await client.query(
        `insert into journal_lines (journal_entry_id, account_id, debit, credit)
         values ($1, $2, $3, $4)`,
        [entryId, line.account_id, line.debit, line.credit]
      );
    }

    // Best-effort stock decrement for named items with quantity
    for (const item of items) {
      if (!item?.name || item.quantity == null) continue;
      const qty = Number(item.quantity);
      if (!Number.isFinite(qty) || qty === 0) continue;

      const productId = `${vendorId}:${String(item.name)
        .toLowerCase()
        .replace(/\s+/g, '_')}`;

      await client.query(
        `insert into products (id, vendor_id, product_name, stock, last_updated)
         values ($1, $2, $3, 0, now())
         on conflict (id) do nothing`,
        [productId, vendorId, item.name]
      );

      const updated = await client.query(
        `update products
            set stock = greatest(0, stock - $1), last_updated = now()
          where id = $2
          returning stock`,
        [qty, productId]
      );
      const newStock = updated.rows[0]?.stock ?? 0;

      await client.query(
        `insert into stock_ledger
           (vendor_id, product_id, change, reason, source_extraction_id, new_stock_level)
         values ($1, $2, $3, 'sale', $4, $5)`,
        [vendorId, productId, -qty, extraction.id, newStock]
      );
    }

    await client.query(
      `update raw_extractions
          set status = 'confirmed', confirmed_at = now()
        where id = $1`,
      [extraction.id]
    );

    await client.query('commit');
    return { entryId, salesTotal, cashTotal, udhaarTotal, party: debtor?.name || partyName };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  postTransaction,
  ensureDefaultAccounts,
};
