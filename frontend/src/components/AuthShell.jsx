import { APP_NAME } from '../brand'

export default function AuthShell({ title, subtitle, footer, children, wide = false }) {
  return (
    <div className="auth-page">
      <div className="auth-backdrop" aria-hidden="true" />
      <div className={`auth-layout${wide ? ' auth-layout-wide' : ''}`}>
        <aside className="auth-brand-panel">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <h1 className="brand-name">{APP_NAME}</h1>
          </div>
          <p className="brand-tagline">
            An invisible AI accountant that lives inside WhatsApp — books for
            kiranas, workshops, and small shops.
          </p>
          <ul className="brand-points">
            <li>Message in. Books out.</li>
            <li>Voice, photo, or text — all counted.</li>
            <li>Double-entry without the spreadsheet.</li>
          </ul>
        </aside>

        <section
          className={`auth-panel${wide ? ' auth-panel-wide' : ''}`}
          aria-labelledby="auth-panel-title"
        >
          <header className="auth-panel-head">
            <p className="auth-mobile-brand">
              <span className="brand-mark brand-mark-sm" aria-hidden="true" />
              <span>{APP_NAME}</span>
            </p>
            <h2 id="auth-panel-title">{title}</h2>
            <p>{subtitle}</p>
          </header>
          {children}
          {footer && <footer className="auth-footer">{footer}</footer>}
        </section>
      </div>
    </div>
  )
}
