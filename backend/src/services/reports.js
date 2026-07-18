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

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

async function getTodayProfit(vendorId, date = null) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');
  const targetDate = date || new Date().toISOString().slice(0, 10);

  const client = await pg.connect();
  try {
    try {
      const fn = await client.query(
        `select * from fn_today_profit($1::uuid, $2::date)`,
        [vendorId, targetDate]
      );
      if (fn.rows[0]) {
        return {
          date: targetDate,
          profit: Number(fn.rows[0].profit_amount || 0),
          sales: Number(fn.rows[0].sales_amount || 0),
          cost: Number(fn.rows[0].estimated_cost || 0),
          source: 'fn_today_profit',
        };
      }
    } catch (err) {
      if (!['42883', '42P01'].includes(err.code)) throw err;
    }

    const sales = await client.query(
      `select
         coalesce(sum(total_amount), 0) as sales_total,
         coalesce(sum(profit), 0) as profit_total
       from sales_transactions
       where vendor_id = $1 and bill_date = $2`,
      [vendorId, targetDate]
    );
    if (sales.rows[0]) {
      const salesTotal = Number(sales.rows[0].sales_total || 0);
      const profitTotal = Number(sales.rows[0].profit_total || 0);
      return {
        date: targetDate,
        profit: profitTotal,
        sales: salesTotal,
        cost: salesTotal - profitTotal,
        source: 'sales_transactions',
      };
    }

    const journal = await client.query(
      `select coalesce(sum(profit), 0) as profit_total
         from journal_entries
        where vendor_id = $1 and entry_date = $2`,
      [vendorId, targetDate]
    );
    return {
      date: targetDate,
      profit: Number(journal.rows[0]?.profit_total || 0),
      sales: 0,
      cost: 0,
      source: 'journal_entries',
    };
  } finally {
    client.release();
  }
}

async function getTodayProfitMessage(vendorId, date = null) {
  const data = await getTodayProfit(vendorId, date);
  const sign = data.profit >= 0 ? '+' : '-';
  return (
    `📈 *Today Profit (${data.date})*\n` +
    `Profit: ${sign}₹${formatMoney(Math.abs(data.profit))}\n` +
    `Sales: ₹${formatMoney(data.sales)}\n` +
    `Estimated cost: ₹${formatMoney(data.cost)}`
  );
}

module.exports = {
  getTodayProfit,
  getTodayProfitMessage,
};
