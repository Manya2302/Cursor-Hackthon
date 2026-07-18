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
       ('expenses', $1, 'Expenses', 'expense', false),
       ('capital', $1, 'Capital', 'equity', false),
       ('drawings', $1, 'Drawings', 'equity', false)
     on conflict (id) do nothing`,
    [vendorId]
  );
}

/**
 * Look up party by (vendor_id, lower(name)); create party + debtor/creditor account if missing.
 */
async function resolveParty(vendorId, partyName, opts = {}) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');
  const client = opts.client || (await pg.connect());
  const shouldRelease = !opts.client;

  try {
    if (!opts.client) await ensureDefaultAccounts(client, vendorId);
    return await resolvePartyWithClient(client, vendorId, partyName, opts);
  } finally {
    if (shouldRelease) client.release();
  }
}

async function resolvePartyWithClient(client, vendorId, partyName, opts = {}) {
  const name =
    partyName && String(partyName).trim() ? String(partyName).trim() : 'Unknown';
  const phone = opts.phone || null;
  const asCreditor =
    opts.role === 'supplier' ||
    opts.asCreditor === true ||
    opts.accountKind === 'creditor';

  const existing = await client.query(
    `select id, name from parties
      where vendor_id = $1 and lower(name) = lower($2)
      limit 1`,
    [vendorId, name]
  );

  let partyId;
  if (existing.rows[0]) {
    partyId = existing.rows[0].id;
    if (phone) {
      await client.query(
        `update parties set phone = coalesce(phone, $2) where id = $1`,
        [partyId, phone]
      );
    }
  } else {
    const inserted = await client.query(
      `insert into parties (vendor_id, name, phone, party_type)
       values ($1, $2, $3, $4)
       returning id`,
      [vendorId, name, phone, asCreditor ? 'supplier' : 'customer']
    );
    partyId = inserted.rows[0].id;
  }

  const accountId = asCreditor ? `creditor_${partyId}` : `debtor_${partyId}`;
  const accountType = asCreditor ? 'liability' : 'asset';
  const accountName = asCreditor
    ? `${name} (Payable)`
    : `${name} (Receivable)`;

  await client.query(
    `insert into accounts (id, vendor_id, name, account_type, is_party, party_id)
     values ($1, $2, $3, $4, true, $5)
     on conflict (id) do nothing`,
    [accountId, vendorId, accountName, accountType, partyId]
  );

  return { partyId, accountId, name, kind: asCreditor ? 'creditor' : 'debtor' };
}

function paymentSplit(parsed) {
  const payments = Array.isArray(parsed.payments) ? parsed.payments : [];
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  let cashTotal = 0;
  let udhaarTotal = 0;

  for (const p of payments) {
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const method = String(p.method || '').toLowerCase();
    if (method === 'udhaar' || method === 'credit') udhaarTotal += amount;
    else cashTotal += amount;
  }

  if (cashTotal === 0 && udhaarTotal === 0 && parsed.total_amount != null) {
    const t = Number(parsed.total_amount);
    if (Number.isFinite(t) && t > 0) cashTotal = t;
  }

  if (cashTotal === 0 && udhaarTotal === 0) {
    const lineSum = items.reduce((s, i) => {
      const v = Number(i.line_amount);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
    if (lineSum > 0) cashTotal = lineSum;
  }

  return { cashTotal, udhaarTotal, total: cashTotal + udhaarTotal };
}

/**
 * Pure builder: structured extraction → balanced {account_id, debit, credit} lines.
 * Maps Phase-4 types + our transaction_type aliases.
 */
function buildJournalLines(parsedData, partyAccounts = {}) {
  const parsed = parsedData || {};
  const type = String(
    parsed.type || parsed.transaction_type || 'sale'
  ).toLowerCase();
  const { cashTotal, udhaarTotal, total } = paymentSplit(parsed);
  const debtorId = partyAccounts.debtorAccountId;
  const creditorId = partyAccounts.creditorAccountId;
  const lines = [];

  const push = (account_id, debit, credit) => {
    if (!account_id) return;
    const d = Number(debit) || 0;
    const c = Number(credit) || 0;
    if (d === 0 && c === 0) return;
    lines.push({ account_id, debit: d, credit: c });
  };

  if (type === 'sale' || type === 'transaction') {
    if (cashTotal > 0) push('cash', cashTotal, 0);
    if (udhaarTotal > 0) push(debtorId, udhaarTotal, 0);
    if (total > 0) push('sales', 0, total);
  } else if (type === 'purchase') {
    if (total > 0) push('purchases', total, 0);
    if (cashTotal > 0) push('cash', 0, cashTotal);
    if (udhaarTotal > 0) push(creditorId || debtorId, 0, udhaarTotal);
  } else if (
    type === 'payment_received' ||
    type === 'receipt' ||
    type === 'payment_received_from_debtor'
  ) {
    const amt = total > 0 ? total : Number(parsed.amount) || 0;
    push('cash', amt, 0);
    push(debtorId, 0, amt);
  } else if (type === 'borrow') {
    const amt = total > 0 ? total : Number(parsed.amount) || 0;
    push('cash', amt, 0);
    push(creditorId || debtorId, 0, amt);
  } else if (
    type === 'payment_made' ||
    type === 'payment' ||
    type === 'payment_to_creditor'
  ) {
    const amt = total > 0 ? total : Number(parsed.amount) || 0;
    push(creditorId || debtorId, amt, 0);
    push('cash', 0, amt);
  } else if (type === 'expense') {
    const amt = total > 0 ? total : Number(parsed.amount) || 0;
    push('expenses', amt, 0);
    push('cash', 0, amt);
  }

  return lines;
}

/**
 * Insert journal_entries + journal_lines in one DB transaction.
 */
async function postJournalEntry(
  vendorId,
  lines,
  narration,
  sourceExtractionId,
  opts = {}
) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('No journal lines to post');
  }

  const client = opts.client || (await pg.connect());
  const shouldRelease = !opts.client;

  try {
    if (!opts.client) await client.query('begin');
    await ensureDefaultAccounts(client, vendorId);

    const entry = await client.query(
      `insert into journal_entries
         (vendor_id, entry_date, narration, source_extraction_id, quantity)
       values ($1, current_date, $2, $3, $4)
       returning id`,
      [vendorId, narration || null, sourceExtractionId || null, opts.quantity ?? null]
    );
    const entryId = entry.rows[0].id;

    for (const line of lines) {
      await client.query(
        `insert into journal_lines (journal_entry_id, account_id, debit, credit)
         values ($1, $2, $3, $4)`,
        [entryId, line.account_id, line.debit || 0, line.credit || 0]
      );
    }

    if (!opts.client) await client.query('commit');
    return { entryId };
  } catch (err) {
    if (!opts.client) await client.query('rollback');
    if (/not balanced/i.test(err.message || '')) {
      const e = new Error('Entries not balanced');
      e.cause = err;
      throw e;
    }
    throw err;
  } finally {
    if (shouldRelease) client.release();
  }
}

/**
 * Confirm a pending transaction extraction → party + balanced journal (+ optional stock).
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

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const partyName = parsed.party?.name || null;
    const partyPhone = parsed.party?.phone || null;
    const txnType = String(parsed.transaction_type || 'sale').toLowerCase();
    const isPurchase = txnType === 'purchase';
    const { cashTotal, udhaarTotal, total: salesTotal } = paymentSplit(parsed);

    let party = null;
    if (partyName || partyPhone || items.length || salesTotal > 0) {
      party = await resolvePartyWithClient(client, vendorId, partyName, {
        phone: partyPhone,
        role: isPurchase || parsed.party?.role === 'supplier' ? 'supplier' : 'customer',
        asCreditor: isPurchase || parsed.party?.role === 'supplier',
      });
      // Also ensure debtor account for sales with udhaar when party was created as customer
      if (!isPurchase && udhaarTotal > 0 && party.kind === 'creditor') {
        party = await resolvePartyWithClient(client, vendorId, partyName, {
          phone: partyPhone,
          role: 'customer',
        });
      }
    }

    const lines = buildJournalLines(parsed, {
      debtorAccountId: party && party.kind === 'debtor' ? party.accountId : null,
      creditorAccountId:
        party && party.kind === 'creditor' ? party.accountId : null,
    });

    // If purchase with udhaar but we only have debtor id, fix lines
    if (isPurchase && udhaarTotal > 0 && party) {
      const hasCreditorLine = lines.some((l) =>
        String(l.account_id).startsWith('creditor_')
      );
      if (!hasCreditorLine && party.kind === 'debtor') {
        const creditor = await resolvePartyWithClient(client, vendorId, party.name, {
          phone: partyPhone,
          asCreditor: true,
        });
        for (const line of lines) {
          if (line.account_id === party.accountId && line.credit > 0) {
            line.account_id = creditor.accountId;
          }
        }
        party = creditor;
      }
    }

    if (!lines.length && salesTotal <= 0) {
      // Still confirm extraction with blank amounts (incomplete bill)
      await client.query(
        `update raw_extractions
            set status = 'confirmed', confirmed_at = now()
          where id = $1`,
        [extraction.id]
      );
      await client.query('commit');
      return {
        entryId: null,
        salesTotal: 0,
        cashTotal: 0,
        udhaarTotal: 0,
        party: party?.name || partyName,
      };
    }

    if (!lines.length) {
      throw new Error('Could not build journal lines from this bill');
    }

    const itemLabel = items
      .filter((i) => i?.name)
      .map((i) =>
        [i.quantity != null ? `${i.quantity}${i.unit || ''}` : null, i.name]
          .filter(Boolean)
          .join(' ')
      )
      .join(', ');

    const narration =
      (extraction.raw_input && String(extraction.raw_input).slice(0, 500)) ||
      `${isPurchase ? 'Purchase' : 'Sale'}${itemLabel ? `: ${itemLabel}` : ''} (confirmed)`;

    const { entryId } = await postJournalEntry(
      vendorId,
      lines,
      narration,
      extraction.id,
      {
        client,
        quantity: items[0]?.quantity != null ? items[0].quantity : null,
      }
    );

    // Best-effort stock decrement for sale line items
    if (!isPurchase) {
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
    }

    await client.query(
      `update raw_extractions
          set status = 'confirmed', confirmed_at = now()
        where id = $1`,
      [extraction.id]
    );

    await client.query('commit');
    return {
      entryId,
      salesTotal,
      cashTotal,
      udhaarTotal,
      party: party?.name || partyName,
    };
  } catch (err) {
    await client.query('rollback');
    if (/not balanced/i.test(err.message || '')) {
      throw new Error('Entries not balanced');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Undo last confirmed journal within 2 minutes (Phase 4).
 */
async function undoLastPost(vendorId) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const client = await pg.connect();
  try {
    await client.query('begin');

    const extraction = await client.query(
      `select id, confirmed_at
         from raw_extractions
        where vendor_id = $1 and status = 'confirmed' and confirmed_at is not null
        order by confirmed_at desc
        limit 1`,
      [vendorId]
    );
    const row = extraction.rows[0];
    if (!row) {
      throw new Error('Nothing to undo');
    }

    const ageMs = Date.now() - new Date(row.confirmed_at).getTime();
    if (ageMs > 2 * 60 * 1000) {
      throw new Error('Undo window expired (only within 2 minutes)');
    }

    // Revert stock_ledger rows for this extraction
    const stockRows = await client.query(
      `select id, product_id, change, new_stock_level
         from stock_ledger
        where vendor_id = $1 and source_extraction_id = $2`,
      [vendorId, row.id]
    );
    for (const s of stockRows.rows) {
      // Reverse the stock change
      await client.query(
        `update products
            set stock = greatest(0, stock - $1), last_updated = now()
          where id = $2`,
        [s.change, s.product_id]
      );
      await client.query(`delete from stock_ledger where id = $1`, [s.id]);
    }

    await client.query(
      `delete from journal_entries
        where vendor_id = $1 and source_extraction_id = $2`,
      [vendorId, row.id]
    );

    await client.query(
      `update raw_extractions
          set status = 'rejected', confirmed_at = null
        where id = $1`,
      [row.id]
    );

    await client.query('commit');
    return { extractionId: row.id };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  resolveParty,
  resolvePartyWithClient,
  buildJournalLines,
  postJournalEntry,
  postTransaction,
  undoLastPost,
  ensureDefaultAccounts,
  paymentSplit,
  getPool,
};
