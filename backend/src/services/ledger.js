const { Pool } = require('pg');
const {
  ensureProductMaster,
  ensureSupplierParty,
  deriveQuantityAndUnit,
  getReferencePrice,
  upsertProductPrice,
  convertQuantity,
  createLegacyProductId,
} = require('./productMaster');

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

async function ensurePartyAccount(
  client,
  vendorId,
  partyName,
  partyPhone = null,
  mode = 'debtor'
) {
  const name =
    partyName && String(partyName).trim() ? String(partyName).trim() : 'Unknown';
  const isDebtor = mode !== 'creditor';
  const accountType = isDebtor ? 'asset' : 'liability';
  const prefix = isDebtor ? 'debtor' : 'creditor';
  const roleName = isDebtor ? 'Receivable' : 'Payable';
  const desiredPartyType = isDebtor ? 'customer' : 'supplier';

  const existing = await client.query(
    `select id, name, party_type from parties
      where vendor_id = $1 and lower(name) = lower($2)
      limit 1`,
    [vendorId, name]
  );

  let partyId;
  if (existing.rows[0]) {
    const row = existing.rows[0];
    partyId = row.id;
    if (
      row.party_type &&
      row.party_type !== desiredPartyType &&
      row.party_type !== 'both'
    ) {
      await client.query(
        `update parties set party_type = 'both' where id = $1`,
        [partyId]
      );
    }
    if (partyPhone) {
      await client.query(
        `update parties set phone = coalesce(phone, $2) where id = $1`,
        [partyId, partyPhone]
      );
    }
  } else {
    const inserted = await client.query(
      `insert into parties (vendor_id, name, phone, party_type)
       values ($1, $2, $3, $4)
       returning id`,
      [vendorId, name, partyPhone, desiredPartyType]
    );
    partyId = inserted.rows[0].id;
  }

  const accountId = `${prefix}_${partyId}`;
  await client.query(
    `insert into accounts (id, vendor_id, name, account_type, is_party, party_id)
     values ($1, $2, $3, $4, true, $5)
     on conflict (id) do nothing`,
    [accountId, vendorId, `${name} (${roleName})`, accountType, partyId]
  );

  return { partyId, accountId, name };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function lineAmountFromItem(item, qty) {
  const line = toNumber(item?.line_amount);
  if (line != null) return line;
  const unitPrice = toNumber(item?.unit_price);
  if (unitPrice != null && qty != null) return unitPrice * qty;
  return null;
}

async function insertAdvancedTransactionRows(
  client,
  vendorId,
  extractionId,
  parsed,
  txnType,
  party,
  transactionAmount,
  transactionProfit,
  itemFinancials
) {
  const verificationStatus = parsed?.verification?.status || 'pending';
  try {
    if (txnType === 'purchase') {
      const purchase = await client.query(
        `insert into purchase_transactions
           (vendor_id, source_extraction_id, supplier_party_id, invoice_date, total_amount, verification_status, confirmed_at)
         values ($1, $2, $3, current_date, $4, $5::verification_status_enum, now())
         returning id`,
        [vendorId, extractionId, party?.partyId || null, transactionAmount, verificationStatus]
      );
      const purchaseId = purchase.rows[0].id;
      for (const item of itemFinancials) {
        await client.query(
          `insert into purchase_items
             (purchase_transaction_id, vendor_id, product_id, product_name_raw, quantity, unit, unit_price, line_amount, verification_status, verification_notes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::verification_status_enum, $10::jsonb)`,
          [
            purchaseId,
            vendorId,
            item.productIdIsUuid ? item.productId : null,
            item.name,
            item.quantity,
            item.unit,
            item.unitPrice,
            item.detectedLineAmount,
            verificationStatus,
            JSON.stringify(item.verificationNote || {}),
          ]
        );
      }
    } else {
      const sales = await client.query(
        `insert into sales_transactions
           (vendor_id, source_extraction_id, customer_party_id, bill_date, total_amount, expected_total, difference_amount, profit, verification_status, confirmed_at)
         values ($1, $2, $3, current_date, $4, $5, $6, $7, $8::verification_status_enum, now())
         returning id`,
        [
          vendorId,
          extractionId,
          party?.partyId || null,
          transactionAmount,
          toNumber(parsed?.verification?.expected_total),
          toNumber(parsed?.verification?.difference_amount),
          transactionProfit,
          verificationStatus,
        ]
      );
      const salesId = sales.rows[0].id;
      for (const item of itemFinancials) {
        await client.query(
          `insert into sales_items
             (sales_transaction_id, vendor_id, product_id, product_name_raw, quantity, unit, unit_price, line_amount, cost_price, line_cost, line_profit, verification_status, verification_notes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::verification_status_enum, $13::jsonb)`,
          [
            salesId,
            vendorId,
            item.productIdIsUuid ? item.productId : null,
            item.name,
            item.quantity,
            item.unit,
            item.unitPrice,
            item.detectedLineAmount,
            item.referencePurchasePrice,
            item.costAmount,
            item.profitAmount,
            verificationStatus,
            JSON.stringify(item.verificationNote || {}),
          ]
        );
      }
    }
  } catch (err) {
    if (!['42P01', '42704'].includes(err?.code)) throw err;
  }
}

async function applyInventoryMovement(
  client,
  vendorId,
  extractionId,
  txnType,
  itemFinancials
) {
  for (const item of itemFinancials) {
    if (!item.productId || item.quantity == null) continue;
    const rawQty = Number(item.quantity);
    if (!Number.isFinite(rawQty) || rawQty === 0) continue;
    const signedQty = txnType === 'purchase' ? rawQty : -rawQty;

    if (item.productIdIsUuid) {
      try {
        const stockUpdate = await client.query(
          `update product_master
              set current_stock = greatest(0, current_stock + $2),
                  updated_at = now()
            where id = $1
            returning current_stock`,
          [item.productId, signedQty]
        );
        const currentStock = Number(stockUpdate.rows[0]?.current_stock || 0);

        await client.query(
          `insert into inventory
             (vendor_id, product_id, current_stock, average_cost, stock_valuation, updated_at)
           values ($1, $2, $3, $4, $5, now())
           on conflict (product_id) do update
             set current_stock = $3,
                 average_cost = coalesce(excluded.average_cost, inventory.average_cost),
                 stock_valuation = coalesce($5, inventory.stock_valuation),
                 updated_at = now()`,
          [
            vendorId,
            item.productId,
            currentStock,
            item.referencePurchasePrice,
            item.referencePurchasePrice != null
              ? currentStock * item.referencePurchasePrice
              : null,
          ]
        );

        await client.query(
          `insert into inventory_movements
             (vendor_id, product_id, movement_type, quantity, unit, converted_quantity, reference_type, reference_id, notes)
           values ($1, $2, $3, $4, $5, $4, 'raw_extraction', $6, $7)`,
          [
            vendorId,
            item.productId,
            txnType === 'purchase' ? 'purchase' : 'sale',
            signedQty,
            item.unit || 'PIECE',
            extractionId,
            txnType,
          ]
        );
      } catch (err) {
        if (!['42P01', '42704'].includes(err?.code)) throw err;
      }
    }

    const legacyId = item.productIdIsUuid
      ? createLegacyProductId(vendorId, item.normalizedName || item.name)
      : item.productId;

    await client.query(
      `insert into products (id, vendor_id, product_name, stock, last_updated)
       values ($1, $2, $3, 0, now())
       on conflict (id) do nothing`,
      [legacyId, vendorId, item.name]
    );

    const legacyUpdate = await client.query(
      `update products
          set stock = greatest(0, stock + $1),
              last_updated = now()
        where id = $2
        returning stock`,
      [signedQty, legacyId]
    );
    const legacyStock = Number(legacyUpdate.rows[0]?.stock || 0);

    await client.query(
      `insert into stock_ledger
         (vendor_id, product_id, change, reason, source_extraction_id, new_stock_level)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        vendorId,
        legacyId,
        signedQty,
        txnType === 'purchase' ? 'purchase' : 'sale',
        extractionId,
        legacyStock,
      ]
    );
  }
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

    const txnType = parsed.transaction_type || 'sale';
    const isPurchase = txnType === 'purchase';
    const applyPriceUpdate = parsed.apply_price_update === true;
    const payments = Array.isArray(parsed.payments) ? parsed.payments : [];
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const partyName = parsed.party?.name || null;
    const partyPhone = parsed.party?.phone || null;

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

    // Fallback: sum line amounts if total missing (user confirmed incomplete bill)
    if (cashTotal === 0 && udhaarTotal === 0) {
      const lineSum = items.reduce((s, i) => {
        const parsedQty = deriveQuantityAndUnit(i).quantity;
        const v = Number(lineAmountFromItem(i, parsedQty));
        return s + (Number.isFinite(v) ? v : 0);
      }, 0);
      if (lineSum > 0) cashTotal = lineSum;
    }

    const salesTotal = Number((cashTotal + udhaarTotal).toFixed(2));

    let party = null;
    // Always attach a party row (Unknown if name missing) when we have any party hint or items
    if (partyName || partyPhone || items.length || salesTotal > 0) {
      party = await ensurePartyAccount(
        client,
        vendorId,
        partyName,
        partyPhone,
        isPurchase ? 'creditor' : 'debtor'
      );
    }
    const supplierPartyId = isPurchase
      ? party?.partyId || (partyName ? await ensureSupplierParty(client, vendorId, partyName) : null)
      : null;

    const itemFinancials = [];
    for (const item of items) {
      if (!item?.name) continue;
      const { quantity, unit } = deriveQuantityAndUnit(item);
      const unitPriceFromBill = toNumber(item.unit_price);
      const detectedLineAmount = lineAmountFromItem(item, quantity);
      const master = await ensureProductMaster(client, vendorId, {
        productName: item.name,
        unit,
        supplierPartyId,
        price: unitPriceFromBill,
        priceType: isPurchase ? 'purchase' : 'selling',
        createIfMissing: true,
      });

      const productId = master?.productId || null;
      const productIdIsUuid = /^[0-9a-f-]{36}$/i.test(String(productId || ''));
      const normalizedName = master?.normalizedName || item.name.toLowerCase();

      const purchaseRef =
        productId && (await getReferencePrice(client, vendorId, productId, {
          supplierPartyId,
          priceType: 'purchase',
          unit,
        }));
      const sellingRef =
        productId && (await getReferencePrice(client, vendorId, productId, {
          supplierPartyId,
          priceType: 'selling',
          unit,
        }));

      const purchasePrice = toNumber(purchaseRef?.amount);
      const sellingPrice = toNumber(sellingRef?.amount);
      const lineRevenue =
        detectedLineAmount != null
          ? detectedLineAmount
          : quantity != null && sellingPrice != null
            ? Number((quantity * sellingPrice).toFixed(2))
            : null;

      let qtyForCost = quantity;
      if (quantity != null && unit && purchaseRef?.unit) {
        const converted = convertQuantity(quantity, unit, purchaseRef.unit);
        if (converted != null) qtyForCost = converted;
      }

      const costAmount =
        qtyForCost != null && purchasePrice != null
          ? Number((qtyForCost * purchasePrice).toFixed(2))
          : null;
      const profitAmount =
        !isPurchase && lineRevenue != null && costAmount != null
          ? Number((lineRevenue - costAmount).toFixed(2))
          : null;

      if (applyPriceUpdate && unitPriceFromBill != null && productId) {
        await upsertProductPrice(client, vendorId, productId, {
          supplierPartyId,
          priceType: isPurchase ? 'purchase' : 'selling',
          unit: unit || purchaseRef?.unit || sellingRef?.unit || 'PIECE',
          amount: unitPriceFromBill,
          reason: 'confirmed_from_whatsapp_bill',
          updatedBy: 'whatsapp_user',
        });
      }

      itemFinancials.push({
        name: item.name,
        normalizedName,
        productId,
        productIdIsUuid,
        quantity,
        unit: unit || purchaseRef?.unit || sellingRef?.unit || null,
        unitPrice: unitPriceFromBill,
        detectedLineAmount: lineRevenue,
        referencePurchasePrice: purchasePrice,
        costAmount,
        profitAmount,
        verificationNote: {
          from_verification: parsed?.verification?.status || null,
        },
      });
    }

    const computedProfit =
      isPurchase
        ? 0
        : Number(
            itemFinancials.reduce((s, i) => s + (toNumber(i.profitAmount) || 0), 0).toFixed(2)
          );

    if (salesTotal > 0) {
      if (isPurchase) {
        lines.push({ account_id: 'purchases', debit: salesTotal, credit: 0 });
        if (cashTotal > 0) {
          lines.push({ account_id: 'cash', debit: 0, credit: cashTotal });
        }
        if (udhaarTotal > 0) {
          if (!party) throw new Error('Supplier credit needs a party name');
          lines.push({
            account_id: party.accountId,
            debit: 0,
            credit: udhaarTotal,
          });
        }
      } else {
        if (cashTotal > 0) {
          lines.push({ account_id: 'cash', debit: cashTotal, credit: 0 });
        }
        if (udhaarTotal > 0) {
          if (!party) throw new Error('Udhaar amount needs a party name');
          lines.push({
            account_id: party.accountId,
            debit: udhaarTotal,
            credit: 0,
          });
        }
        lines.push({ account_id: 'sales', debit: 0, credit: salesTotal });
      }
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

    let entry;
    try {
      entry = await client.query(
        `insert into journal_entries
           (vendor_id, entry_date, narration, source_extraction_id, quantity, transaction_type, profit)
         values ($1, current_date, $2, $3, $4, $5, $6)
         returning id`,
        [
          vendorId,
          narration,
          extraction.id,
          items[0]?.quantity != null ? items[0].quantity : null,
          txnType,
          computedProfit,
        ]
      );
    } catch (err) {
      if (err?.code !== '42703') throw err;
      entry = await client.query(
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
    }
    const entryId = entry.rows[0].id;

    for (const line of lines) {
      await client.query(
        `insert into journal_lines (journal_entry_id, account_id, debit, credit)
         values ($1, $2, $3, $4)`,
        [entryId, line.account_id, line.debit, line.credit]
      );
    }

    await applyInventoryMovement(
      client,
      vendorId,
      extraction.id,
      txnType,
      itemFinancials
    );

    await insertAdvancedTransactionRows(
      client,
      vendorId,
      extraction.id,
      parsed,
      txnType,
      party,
      salesTotal,
      computedProfit,
      itemFinancials
    );

    try {
      await client.query(
        `update raw_extractions
            set status = 'confirmed',
                confirmed_at = now(),
                verification_status = coalesce($2::verification_status_enum, verification_status),
                verification_summary = coalesce($3::jsonb, verification_summary)
          where id = $1`,
        [
          extraction.id,
          parsed?.verification?.status || null,
          parsed?.verification ? JSON.stringify(parsed.verification) : null,
        ]
      );
    } catch (err) {
      if (err?.code !== '42703' && err?.code !== '42704') throw err;
      await client.query(
        `update raw_extractions
            set status = 'confirmed', confirmed_at = now()
          where id = $1`,
        [extraction.id]
      );
    }

    await client.query('commit');
    return {
      entryId,
      salesTotal,
      cashTotal,
      udhaarTotal,
      party: party?.name || partyName,
      profit: computedProfit,
    };
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
