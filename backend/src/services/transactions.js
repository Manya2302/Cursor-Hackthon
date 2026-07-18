const { Pool } = require('pg');
const {
  findByAlias,
  updatePrices,
  adjustStock,
  createProduct,
} = require('./productMaster');
const { resolveVerification } = require('./priceVerify');
const {
  parseQtyUnit,
  qtyInMasterUnit,
  roundMoney,
  normalizeUnit,
} = require('../utils/units');
const {
  ensureDefaultAccounts,
  resolvePartyWithClient,
  postJournalEntry,
} = require('./ledger');

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

/**
 * After merchant YES on a verified sale bill:
 * - optional master price updates
 * - sales_transactions + items + profit
 * - journal entry
 * - stock decrement
 */
async function postVerifiedSale(vendorId, extraction, report, opts = {}) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const parsed =
    typeof extraction.llm_parsed === 'string'
      ? JSON.parse(extraction.llm_parsed)
      : extraction.llm_parsed || {};

  const partyInfo = parsed.party || {};
  const verificationId = parsed.verification_id || opts.verificationId || null;
  const updateMasterPrices = opts.updateMasterPrices === true;

  const client = await pg.connect();
  try {
    await client.query('begin');
    await ensureDefaultAccounts(client, vendorId);

    const party = await resolvePartyWithClient(
      client,
      vendorId,
      partyInfo.name || 'Customer',
      { phone: partyInfo.phone, role: 'customer' }
    );

    if (updateMasterPrices) {
      for (const line of report.lines || []) {
        if (!line.product_id || line.ocr_unit_price == null) continue;
        await updatePrices(
          vendorId,
          line.product_id,
          { selling_price: line.ocr_unit_price },
          {
            reason: 'accepted_from_bill',
            sourceExtractionId: extraction.id,
          }
        );
      }
    }

    let gross = 0;
    let cost = 0;
    const itemRows = [];

    for (const line of report.lines || []) {
      if (line.status === 'unknown_product') continue;
      let productId = line.product_id;
      if (!productId && line.raw_name) {
        const found = await findByAlias(vendorId, line.raw_name);
        productId = found?.id;
      }
      if (!productId) continue;

      const prod = (
        await client.query(`select * from product_master where id = $1`, [
          productId,
        ])
      ).rows[0];
      if (!prod) continue;

      const qtyParsed = parseQtyUnit(
        line.quantity,
        line.unit,
        line.weight_text || line.pack_text
      );
      let quantity = qtyParsed.quantity;
      let unit = qtyParsed.unit;
      // Bill rows often use a plain count with unit PCS even when master is KG/L.
      // Treat that count as master-unit quantity so stock actually moves.
      if (
        quantity != null &&
        (!unit || unit === 'PCS') &&
        prod.unit &&
        prod.unit !== 'PCS' &&
        !line.pack_text &&
        !/\d+\s*(kg|gm|g|ml|l)\b/i.test(String(line.weight_text || ''))
      ) {
        unit = prod.unit;
      }
      const qtyM =
        qtyInMasterUnit(quantity, unit || prod.unit, prod.unit) ??
        (Number.isFinite(Number(quantity)) ? Number(quantity) : 0);
      const lineAmount =
        line.ocr_line_amount != null
          ? roundMoney(line.ocr_line_amount)
          : line.expected_line != null
            ? roundMoney(line.expected_line)
            : 0;
      const costPrice = Number(prod.purchase_price) || 0;
      const lineCost = roundMoney(qtyM * costPrice);
      const lineProfit = roundMoney(lineAmount - lineCost);

      gross = roundMoney(gross + lineAmount);
      cost = roundMoney(cost + lineCost);

      itemRows.push({
        productId,
        productName: prod.product_name,
        quantity: quantity || qtyM,
        unit: unit || prod.unit,
        unitPrice:
          line.ocr_unit_price != null
            ? line.ocr_unit_price
            : Number(prod.selling_price),
        lineAmount,
        costPrice,
        lineProfit,
        qtyM,
      });
    }

    // Fallback: if report empty, use parsed.items
    if (!itemRows.length && Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        if (!item?.name) continue;
        const found = await findByAlias(vendorId, item.name);
        if (!found) continue;
        const { quantity, unit } = parseQtyUnit(
          item.quantity,
          item.unit,
          item.weight_text
        );
        const qtyM =
          qtyInMasterUnit(quantity, unit || found.unit, found.unit) || 0;
        const lineAmount =
          item.line_amount != null
            ? roundMoney(item.line_amount)
            : roundMoney(Number(found.selling_price) * (qtyM || 0));
        const costPrice = Number(found.purchase_price) || 0;
        const lineCost = roundMoney(qtyM * costPrice);
        const lineProfit = roundMoney(lineAmount - lineCost);
        gross = roundMoney(gross + lineAmount);
        cost = roundMoney(cost + lineCost);
        itemRows.push({
          productId: found.id,
          productName: found.product_name,
          quantity: quantity || qtyM,
          unit: unit || found.unit,
          unitPrice: Number(found.selling_price),
          lineAmount,
          costPrice,
          lineProfit,
          qtyM,
        });
      }
    }

    const profit = roundMoney(gross - cost);
    const entryDate = new Date().toISOString().slice(0, 10);

    const st = await client.query(
      `insert into sales_transactions
         (vendor_id, party_id, extraction_id, verification_id, entry_date,
          gross_amount, cost_amount, profit, notes)
       values ($1,$2,$3,$4,$5::date,$6,$7,$8,$9)
       returning *`,
      [
        vendorId,
        party.partyId,
        extraction.id,
        verificationId,
        entryDate,
        gross,
        cost,
        profit,
        updateMasterPrices ? 'master prices updated from bill' : null,
      ]
    );
    const salesTxn = st.rows[0];

    for (const row of itemRows) {
      await client.query(
        `insert into sales_items
           (sales_transaction_id, product_id, product_name, quantity, unit,
            unit_price, line_amount, cost_price, line_profit)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          salesTxn.id,
          row.productId,
          row.productName,
          row.quantity,
          row.unit,
          row.unitPrice,
          row.lineAmount,
          row.costPrice,
          row.lineProfit,
        ]
      );
      await adjustStock(
        client,
        vendorId,
        row.productId,
        -Math.abs(row.qtyM || row.quantity || 0),
        'sale',
        extraction.id
      );
    }

    // Journal: Dr Cash/Debtor, Cr Sales
    const lines = [];
    if (gross > 0) {
      lines.push({ account_id: 'sales', debit: 0, credit: gross });
      // Prefer cash if no clear udhaar; else debtor
      const useUdhaar = /udhaar|credit/i.test(JSON.stringify(parsed.payments || []));
      if (useUdhaar && party.accountId) {
        lines.push({ account_id: party.accountId, debit: gross, credit: 0 });
      } else {
        lines.push({ account_id: 'cash', debit: gross, credit: 0 });
      }
    }

    let journalId = null;
    if (lines.length) {
      const je = await postJournalEntry(
        vendorId,
        lines,
        `Sale — ${partyInfo.name || 'Customer'} (profit ₹${profit})`,
        extraction.id,
        { client }
      );
      journalId = je.entryId;
      await client.query(
        `update sales_transactions set journal_entry_id = $2 where id = $1`,
        [salesTxn.id, journalId]
      );
      await client.query(
        `update journal_entries
            set sales_transaction_id = $2, profit = $3
          where id = $1`,
        [journalId, salesTxn.id, profit]
      );
    }

    await client.query(
      `update raw_extractions
          set status = 'confirmed', confirmed_at = now()
        where id = $1`,
      [extraction.id]
    );

    await client.query('commit');

    if (verificationId) {
      await resolveVerification(
        verificationId,
        updateMasterPrices ? 'price_updated' : 'verified',
        { sales_transaction_id: salesTxn.id, profit }
      );
    }

    return {
      salesTransactionId: salesTxn.id,
      journalEntryId: journalId,
      gross,
      cost,
      profit,
      itemCount: itemRows.length,
      party: partyInfo.name || null,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Add all unknown products from a verification report into Product Master.
 */
async function addUnknownProductsFromReport(vendorId, report, extractionId) {
  const created = [];
  for (const line of report.lines || []) {
    if (line.status !== 'unknown_product' || !line.raw_name) continue;
    const selling =
      line.ocr_unit_price != null
        ? line.ocr_unit_price
        : line.ocr_line_amount != null && line.quantity
          ? roundMoney(line.ocr_line_amount / line.quantity)
          : 0;
    // Prefer a real master unit when OCR left PCS on a dairy/grain item
    let unit = normalizeUnit(line.unit) || 'KG';
    const nameLower = String(line.raw_name || '').toLowerCase();
    if (unit === 'PCS') {
      if (/milk|દૂધ|oil|તેલ/.test(nameLower)) unit = 'L';
      else unit = 'KG';
    }
    const result = await createProduct(vendorId, {
      name: line.base_name || line.raw_name,
      selling_price: selling,
      purchase_price: report.kind === 'purchase' ? selling : 0,
      unit,
      stock: 0,
    });
    created.push(result.product);
  }
  return created;
}

async function getProfitDigest(vendorId, datePhrase = 'today') {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const { resolveDatePhrase } = require('./dateResolver');
  const range = resolveDatePhrase(
    datePhrase === 'today' ? 'today' : datePhrase,
    new Date()
  );

  const r = await pg.query(
    `select
       count(*)::int as sales_count,
       coalesce(sum(gross_amount),0) as gross_amount,
       coalesce(sum(cost_amount),0) as cost_amount,
       coalesce(sum(profit),0) as profit
     from sales_transactions
    where vendor_id = $1
      and entry_date between $2::date and $3::date`,
    [vendorId, range.startDate, range.endDate]
  );

  const row = r.rows[0];
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    sales_count: row.sales_count,
    gross_amount: roundMoney(row.gross_amount),
    cost_amount: roundMoney(row.cost_amount),
    profit: roundMoney(row.profit),
    message:
      `💰 *Profit ${range.startDate === range.endDate ? range.startDate : `${range.startDate} → ${range.endDate}`}*\n` +
      `Sales: ${row.sales_count}\n` +
      `Gross: ₹${roundMoney(row.gross_amount)}\n` +
      `Cost: ₹${roundMoney(row.cost_amount)}\n` +
      `Profit: *₹${roundMoney(row.profit)}*` +
      (Number(row.profit) < 0 ? ' (loss)' : ''),
  };
}

module.exports = {
  postVerifiedSale,
  addUnknownProductsFromReport,
  getProfitDigest,
};
