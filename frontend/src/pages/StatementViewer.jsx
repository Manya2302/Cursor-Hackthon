import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { API_BASE } from '../config'

const STATEMENT_TYPES = [
  { value: 'pnl', label: 'Profit & Loss' },
  { value: 'balance_sheet', label: 'Balance Sheet' },
  { value: 'cashflow', label: 'Cash Flow' },
  { value: 'owners_equity', label: "Owner's Equity" },
  { value: 'ledger_account', label: 'Account Ledger' },
  { value: 'accounting_equation', label: 'Accounting Equation' },
]

const DATE_PHRASES = [
  'today',
  'this_week',
  'this_month',
  'last_month',
  'last_3_months',
  'this_year',
  'year_to_date',
]

function money(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return String(n ?? '—')
  return `₹${x.toLocaleString('en-IN')}`
}

export default function StatementViewer() {
  const { session, logout } = useAuth()
  const [vendorId, setVendorId] = useState('')
  const [statementType, setStatementType] = useState('pnl')
  const [datePhrase, setDatePhrase] = useState('this_month')
  const [language, setLanguage] = useState('en')
  const [accountName, setAccountName] = useState('cash')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    async function resolveVendor() {
      if (!session?.phone) return
      const look = await fetch(
        `${API_BASE}/api/vendors/lookup?phone=${encodeURIComponent(session.phone)}`
      )
      if (look.ok) {
        const body = await look.json()
        setVendorId(body.vendor?.id || '')
      }
    }
    resolveVendor()
  }, [session?.phone])

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    setResult(null)
    if (!vendorId) {
      setError('Vendor not linked. Message WhatsApp bot once, then refresh.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId,
          statementType,
          datePhrase,
          language,
          accountName:
            statementType === 'ledger_account' ? accountName : undefined,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Statement failed')
      setResult(body)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const data = result?.data

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="brand brand-inline">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">LedgerBot</span>
        </div>
        <nav className="dash-nav">
          <Link to="/dashboard">Dashboard</Link>
          <Link to="/statements">Statements</Link>
        </nav>
        <div className="dash-user">
          <div className="dash-user-meta">
            <strong>{session?.name}</strong>
            <span>{session?.phone}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <main className="dash-main">
        <section className="dash-hero">
          <p className="dash-eyebrow">Statements</p>
          <h1>View your books</h1>
          <p className="dash-lead">
            Numbers come from SQL — the formatter only translates labels.
          </p>
        </section>

        <form className="statement-form" onSubmit={onSubmit}>
          <label>
            Statement type
            <select
              value={statementType}
              onChange={(e) => setStatementType(e.target.value)}
            >
              {STATEMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Period
            <select
              value={datePhrase}
              onChange={(e) => setDatePhrase(e.target.value)}
            >
              {DATE_PHRASES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Language
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="en">English</option>
              <option value="gu">Gujarati</option>
            </select>
          </label>
          {statementType === 'ledger_account' ? (
            <label>
              Account name
              <input
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder="cash"
              />
            </label>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Loading…' : 'Generate'}
          </button>
        </form>

        {error ? <p className="form-error">{error}</p> : null}

        {result ? (
          <section className="activity-panel statement-result">
            <div className="panel-head">
              <h2>
                {data?.statementType} · {result.range?.startDate} →{' '}
                {result.range?.endDate}
              </h2>
              <span className="panel-tag">
                {result.tally?.message || 'tally'}
              </span>
            </div>

            <pre className="statement-text">{result.text}</pre>

            {data?.statementType === 'pnl' ? (
              <table className="statement-table">
                <tbody>
                  <tr>
                    <td>Income</td>
                    <td>{money(data.income)}</td>
                  </tr>
                  <tr>
                    <td>Expense</td>
                    <td>{money(data.expense)}</td>
                  </tr>
                  <tr>
                    <td>Net profit</td>
                    <td>{money(data.net_profit)}</td>
                  </tr>
                </tbody>
              </table>
            ) : null}

            {data?.statementType === 'balance_sheet' ? (
              <table className="statement-table">
                <tbody>
                  <tr>
                    <td>Assets</td>
                    <td>{money(data.assets)}</td>
                  </tr>
                  <tr>
                    <td>Liabilities</td>
                    <td>{money(data.liabilities)}</td>
                  </tr>
                  <tr>
                    <td>Equity</td>
                    <td>{money(data.equity)}</td>
                  </tr>
                  <tr>
                    <td>Balanced</td>
                    <td>{data.balanced ? 'Yes' : 'No'}</td>
                  </tr>
                </tbody>
              </table>
            ) : null}

            {(data?.statementType === 'ledger_account' ||
              data?.statementType === 'party_ledger') &&
            Array.isArray(data.rows) ? (
              <table className="statement-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Particulars</th>
                    <th>Debit</th>
                    <th>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={`${r.journal_entry_id}-${i}`}>
                      <td>{String(r.entry_date).slice(0, 10)}</td>
                      <td>{r.narration}</td>
                      <td>{money(r.debit)}</td>
                      <td>{money(r.credit)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={2}>
                      <strong>Total</strong>
                    </td>
                    <td>
                      <strong>{money(data.total_debit)}</strong>
                    </td>
                    <td>
                      <strong>{money(data.total_credit)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  )
}
