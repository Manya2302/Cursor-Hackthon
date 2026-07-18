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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * verifyTally — total debits == total credits for vendor.
 */
async function verifyTally(vendorId) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const result = await pg.query(
    `select
       coalesce(sum(jl.debit), 0) as total_debit,
       coalesce(sum(jl.credit), 0) as total_credit
     from journal_lines jl
     join journal_entries je on je.id = jl.journal_entry_id
    where je.vendor_id = $1`,
    [vendorId]
  );
  const totalDebit = num(result.rows[0]?.total_debit);
  const totalCredit = num(result.rows[0]?.total_credit);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
  return {
    totalDebit,
    totalCredit,
    balanced,
    message: balanced ? '✅ Verified balanced' : '⚠️ Discrepancy found',
  };
}

async function generateProfitLoss(vendorId, startDate, endDate) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const byType = await pg.query(
    `select a.account_type,
            a.id as account_id,
            a.name as account_name,
            sum(case when a.account_type = 'income'
                     then jl.credit - jl.debit
                     else jl.debit - jl.credit end) as amount
       from journal_lines jl
       join journal_entries je on je.id = jl.journal_entry_id
       join accounts a on a.id = jl.account_id and a.vendor_id = je.vendor_id
      where je.vendor_id = $1
        and je.entry_date between $2::date and $3::date
        and a.account_type in ('income', 'expense')
      group by a.account_type, a.id, a.name
      order by a.account_type, a.name`,
    [vendorId, startDate, endDate]
  );

  const incomeLines = [];
  const expenseLines = [];
  let income = 0;
  let expense = 0;
  for (const r of byType.rows) {
    const amount = num(r.amount);
    const line = {
      account_id: r.account_id,
      account_name: r.account_name,
      amount,
    };
    if (r.account_type === 'income') {
      incomeLines.push(line);
      income += amount;
    } else {
      expenseLines.push(line);
      expense += amount;
    }
  }

  income = num(income);
  expense = num(expense);
  const gross_profit = income; // simplified: no COGS split
  const net_profit = num(income - expense);

  return {
    statementType: 'pnl',
    startDate,
    endDate,
    income,
    expense,
    gross_profit,
    net_profit,
    income_lines: incomeLines,
    expense_lines: expenseLines,
  };
}

async function generateBalanceSheet(vendorId, startDate, endDate) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');
  const asOf = endDate;

  const result = await pg.query(
    `select a.account_type,
            coalesce(sum(
              case when a.account_type in ('liability', 'equity', 'income')
                   then jl.credit - jl.debit
                   else jl.debit - jl.credit end
            ), 0) as amount
       from accounts a
       left join journal_lines jl on jl.account_id = a.id
       left join journal_entries je
         on je.id = jl.journal_entry_id
        and je.vendor_id = a.vendor_id
        and je.entry_date <= $2::date
      where a.vendor_id = $1
        and a.account_type in ('asset', 'liability', 'equity')
      group by a.account_type`,
    [vendorId, asOf]
  );

  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  for (const r of result.rows) {
    if (r.account_type === 'asset') assets = num(r.amount);
    if (r.account_type === 'liability') liabilities = num(r.amount);
    if (r.account_type === 'equity') equity = num(r.amount);
  }

  // Include period P&L retained into equity for a useful BS
  const pnl = await generateProfitLoss(vendorId, '1970-01-01', asOf);
  const equityWithRetained = num(equity + pnl.net_profit);
  const balanced = Math.abs(assets - (liabilities + equityWithRetained)) < 0.01;

  return {
    statementType: 'balance_sheet',
    asOfDate: asOf,
    startDate,
    endDate: asOf,
    assets,
    liabilities,
    equity: equityWithRetained,
    retained_profit: pnl.net_profit,
    balanced,
  };
}

async function generateCashFlow(vendorId, startDate, endDate) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const result = await pg.query(
    `select je.entry_date,
            je.narration,
            (jl.debit - jl.credit) as amount,
            case when jl.debit > 0 then 'inflow' else 'outflow' end as direction,
            (
              select a2.account_type
                from journal_lines jl2
                join accounts a2 on a2.id = jl2.account_id
               where jl2.journal_entry_id = je.id
                 and jl2.id <> jl.id
               order by jl2.id
               limit 1
            ) as offsetting_account_type
       from journal_lines jl
       join journal_entries je on je.id = jl.journal_entry_id
      where je.vendor_id = $1
        and jl.account_id = 'cash'
        and je.entry_date between $2::date and $3::date
      order by je.entry_date, je.created_at`,
    [vendorId, startDate, endDate]
  );

  let inflows = 0;
  let outflows = 0;
  const lines = result.rows.map((r) => {
    const amount = num(r.amount);
    if (r.direction === 'inflow') inflows += Math.abs(amount);
    else outflows += Math.abs(amount);
    return {
      entry_date: r.entry_date,
      narration: r.narration,
      amount: Math.abs(amount),
      direction: r.direction,
      offsetting_account_type: r.offsetting_account_type,
    };
  });

  return {
    statementType: 'cashflow',
    startDate,
    endDate,
    inflows: num(inflows),
    outflows: num(outflows),
    net_cash: num(inflows - outflows),
    lines,
  };
}

