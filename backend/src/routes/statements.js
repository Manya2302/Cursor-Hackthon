const express = require('express');
const { resolveDatePhrase } = require('../services/dateResolver');
const {
  runStatement,
  verifyTally,
  generateProfitLoss,
  generateBalanceSheet,
  generateCashFlow,
  generateOwnersEquity,
  generateLedgerAccount,
  generateAccountingEquation,
} = require('../services/statements');
const {
  formatStatementReply,
  pickFormatForStatement,
} = require('../services/responseFormatter');
const { generateStatementPdf } = require('../services/pdfGenerator');

const router = express.Router();

/**
 * POST /api/statements
 * Body: {
 *   vendorId, statementType, datePhrase?, startDate?, endDate?,
 *   accountId?, accountName?, partyName?, language?, format?
 * }
 */
router.post('/api/statements', async (req, res) => {
  try {
    const {
      vendorId,
      statementType = 'pnl',
      datePhrase = 'this_month',
      startDate,
      endDate,
      accountId,
      accountName,
      partyName,
      language = 'en',
      format,
      includePdf = false,
    } = req.body || {};

    if (!vendorId) {
      return res.status(400).json({ error: 'vendorId is required' });
    }

    const range = resolveDatePhrase(
      datePhrase === 'custom_range' || (startDate && endDate)
        ? 'custom_range'
        : datePhrase,
      new Date(),
      { startDate, endDate }
    );

    const { data, tally } = await runStatement(
      vendorId,
      {
        statementType,
        type: statementType,
        accountId,
        accountName,
        partyName,
      },
      range
    );

    const text = await formatStatementReply({
      statementData: data,
      tally,
      language,
      format: format || pickFormatForStatement(data.statementType),
    });

    let pdfBase64 = null;
    if (includePdf) {
      const pdf = await generateStatementPdf(
        data,
        data.statementType,
        language
      );
      pdfBase64 = pdf.toString('base64');
    }

    res.json({
      range,
      data,
      tally,
      text,
      pdfBase64,
    });
  } catch (err) {
    console.error('[statements] POST failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/statements/:vendorId/tally — quick books balance check
 */
router.get('/api/statements/:vendorId/tally', async (req, res) => {
  try {
    const tally = await verifyTally(req.params.vendorId);
    res.json(tally);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/statements/:vendorId/recent — recent journal entries for dashboard
 */
router.get('/api/statements/:vendorId/recent', async (req, res) => {
  try {
    const { Pool } = require('pg');
    const connectionString =
      process.env.DATABASE_URL || process.env.SUPABASE_API || '';
    if (!connectionString) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const pg = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const result = await pg.query(
      `select je.id, je.entry_date, je.narration, je.created_at,
              coalesce(sum(jl.debit), 0) as total_debit
         from journal_entries je
         left join journal_lines jl on jl.journal_entry_id = je.id
        where je.vendor_id = $1
        group by je.id
        order by je.entry_date desc, je.created_at desc
        limit $2`,
      [req.params.vendorId, limit]
    );
    await pg.end();
    res.json({ vendorId: req.params.vendorId, entries: result.rows });
  } catch (err) {
    console.error('[statements] recent failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Re-export generators for tests / other routes
router._generators = {
  generateProfitLoss,
  generateBalanceSheet,
  generateCashFlow,
  generateOwnersEquity,
  generateLedgerAccount,
  generateAccountingEquation,
};

module.exports = router;
