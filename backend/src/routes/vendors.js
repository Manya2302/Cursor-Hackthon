const express = require('express');
const { resolveOrCreateVendor } = require('../services/vendors');
const { Pool } = require('pg');

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
 * GET /api/vendors/lookup?phone=91xxxxxxxxxx
 * Used by the frontend dashboard to resolve vendorId from login phone.
 */
router.get('/api/vendors/lookup', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const pg = getPool();
    if (!pg) return res.status(503).json({ error: 'Database not configured' });

    const result = await pg.query(
      `select id, phone, name, preferred_language, created_at
         from vendors
        where phone = $1 or phone = $2 or right(phone, 10) = right($1, 10)
        order by created_at asc
        limit 1`,
      [phone, phone.length === 10 ? `91${phone}` : phone.replace(/^91/, '')]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Vendor not found. Message the WhatsApp bot once first.' });
    }
    res.json({ vendor: result.rows[0] });
  } catch (err) {
    console.error('[vendors] lookup failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/vendors/ensure — create/resolve vendor for dashboard demos
 */
router.post('/api/vendors/ensure', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    const name = req.body?.name || phone;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const vendor = await resolveOrCreateVendor(phone, name);
    if (!vendor) return res.status(503).json({ error: 'Could not create vendor' });
    res.json({ vendor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
