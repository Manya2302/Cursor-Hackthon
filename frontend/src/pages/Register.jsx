import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import AuthShell from '../components/AuthShell'

const STEPS = ['Details', 'Verify OTP', 'Passcode', 'Password']

export default function Register() {
  const { startRegistration, verifyOtp, setPassword, pendingOtp, clearPendingOtp } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState(pendingOtp ? 1 : 0)
  const [form, setForm] = useState({
    name: pendingOtp?.name || '',
    email: pendingOtp?.email || '',
    phone: pendingOtp?.phone || '',
  })
  const [otp, setOtp] = useState('')
  const [demoOtp, setDemoOtp] = useState(pendingOtp?.otp || '')
  const [newUser, setNewUser] = useState(null)
  const [password, setPasswordValue] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setError('')
  }

  async function handleDetails(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (!form.name.trim()) throw new Error('Please enter your name.')
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
        throw new Error('Please enter a valid email.')
      }
      const digits = form.phone.replace(/\D/g, '')
      if (digits.length < 10) throw new Error('Enter a valid phone number (at least 10 digits).')

      await new Promise((r) => setTimeout(r, 450))
      const { otp: sent } = startRegistration(form)
      setDemoOtp(sent)
      setStep(1)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleOtp(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (!/^\d{6}$/.test(otp.trim())) throw new Error('Enter the 6-digit OTP from your email.')
      await new Promise((r) => setTimeout(r, 400))
      const user = verifyOtp(otp)
      setNewUser(user)
      setStep(2)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleCopy() {
    if (!newUser?.passcode) return
    navigator.clipboard.writeText(newUser.passcode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  async function handlePassword(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (!newUser?.id) throw new Error('Account not found. Please register again.')
      if (password.length < 6) throw new Error('Password must be at least 6 characters.')
      if (password !== confirmPassword) throw new Error('Password and confirm password do not match.')

      await new Promise((r) => setTimeout(r, 350))
      setPassword(newUser.id, password)
      navigate('/login', { state: { phone: newUser.phone } })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title="Create your LedgerBot account"
      subtitle="Register, verify OTP, save your passcode, then set a password to log in."
      footer={
        <>
          Already registered? <Link to="/login">Log in with password</Link>
        </>
      }
    >
      <ol className="stepper stepper-4" aria-label="Registration steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'active' : i < step ? 'done' : ''}>
            <span className="step-num">{i + 1}</span>
            <span className="step-label">{label}</span>
          </li>
        ))}
      </ol>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {step === 0 && (
        <form className="auth-form" onSubmit={handleDetails} noValidate>
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              autoComplete="name"
              placeholder="Priya Sharma"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              placeholder="you@business.com"
              value={form.email}
              onChange={(e) => updateField('email', e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Phone number</span>
            <input
              type="tel"
              autoComplete="tel"
              placeholder="9876543210"
              value={form.phone}
              onChange={(e) => updateField('phone', e.target.value)}
              required
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Sending OTP…' : 'Send OTP to email'}
          </button>
        </form>
      )}

      {step === 1 && (
        <form className="auth-form" onSubmit={handleOtp} noValidate>
          <p className="form-note">
            We sent a 6-digit OTP to <strong>{pendingOtp?.email || form.email}</strong>.
          </p>
          <div className="demo-banner" role="status">
            <span className="demo-label">Demo inbox</span>
            <p>
              OTP for <strong>{pendingOtp?.email || form.email}</strong>: <code>{demoOtp}</code>
            </p>
          </div>
          <label className="field">
            <span>Email OTP</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="••••••"
              value={otp}
              onChange={(e) => {
                setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))
                setError('')
              }}
              required
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Verifying…' : 'Verify OTP'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              clearPendingOtp()
              setStep(0)
              setOtp('')
              setError('')
            }}
          >
            Back to details
          </button>
        </form>
      )}

      {step === 2 && newUser && (
        <div className="passcode-reveal">
          <p className="form-note success-note">
            You&apos;re verified, {newUser.name.split(' ')[0]}. Save this passcode, then set a
            password for login.
          </p>
          <div className="passcode-box">
            <span className="passcode-label">Your passcode</span>
            <strong className="passcode-value">{newUser.passcode}</strong>
            <button type="button" className="btn btn-secondary" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy passcode'}
            </button>
          </div>
          <ul className="hint-list">
            <li>Keep this passcode somewhere safe</li>
            <li>Next, create a password you&apos;ll use to log in</li>
          </ul>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => {
              setError('')
              setStep(3)
            }}
          >
            Set password
          </button>
        </div>
      )}

      {step === 3 && newUser && (
        <form className="auth-form" onSubmit={handlePassword} noValidate>
          <p className="form-note">
            Choose a password for <strong>{newUser.phone}</strong>. You&apos;ll use phone +
            password to log in.
          </p>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => {
                setPasswordValue(e.target.value)
                setError('')
              }}
              required
            />
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Re-enter password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value)
                setError('')
              }}
              required
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Saving…' : 'Save password & continue'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setStep(2)
              setError('')
            }}
          >
            Back to passcode
          </button>
        </form>
      )}
    </AuthShell>
  )
}
