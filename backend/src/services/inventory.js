const { Pool } = require('pg');
const {
  ensureProductMaster,
  ensureSupplierParty,
  upsertProductPrice,
  deriveQuantityAndUnit,
  normalizeUnit,
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

function productIdFor(vendorId, name) {
  return createLegacyProductId(
    vendorId,
    String(name).toLowerCase().trim().replace(/\s+/g, ' ')
  );
}

/**
 * Normalize product rows from either product_updates or items[].
 */
function collectProductRows(parsed) {
  const rows = [];
  const updates = Array.isArray(parsed.product_updates)
    ? parsed.product_updates
    : [];
  for (const p of updates) {
    if (!p?.name) continue;
    const pStock = Number(p.stock);
    const pPrice = Number(p.price);
    rows.push({
      name: p.name,
      stock: Number.isFinite(pStock) ? pStock : null,
      price: Number.isFinite(pPrice) ? pPrice : null,
      unit: normalizeUnit(p.unit || p.category),
      category: p.category || null,
      supplier: parsed.party?.name || null,
    });
  }

  // Fallback: bill/stock sheet lines often land in items[]
  if (rows.length === 0 && Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      if (!item?.name) continue;
      const { quantity, unit } = deriveQuantityAndUnit(item);
      const directPrice = Number(item.unit_price);
      const lineAmount = Number(item.line_amount);
      let perUnitPrice = null;
      if (Number.isFinite(directPrice)) perUnitPrice = directPrice;
      else if (
        Number.isFinite(lineAmount) &&
        Number.isFinite(quantity) &&
        Number(quantity) > 0
      ) {
        perUnitPrice = Number((lineAmount / Number(quantity)).toFixed(2));
      }

      rows.push({
        name: item.name,
        stock: quantity != null ? Number(quantity) : null,
        price: perUnitPrice,
        unit,
        category: unit || item.weight_text || null,
        supplier: parsed.party?.name || null,
      });
    }
  }

  return rows;
}

/**
 * Upsert products from a confirmed inventory/supplier extraction.
 */
async function postInventory(vendorId, extraction) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const parsed =
    typeof extraction.llm_parsed === 'string'
      ? JSON.parse(extraction.llm_parsed)
      : extraction.llm_parsed;

  const rows = collectProductRows(parsed);
  if (!rows.length) {
    throw new Error('No products found to save');
  }
  const applyPriceUpdate = parsed.apply_price_update !== false;

  const client = await pg.connect();
  const saved = [];
  let newProducts = 0;

  try {
    await client.query('begin');
    const supplierPartyId = parsed.party?.name
      ? await ensureSupplierParty(client, vendorId, parsed.party.name)
      : null;

    for (const row of rows) {
      const stock = Number.isFinite(row.stock) ? row.stock : 0;
      const price = Number.isFinite(row.price) ? Number(row.price) : null;
      const baseUnit = row.unit || 'PIECE';

      const master = await ensureProductMaster(client, vendorId, {
        productName: row.name,
        unit: baseUnit,
        supplierPartyId,
        categoryName: row.category,
        price,
        priceType: 'purchase',
        createIfMissing: true,
      });
      if (master?.created) newProducts += 1;

      if (applyPriceUpdate && price != null && master?.productId) {
        await upsertProductPrice(client, vendorId, master.productId, {
          supplierPartyId,
          priceType: 'purchase',
          unit: baseUnit,
          amount: price,
          reason: 'inventory_bulk_confirmation',
          updatedBy: 'whatsapp_user',
        });
      }

      const legacyId = master?.legacy
        ? master.productId
        : productIdFor(vendorId, master?.normalizedName || row.name);
      const legacy = await client.query(
        `select id, stock from products where id = $1`,
        [legacyId]
      );
      const oldStock = Number(legacy.rows[0]?.stock || 0);
      const nextStock = row.stock != null ? oldStock + stock : oldStock;
      await client.query(
        `insert into products
           (id, vendor_id, product_name, category, stock, price, supplier, last_updated)
         values ($1, $2, $3, $4, $5, coalesce($6, 0), $7, now())
         on conflict (id) do update
           set product_name = excluded.product_name,
               category = coalesce(excluded.category, products.category),
               stock = $8,
               price = case when $6 is not null and $6 > 0 then $6 else products.price end,
               supplier = coalesce(excluded.supplier, products.supplier),
               last_updated = now()`,
        [
          legacyId,
          vendorId,
          row.name,
          row.category,
          nextStock,
          price,
          row.supplier,
          nextStock,
        ]
      );

      if (master && !master.legacy && row.stock != null && stock !== 0) {
        await client.query(
          `update product_master
              set current_stock = current_stock + $2,
                  updated_at = now()
            where id = $1`,
          [master.productId, stock]
        );
        try {
          await client.query(
            `insert into inventory (vendor_id, product_id, current_stock, average_cost, stock_valuation, updated_at)
             values ($1, $2, $3, $4, $5, now())
             on conflict (product_id) do update
               set current_stock = inventory.current_stock + excluded.current_stock,
                   average_cost = coalesce(excluded.average_cost, inventory.average_cost),
                   stock_valuation = coalesce(inventory.stock_valuation, 0) + (excluded.current_stock * coalesce(excluded.average_cost, 0)),
                   updated_at = now()`,
            [vendorId, master.productId, stock, price, price != null ? stock * price : null]
          );
        } catch (err) {
          if (err?.code !== '42P01') throw err;
        }
      }

      if (master && !master.legacy && supplierPartyId) {
        try {
          await client.query(
            `insert into supplier_products
               (vendor_id, supplier_party_id, product_id, supplier_product_name, last_purchase_price, last_purchase_date, is_preferred)
             values ($1, $2, $3, $4, $5, current_date, true)
             on conflict (vendor_id, supplier_party_id, product_id) do update
               set supplier_product_name = coalesce(excluded.supplier_product_name, supplier_products.supplier_product_name),
                   last_purchase_price = coalesce(excluded.last_purchase_price, supplier_products.last_purchase_price),
                   last_purchase_date = current_date,
                   is_preferred = true,
                   updated_at = now()`,
            [vendorId, supplierPartyId, master.productId, row.name, price]
          );
        } catch (err) {
          if (err?.code !== '42P01') throw err;
        }
      }

      if (row.stock != null && Number(row.stock) !== 0) {
        await client.query(
          `insert into stock_ledger
             (vendor_id, product_id, change, reason, source_extraction_id, new_stock_level)
           values ($1, $2, $3, 'bulk_upload', $4, $5)`,
          [vendorId, legacyId, stock, extraction.id, nextStock]
        );
        if (master && !master.legacy) {
          try {
            await client.query(
              `insert into inventory_movements
                 (vendor_id, product_id, movement_type, quantity, unit, converted_quantity, reference_type, reference_id, notes)
               values ($1, $2, 'purchase', $3, $4, $3, 'raw_extraction', $5, $6)`,
              [vendorId, master.productId, stock, baseUnit, extraction.id, 'inventory_bulk']
            );
          } catch (err) {
            if (err?.code !== '42P01') throw err;
          }
        }
      }

      saved.push({
        name: row.name,
        stock: nextStock,
        price,
        supplier: row.supplier,
        unit: baseUnit,
        productId: master?.productId || legacyId,
      });
    }

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
    return { count: saved.length, products: saved, newProducts };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  postInventory,
  collectProductRows,
};
