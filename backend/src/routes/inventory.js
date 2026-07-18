const express = require('express');
const { Pool } = require('pg');
const { upsertProducts } = require('../services/inventoryUpsert');
const { validateRows } = require('../services/inventoryImport');
const { generateLowStockDigest } = require('../services/inventory');

const router = express.Router();

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
 * GET /api/inventory/:vendorId
 * List products + computed low_stock boolean.
 */
router.get('/api/inventory/:vendorId', async (req, res) => {
  const pg = getPool();
  if (!pg) return res.status(503).json({ error: 'Database not configured' });

  const { vendorId } = req.params;
  try {
    const result = await pg.query(
      `select
         id,
         product_name,
         category,
         stock,
         price,
         supplier,
         low_stock_threshold,
         last_updated,
         (stock <= low_stock_threshold) as low_stock
       from products
      where vendor_id = $1
      order by product_name asc`,
      [vendorId]
    );
    res.json({ vendorId, products: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[inventory] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/inventory/:vendorId/low-stock
 * WhatsApp-ready low-stock digest for testing.
 */
router.get('/api/inventory/:vendorId/low-stock', async (req, res) => {
  try {
    const digest = await generateLowStockDigest(req.params.vendorId);
    res.json(digest);
  } catch (err) {
    console.error('[inventory] low-stock failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/inventory/:vendorId/bulk
 * Body: { rows: [...], sourceExtractionId?: uuid }
 * or a raw array of rows.
 */
router.post('/api/inventory/:vendorId/bulk', async (req, res) => {
  const { vendorId } = req.params;
  const body = req.body;
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.rows)
      ? body.rows
      : Array.isArray(body?.products)
        ? body.products
        : null;

  if (!rows) {
    return res.status(400).json({
      error:
        'Body must be an array or { rows: [{ productId, name, category, stock, price, supplier }] }',
    });
  }

  const { validRows, invalidRows } = validateRows(rows);
  if (!validRows.length) {
    return res.status(400).json({
      error: 'No valid rows',
      invalidRows,
    });
  }

  try {
    const result = await upsertProducts(
      vendorId,
      validRows,
      body?.sourceExtractionId || null
    );
    res.json({
      ...result,
      invalidRows,
    });
  } catch (err) {
    console.error('[inventory] bulk failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
