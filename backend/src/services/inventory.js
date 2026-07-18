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

function productIdFor(vendorId, name) {
  return `${vendorId}:${String(name).toLowerCase().replace(/\s+/g, '_')}`;
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
    rows.push({
      name: p.name,
      stock: p.stock != null ? Number(p.stock) : null,
      price: p.price != null ? Number(p.price) : null,
      category: p.category || null,
      supplier: parsed.party?.name || null,
    });
  }

  // Fallback: bill/stock sheet lines often land in items[]
  if (rows.length === 0 && Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      if (!item?.name) continue;
      rows.push({
        name: item.name,
        stock: item.quantity != null ? Number(item.quantity) : null,
        price:
          item.line_amount != null
            ? Number(item.line_amount)
            : item.unit_price != null
              ? Number(item.unit_price)
              : null,
        category: item.unit || item.weight_text || null,
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

  const client = await pg.connect();
  const saved = [];

  try {
    await client.query('begin');

    for (const row of rows) {
      const id = productIdFor(vendorId, row.name);
      const stock = Number.isFinite(row.stock) ? row.stock : 0;
      const price = Number.isFinite(row.price) ? row.price : 0;

      const existing = await client.query(
        `select id, stock from products where id = $1`,
        [id]
      );

      let newStock;
      if (existing.rows[0]) {
        // Add incoming stock onto existing level when quantity is provided
        newStock =
          row.stock != null
            ? Number(existing.rows[0].stock) + stock
            : Number(existing.rows[0].stock);

        await client.query(
          `update products
              set product_name = $2,
                  stock = $3,
                  price = case when $4 > 0 then $4 else price end,
                  category = coalesce($5, category),
                  supplier = coalesce($6, supplier),
                  last_updated = now()
            where id = $1`,
          [id, row.name, newStock, price, row.category, row.supplier]
        );
      } else {
        newStock = stock;
        await client.query(
          `insert into products
             (id, vendor_id, product_name, category, stock, price, supplier, last_updated)
           values ($1, $2, $3, $4, $5, $6, $7, now())`,
          [id, vendorId, row.name, row.category, stock, price, row.supplier]
        );
      }

      if (row.stock != null && Number(row.stock) !== 0) {
        await client.query(
          `insert into stock_ledger
             (vendor_id, product_id, change, reason, source_extraction_id, new_stock_level)
           values ($1, $2, $3, 'bulk_upload', $4, $5)`,
          [vendorId, id, stock, extraction.id, newStock]
        );
      }

      saved.push({
        name: row.name,
        stock: newStock,
        price,
        supplier: row.supplier,
      });
    }

    await client.query(
      `update raw_extractions
          set status = 'confirmed', confirmed_at = now()
        where id = $1`,
      [extraction.id]
    );

    await client.query('commit');
    return { count: saved.length, products: saved };
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
