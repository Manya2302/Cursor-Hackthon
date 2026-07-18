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

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Keep Product Master in sync when legacy `products` rows are bulk-upserted.
 */
async function syncProductMaster(client, vendorId, legacyId, row) {
  const name = String(row.name || row.product_name || legacyId).trim();
  const norm = normalizeName(name);
  if (!norm) return null;

  const stock = Number.isFinite(Number(row.stock)) ? Number(row.stock) : 0;
  const price = Number.isFinite(Number(row.price)) ? Number(row.price) : 0;
  const category = row.category || null;
  const supplier = row.supplier || null;

  const existing = await client.query(
    `select id from product_master
      where vendor_id = $1 and normalized_name = $2
      limit 1`,
    [vendorId, norm]
  );

  let masterId;
  if (existing.rows[0]) {
    masterId = existing.rows[0].id;
    await client.query(
      `update product_master
          set product_name = $3,
              category = coalesce($4, category),
              selling_price = case when $5::numeric > 0 then $5 else selling_price end,
              current_stock = $6,
              supplier = coalesce($7, supplier),
              updated_at = now()
        where id = $1 and vendor_id = $2`,
      [masterId, vendorId, name, category, price, stock, supplier]
    );
  } else {
    const ins = await client.query(
      `insert into product_master
         (vendor_id, product_name, normalized_name, category, selling_price,
          purchase_price, unit, current_stock, supplier)
       values ($1,$2,$3,$4,$5,0,'PCS',$6,$7)
       returning id`,
      [vendorId, name, norm, category, price, stock, supplier]
    );
    masterId = ins.rows[0].id;
    await client.query(
      `insert into product_aliases (vendor_id, product_id, alias, alias_normalized)
       values ($1,$2,$3,$4)
       on conflict (vendor_id, alias_normalized) do nothing`,
      [vendorId, masterId, name, norm]
    );
  }

  await client.query(
    `update products set master_product_id = $3, last_updated = now()
      where vendor_id = $1 and id = $2`,
    [vendorId, legacyId, masterId]
  );

  return masterId;
}

/**
 * Upsert products by (vendor_id, id).
 * - Existing product: set stock to new absolute value; if stock changed,
 *   insert stock_ledger with reason 'bulk_upload' and the delta.
 * - Brand-new product: insert only (no stock_ledger — nothing to change).
 */
async function upsertProducts(vendorId, validRows, sourceExtractionId) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');
  if (!Array.isArray(validRows) || validRows.length === 0) {
    throw new Error('No valid products to upsert');
  }

  const client = await pg.connect();
  const saved = [];
  let created = 0;
  let updated = 0;
  let stockChanges = 0;

  try {
    await client.query('begin');

    for (const row of validRows) {
      const id = String(row.productId || row.id || '').trim();
      if (!id) continue;

      const name = String(row.name || row.product_name || id).trim();
      const stock = Number(row.stock);
      const price = Number(row.price);
      const category = row.category || null;
      const supplier = row.supplier || null;

      const existing = await client.query(
        `select id, stock, product_name, price
           from products
          where vendor_id = $1 and id = $2`,
        [vendorId, id]
      );

      if (existing.rows[0]) {
        const oldStock = Number(existing.rows[0].stock);
        const newStock = Number.isFinite(stock) ? stock : oldStock;
        const delta = newStock - oldStock;

        await client.query(
          `update products
              set product_name = $3,
                  category = coalesce($4, category),
                  stock = $5,
                  price = case when $6::numeric is not null then $6 else price end,
                  supplier = coalesce($7, supplier),
                  last_updated = now()
            where vendor_id = $1 and id = $2`,
          [
            vendorId,
            id,
            name,
            category,
            newStock,
            Number.isFinite(price) ? price : null,
            supplier,
          ]
        );

        if (delta !== 0) {
          await client.query(
            `insert into stock_ledger
               (vendor_id, product_id, change, reason, source_extraction_id, new_stock_level)
             values ($1, $2, $3, 'bulk_upload', $4, $5)`,
            [vendorId, id, delta, sourceExtractionId || null, newStock]
          );
          stockChanges += 1;
        }

        await syncProductMaster(client, vendorId, id, {
          name,
          stock: newStock,
          price: Number.isFinite(price) ? price : Number(existing.rows[0].price),
          category,
          supplier,
        });

        updated += 1;
        saved.push({
          id,
          name,
          stock: newStock,
          price: Number.isFinite(price) ? price : Number(existing.rows[0].price),
          supplier,
          isNew: false,
          stockDelta: delta,
        });
      } else {
        const newStock = Number.isFinite(stock) ? stock : 0;
        const newPrice = Number.isFinite(price) ? price : 0;

        await client.query(
          `insert into products
             (id, vendor_id, product_name, category, stock, price, supplier, last_updated)
           values ($1, $2, $3, $4, $5, $6, $7, now())`,
          [id, vendorId, name, category, newStock, newPrice, supplier]
        );

        await syncProductMaster(client, vendorId, id, {
          name,
          stock: newStock,
          price: newPrice,
          category,
          supplier,
        });

        // Brand-new product: no stock_ledger entry (no prior change to log)
        created += 1;
        saved.push({
          id,
          name,
          stock: newStock,
          price: newPrice,
          supplier,
          isNew: true,
          stockDelta: 0,
        });
      }
    }

    if (sourceExtractionId) {
      await client.query(
        `update raw_extractions
            set status = 'confirmed', confirmed_at = now()
          where id = $1`,
        [sourceExtractionId]
      );
    }

    await client.query('commit');
    return {
      count: saved.length,
      created,
      updated,
      stockChanges,
      products: saved,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Count how many of the valid rows already exist for this vendor (for pre-confirm summary).
 */
async function previewBulkChanges(vendorId, validRows) {
  const pg = getPool();
  if (!pg || !validRows?.length) {
    return { newCount: validRows?.length || 0, updateCount: 0 };
  }

  const ids = validRows.map((r) => String(r.productId).trim()).filter(Boolean);
  if (!ids.length) return { newCount: 0, updateCount: 0 };

  const result = await pg.query(
    `select id from products where vendor_id = $1 and id = any($2::text[])`,
    [vendorId, ids]
  );
  const existing = new Set(result.rows.map((r) => r.id));
  let updateCount = 0;
  let newCount = 0;
  for (const id of ids) {
    if (existing.has(id)) updateCount += 1;
    else newCount += 1;
  }
  return { newCount, updateCount };
}

module.exports = {
  upsertProducts,
  previewBulkChanges,
};
