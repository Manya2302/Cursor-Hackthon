const express = require('express');
const { listProducts } = require('../services/productMaster');
const { getProfitDigest } = require('../services/transactions');

const router = express.Router();

/**
 * GET /api/products/:vendorId
 * Product Master list + aliases + low_stock flag.
 */
router.get('/api/products/:vendorId', async (req, res) => {
  try {
    const products = await listProducts(req.params.vendorId);
    const lowStock = products.filter((p) => p.low_stock);
    res.json({
      vendorId: req.params.vendorId,
      products,
      count: products.length,
      low_stock: lowStock,
      low_stock_count: lowStock.length,
    });
  } catch (err) {
    console.error('[products] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products/:vendorId/profit?datePhrase=today
 * Profit from confirmed sales_transactions (SQL sum — not LLM).
 */
router.get('/api/products/:vendorId/profit', async (req, res) => {
  try {
    const datePhrase = String(req.query.datePhrase || 'today').trim() || 'today';
    const digest = await getProfitDigest(req.params.vendorId, datePhrase);
    res.json({ vendorId: req.params.vendorId, ...digest });
  } catch (err) {
    console.error('[products] profit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
