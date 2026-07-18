const express = require('express');
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
 * GET /api/accounts/:vendorId
 * List accounts with balances (debit−credit for asset/expense; credit−debit for liability/equity/income).
 */
router.get('/api/accounts/:vendorId', async (req, res) => {
  const pg = getPool();
  if (!pg) return res.status(503).json({ error: 'Database not configured' });

  const { vendorId } = req.params;
  try {
    const result = await pg.query(
      `select
         a.id,
         a.name,
         a.account_type,
         a.is_party,
         a.party_id,
         coalesce(sum(jl.debit), 0) as total_debit,
         coalesce(sum(jl.credit), 0) as total_credit,
         case
           when a.account_type in ('liability', 'equity', 'income')
             then coalesce(sum(jl.credit), 0) - coalesce(sum(jl.debit), 0)
           else coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0)
         end as balance
       from accounts a
       left join journal_lines jl on jl.account_id = a.id
       left join journal_entries je
         on je.id = jl.journal_entry_id and je.vendor_id = a.vendor_id
       where a.vendor_id = $1
       group by a.id, a.name, a.account_type, a.is_party, a.party_id
       order by a.account_type, a.name`,
      [vendorId]
    );
    res.json({ vendorId, accounts: result.rows });
  } catch (err) {
    console.error('[accounts] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/accounts/:vendorId/:accountId/ledger
 * Party / T-account ledger with running balance.
 */
router.get('/api/accounts/:vendorId/:accountId/ledger', async (req, res) => {
  const pg = getPool();
  if (!pg) return res.status(503).json({ error: 'Database not configured' });

  const { vendorId, accountId } = req.params;
  try {
    const acct = await pg.query(
      `select id, name, account_type from accounts
        where vendor_id = $1 and id = $2`,
      [vendorId, accountId]
    );
    if (!acct.rows[0]) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = acct.rows[0];
    const invert =
      account.account_type === 'liability' ||
      account.account_type === 'equity' ||
      account.account_type === 'income';

    const result = await pg.query(
      `select
         jl.id,
         jl.debit,
         jl.credit,
         je.id as journal_entry_id,
         je.entry_date,
         je.narration,
         je.created_at
       from journal_lines jl
       join journal_entries je on je.id = jl.journal_entry_id
       where je.vendor_id = $1 and jl.account_id = $2
       order by je.entry_date asc, je.created_at asc, jl.id asc`,
      [vendorId, accountId]
    );

    let running = 0;
    const rows = result.rows.map((r) => {
      const delta = invert
        ? Number(r.credit) - Number(r.debit)
        : Number(r.debit) - Number(r.credit);
      running += delta;
      return { ...r, running_balance: running };
    });

    res.json({
      vendorId,
      account,
      ledger: rows,
      closing_balance: running,
    });
  } catch (err) {
    console.error('[accounts] ledger failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
