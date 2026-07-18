const { Pool } = require('pg');
const { upsertProducts } = require('./inventoryUpsert');

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
  // Structured Phase 5 bulk import
  if (Array.isArray(parsed.bulk_rows) && parsed.bulk_rows.length) {
    return parsed.bulk_rows.map((r) => ({
      productId: r.productId || r.id,
      name: r.name || r.product_name,
      stock: r.stock != null ? Number(r.stock) : null,
      price: r.price != null ? Number(r.price) : null,
      category: r.category || null,
      supplier: r.supplier || null,
    }));
  }

  const rows = [];
  const updates = Array.isArray(parsed.product_updates)
    ? parsed.product_updates
    : [];
  for (const p of updates) {
    if (!p?.name && !p?.productId) continue;
    rows.push({
      productId: p.productId || p.id || null,
      name: p.name,
      stock: p.stock != null ? Number(p.stock) : null,
      price: p.price != null ? Number(p.price) : null,
      category: p.category || null,
      supplier: p.supplier || parsed.party?.name || null,
    });
  }

  // Fallback: bill/stock sheet lines often land in items[]
  if (rows.length === 0 && Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      if (!item?.name) continue;
      rows.push({
        productId: item.productId || item.id || null,
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
 * Uses Phase 5 semantics: set absolute stock; ledger only on change; no ledger for brand-new.
 */
async function postInventory(vendorId, extraction) {
  const parsed =
    typeof extraction.llm_parsed === 'string'
      ? JSON.parse(extraction.llm_parsed)
      : extraction.llm_parsed;

  const rows = collectProductRows(parsed);
  if (!rows.length) {
    throw new Error('No products found to save');
  }

  const validRows = rows
    .map((row) => {
      const productId =
        (row.productId && String(row.productId).trim()) ||
        productIdFor(vendorId, row.name);
      const stock = Number.isFinite(Number(row.stock)) ? Number(row.stock) : 0;
      const price = Number.isFinite(Number(row.price)) ? Number(row.price) : 0;
      return {
        productId,
        name: row.name || productId,
        category: row.category || null,
        stock,
        price,
        supplier: row.supplier || null,
      };
    })
    .filter((r) => r.productId && r.name);

  if (!validRows.length) {
    throw new Error('No valid products found to save');
  }

  return upsertProducts(vendorId, validRows, extraction.id);
}

/**
 * Low-stock digest for WhatsApp / cron / GET /api/inventory/:vendorId/low-stock
 */
async function generateLowStockDigest(vendorId) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const result = await pg.query(
    `select id, product_name, stock, low_stock_threshold, supplier, price
       from products
      where vendor_id = $1 and stock <= low_stock_threshold
      order by stock asc, product_name asc`,
    [vendorId]
  );

  const items = result.rows;
  if (!items.length) {
    return {
      vendorId,
      count: 0,
      items: [],
      message: '✅ All products are above their low-stock threshold.',
    };
  }

  const lines = items.map(
    (p, i) =>
      `${i + 1}. *${p.product_name}* — stock ${p.stock} (threshold ${p.low_stock_threshold})` +
      (p.supplier ? ` · ${p.supplier}` : '')
  );

  const message =
    `⚠️ *Low stock alert* (${items.length})\n\n` + lines.join('\n');

  return { vendorId, count: items.length, items, message };
}

module.exports = {
  postInventory,
  collectProductRows,
  generateLowStockDigest,
  productIdFor,
};