async function generateOwnersEquity(vendorId, startDate, endDate) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const capital = await pg.query(
    `select coalesce(sum(jl.credit - jl.debit), 0) as amount
       from journal_lines jl
       join journal_entries je on je.id = jl.journal_entry_id
       join accounts a on a.id = jl.account_id
      where je.vendor_id = $1
        and je.entry_date between $2::date and $3::date
        and (a.id = 'capital' or lower(a.name) like '%capital%')
        and a.account_type = 'equity'`,
    [vendorId, startDate, endDate]
  );

  const drawings = await pg.query(
    `select coalesce(sum(jl.debit - jl.credit), 0) as amount
       from journal_lines jl
       join journal_entries je on je.id = jl.journal_entry_id
       join accounts a on a.id = jl.account_id
      where je.vendor_id = $1
        and je.entry_date between $2::date and $3::date
        and (a.id = 'drawings' or lower(a.name) like '%drawing%')`,
    [vendorId, startDate, endDate]
  );

  const pnl = await generateProfitLoss(vendorId, startDate, endDate);
  const contributions = num(capital.rows[0]?.amount);
  const drawingsAmt = num(drawings.rows[0]?.amount);
  const retained = num(pnl.net_profit);
  const closing_equity = num(contributions - drawingsAmt + retained);

  return {
    statementType: 'owners_equity',
    startDate,
    endDate,
    capital_contributions: contributions,
    drawings: drawingsAmt,
    retained_profit: retained,
    closing_equity,
  };
}

async function generateLedgerAccount(vendorId, accountId, startDate, endDate) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const acct = await pg.query(
    `select id, name, account_type from accounts
      where vendor_id = $1 and id = $2`,
    [vendorId, accountId]
  );
  if (!acct.rows[0]) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const result = await pg.query(
    `select je.entry_date, je.narration, jl.debit, jl.credit, je.id as journal_entry_id
       from journal_lines jl
       join journal_entries je on je.id = jl.journal_entry_id
      where je.vendor_id = $1
        and jl.account_id = $2
        and je.entry_date between $3::date and $4::date
      order by je.entry_date asc, je.created_at asc`,
    [vendorId, accountId, startDate, endDate]
  );

  let totalDebit = 0;
  let totalCredit = 0;
  const rows = result.rows.map((r) => {
    const debit = num(r.debit);
    const credit = num(r.credit);
    totalDebit += debit;
    totalCredit += credit;
    return {
      entry_date: r.entry_date,
      narration: r.narration,
      debit,
      credit,
      journal_entry_id: r.journal_entry_id,
    };
  });

  return {
    statementType: 'ledger_account',
    account: acct.rows[0],
    startDate,
    endDate,
    rows,
    total_debit: num(totalDebit),
    total_credit: num(totalCredit),
  };
}

async function generateAccountingEquation(vendorId, asOfDate) {
  const bs = await generateBalanceSheet(vendorId, '1970-01-01', asOfDate);
  return {
    statementType: 'accounting_equation',
    asOfDate,
    assets: bs.assets,
    liabilities: bs.liabilities,
    equity: bs.equity,
    balanced: bs.balanced,
    equation: `${bs.assets} = ${bs.liabilities} + ${bs.equity}`,
  };
}

async function resolveAccountId(vendorId, { accountId, accountName, partyName }) {
  if (accountId) return accountId;
  const pg = getPool();
  if (!pg) return null;

  const name = (accountName || partyName || '').trim();
  if (!name) return 'cash';

  const byName = await pg.query(
    `select id from accounts
      where vendor_id = $1 and lower(name) = lower($2)
      limit 1`,
    [vendorId, name]
  );
  if (byName.rows[0]) return byName.rows[0].id;

  const fuzzy = await pg.query(
    `select id from accounts
      where vendor_id = $1 and lower(name) like '%' || lower($2) || '%'
      order by length(name) asc
      limit 1`,
    [vendorId, name]
  );
  return fuzzy.rows[0]?.id || null;
}

/**
 * Dispatch statement generation from extracted statement metadata.
 */
async function runStatement(vendorId, statementMeta, dateRange) {
  const type = String(
    statementMeta?.statementType || statementMeta?.type || 'pnl'
  )
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  const { startDate, endDate } = dateRange;
  let data;

  switch (type) {
    case 'pnl':
    case 'profit_loss':
    case 'p_and_l':
    case 'statement':
      data = await generateProfitLoss(vendorId, startDate, endDate);
      break;
    case 'balance_sheet':
    case 'bs':
      data = await generateBalanceSheet(vendorId, startDate, endDate);
      break;
    case 'cashflow':
    case 'cash_flow':
      data = await generateCashFlow(vendorId, startDate, endDate);
      break;
    case 'owners_equity':
    case 'equity':
      data = await generateOwnersEquity(vendorId, startDate, endDate);
      break;
    case 'ledger_account':
    case 'party_ledger':
    case 'ledger': {
      const accountId = await resolveAccountId(vendorId, {
        accountId: statementMeta.accountId,
        accountName: statementMeta.accountName,
        partyName: statementMeta.partyName || statementMeta.party?.name,
      });
      if (!accountId) {
        throw new Error(
          'Which account or party ledger? e.g. "cash ledger" or "Ramesh ledger"'
        );
      }
      data = await generateLedgerAccount(
        vendorId,
        accountId,
        startDate,
        endDate
      );
      if (type === 'party_ledger') data.statementType = 'party_ledger';
      break;
    }
    case 'accounting_equation':
    case 'equation':
      data = await generateAccountingEquation(vendorId, endDate);
      break;
    default:
      data = await generateProfitLoss(vendorId, startDate, endDate);
  }

  const tally = await verifyTally(vendorId);
  return { data, tally };
}

module.exports = {
  verifyTally,
  generateProfitLoss,
  generateBalanceSheet,
  generateCashFlow,
  generateOwnersEquity,
  generateLedgerAccount,
  generateAccountingEquation,
  resolveAccountId,
  runStatement,
};
