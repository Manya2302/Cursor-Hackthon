import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import InventorySetup from '../components/InventorySetup'
import {
  demoOcrFromBill,
  getInventory,
  matchBillLinesToInventory,
  saveInventory,
} from '../inventory/storage'
import { APP_NAME } from '../brand'

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'NV'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

function formatMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return `₹${Number(n).toLocaleString('en-IN')}`
}

export default function Dashboard() {
  const { session, logout } = useAuth()
  const firstName = session?.name?.split(' ')[0] || 'there'
  const billRef = useRef(null)

  const [inventory, setInventory] = useState(() => getInventory(session?.userId))
  const [editingStock, setEditingStock] = useState(false)
  const [billPreview, setBillPreview] = useState(null)
  const [matches, setMatches] = useState([])
  const [billNote, setBillNote] = useState('')

  const stockValue = useMemo(() => {
    return inventory.reduce((sum, item) => {
      const q = Number(item.quantity)
      const p = Number(item.price)
      if (!Number.isFinite(q) || !Number.isFinite(p)) return sum
      return sum + q * p
    }, 0)
  }, [inventory])

  const stats = [
    { label: 'Products in stock', value: String(inventory.length), hint: 'Your catalog' },
    {
      label: 'Stock value',
      value: inventory.length ? formatMoney(stockValue) : '—',
      hint: 'Qty × price',
    },
    { label: 'Matched on last bill', value: String(matches.filter((m) => m.matched).length), hint: 'Demo match' },
    { label: 'Unmatched lines', value: String(matches.filter((m) => !m.matched).length), hint: 'Need review' },
  ]

  function refreshInventory(next) {
    setInventory(next)
    setEditingStock(false)
  }

  function handleInventorySave(items) {
    const next = saveInventory(session.userId, items)
    refreshInventory(next)
  }

  function handleBillFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const url = URL.createObjectURL(file)
    setBillPreview({ url, name: file.name })
    setBillNote('Demo match (local only) — no backend OCR yet.')

    const lines = demoOcrFromBill(file.name, inventory)
    const result = matchBillLinesToInventory(lines, inventory)
    setMatches(result)
  }

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="brand brand-inline">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">{APP_NAME}</span>
        </div>
        <nav className="dash-nav">
          <Link to="/dashboard">Dashboard</Link>
          <Link to="/statements">Statements</Link>
        </nav>
        <div className="dash-user">
          <div className="dash-avatar" aria-hidden="true">
            {initials(session?.name)}
          </div>
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
          <p className="dash-eyebrow">Your books</p>
          <h1>Good day, {firstName}</h1>
          <p className="dash-lead">
            Your inventory is saved on this device. Upload a bill photo to see
            products matched against your catalog.
          </p>
        </section>

        <section className="stat-grid" aria-label="Account snapshot">
          {stats.map((stat) => (
            <article key={stat.label} className="stat">
              <span className="stat-label">{stat.label}</span>
              <strong className="stat-value">{stat.value}</strong>
              <span className="stat-hint">{stat.hint}</span>
            </article>
          ))}
        </section>

        <section className="activity-panel inventory-panel">
          <div className="panel-head">
            <h2>Inventory</h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditingStock((v) => !v)}
            >
              {editingStock ? 'Close editor' : inventory.length ? 'Edit stock' : 'Add stock'}
            </button>
          </div>

          {editingStock ? (
            <InventorySetup
              initialItems={inventory}
              onSave={handleInventorySave}
              onSkip={() => setEditingStock(false)}
              title="Update inventory"
              subtitle="Upload Excel / PDF / CSV or type products. Stored locally for bill matching."
            />
          ) : inventory.length === 0 ? (
            <p className="form-note">
              No products yet. Add inventory so bill uploads can match your stock.
            </p>
          ) : (
            <div className="inv-table-wrap">
              <table className="inv-table inv-table-readonly">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Qty</th>
                    <th>Unit</th>
                    <th>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.map((item) => (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td>{item.quantity ?? '—'}</td>
                      <td>{item.unit}</td>
                      <td>{formatMoney(item.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="activity-panel bill-match-panel">
          <div className="panel-head">
            <h2>Match bill to inventory</h2>
            <span className="panel-tag">Frontend demo</span>
          </div>
          <p className="form-note">
            Upload a bill image. We simulate reading it and match lines to your
            saved products (local only — not connected to the server).
          </p>

          <input
            ref={billRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleBillFile}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => billRef.current?.click()}
            disabled={!inventory.length}
          >
            Upload bill photo
          </button>
          {!inventory.length && (
            <p className="form-note">Add inventory first to enable matching.</p>
          )}

          {billPreview && (
            <div className="bill-preview-grid">
              <figure className="bill-preview">
                <img src={billPreview.url} alt="Uploaded bill" />
                <figcaption>{billPreview.name}</figcaption>
              </figure>
              <div className="bill-matches">
                {billNote && <p className="form-note">{billNote}</p>}
                <ul className="match-list">
                  {matches.map((m, i) => (
                    <li key={`${m.billName}-${i}`} className={m.matched ? 'hit' : 'miss'}>
                      <div>
                        <strong>{m.billName}</strong>
                        {m.matched ? (
                          <p>
                            Matched → {m.product.name}
                            {m.product.price != null ? ` · ${formatMoney(m.product.price)}` : ''}
                            {m.product.quantity != null
                              ? ` · stock ${m.product.quantity} ${m.product.unit}`
                              : ''}
                          </p>
                        ) : (
                          <p>No match in your inventory</p>
                        )}
                      </div>
                      <span className="match-badge">
                        {m.matched ? `${Math.round(m.confidence * 100)}%` : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
      </main>

      <nav className="dash-mobile-bar" aria-label="Quick actions">
        <button
          type="button"
          className="btn btn-primary dash-wa-cta"
          onClick={() => setEditingStock(true)}
        >
          Edit inventory
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={logout}>
          Log out
        </button>
      </nav>
    </div>
  )
}
