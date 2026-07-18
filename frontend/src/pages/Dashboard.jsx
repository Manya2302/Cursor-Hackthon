import { useAuth } from '../context/AuthContext'

const STATS = [
  { label: 'Cash in hand', value: '₹42,850', hint: 'Today' },
  { label: 'Receivables', value: '₹18,200', hint: '3 open' },
  { label: 'Payables', value: '₹9,450', hint: '2 vendors' },
  { label: 'Stock value', value: '₹1,26,000', hint: 'SKU snapshot' },
]

const ACTIVITY = [
  {
    type: 'Sale',
    detail: 'Kirana order — 12 items',
    amount: '+₹2,340',
    time: '10:42',
    tone: 'in',
  },
  {
    type: 'Payment',
    detail: 'Received from Ramesh Traders',
    amount: '+₹5,000',
    time: '09:15',
    tone: 'in',
  },
  {
    type: 'Purchase',
    detail: 'Stock restock — oil & flour',
    amount: '−₹3,800',
    time: 'Yesterday',
    tone: 'out',
  },
  {
    type: 'Voice',
    detail: 'WhatsApp note parsed by NIRVHA AI',
    amount: 'Pending',
    time: 'Yesterday',
    tone: 'pending',
  },
]

const COMMANDS = [
  { code: '/ai-order', desc: 'Log a sale from text, voice, or photo' },
  { code: '/ai-stock', desc: 'Update inventory' },
  { code: '/ai-payment', desc: 'Record money in or out' },
  { code: '/ai-report', desc: 'Ask for a quick summary' },
]

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'LB'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

export default function Dashboard() {
  const { session, logout } = useAuth()
  const firstName = session?.name?.split(' ')[0] || 'there'

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="brand brand-inline">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">NIRVHA</span>
        </div>
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
            Your invisible AI accountant is ready. Send WhatsApp messages, voice
            notes, or photos — NIRVHA keeps the ledger tallied.
          </p>
        </section>

        <section className="stat-grid" aria-label="Account snapshot">
          {STATS.map((stat) => (
            <article key={stat.label} className="stat">
              <span className="stat-label">{stat.label}</span>
              <strong className="stat-value">{stat.value}</strong>
              <span className="stat-hint">{stat.hint}</span>
            </article>
          ))}
        </section>

        <section className="activity-panel">
          <div className="panel-head">
            <h2>Recent activity</h2>
            <span className="panel-tag">Sample data</span>
          </div>
          <ul className="activity-list">
            {ACTIVITY.map((item) => (
              <li key={`${item.type}-${item.time}-${item.detail}`}>
                <div className="activity-body">
                  <span className={`activity-type tone-${item.tone}`}>{item.type}</span>
                  <p>{item.detail}</p>
                </div>
                <div className="activity-meta">
                  <span className={`activity-amount tone-${item.tone}`}>
                    {item.amount}
                  </span>
                  <time>{item.time}</time>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="quick-actions">
          <h2>WhatsApp shortcuts</h2>
          <p>Use these commands in chat once your number is linked.</p>
          <ul className="command-list">
            {COMMANDS.map((cmd) => (
              <li key={cmd.code}>
                <code>{cmd.code}</code>
                <span>{cmd.desc}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <nav className="dash-mobile-bar" aria-label="Quick actions">
        <a
          className="btn btn-primary dash-wa-cta"
          href="https://wa.me/"
          target="_blank"
          rel="noreferrer"
        >
          Open WhatsApp
        </a>
        <button type="button" className="btn btn-outline btn-sm" onClick={logout}>
          Log out
        </button>
      </nav>
    </div>
  )
}
