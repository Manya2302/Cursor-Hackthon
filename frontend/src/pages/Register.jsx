import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import AuthShell from '../components/AuthShell'
import { APP_NAME } from '../brand'

const STEPS = ['Details', 'Verify OTP', 'WhatsApp', 'Password']

export default function Register() {
  const { startRegistration, verifyOtp, setPassword, pendingOtp, clearPendingOtp } =
    useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState(pendingOtp ? 1 : 0)
  const [form, setForm] = useState({
    name: pendingOtp?.name || '',
    email: pendingOtp?.email || '',
    phone: pendingOtp?.phone || '',
  })
  const [otp, setOtp] = useState('')
  const [demoOtp, setDemoOtp] = useState(pendingOtp?.demoOtp || '')
  const [newUser, setNewUser] = useState(null)
  const [whatsapp, setWhatsapp] = useState(null)
  const [password, setPasswordValue] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setError('')
  }

  async function handleDetails(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { otp: sent } = await startRegistration(form)
      setDemoOtp(sent || '')
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
      if (!/^\d{6}$/.test(otp.trim())) {
        throw new Error('Enter the 6-digit OTP.')
      }
      const user = await verifyOtp(otp)
      setNewUser(user)
      setWhatsapp(user.whatsapp || null)
      setStep(2)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handlePassword(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (!newUser?.id) throw new Error('Account not found. Please register again.')
      if (password.length < 6) throw new Error('Password must be at least 6 characters.')
      if (password !== confirmPassword) {
        throw new Error('Password and confirm password do not match.')
      }
      await setPassword(newUser.id, password)
      navigate('/login', { state: { phone: newUser.phone } })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const firstName = (newUser?.name || form.name || '').split(' ')[0] || 'there'

  return (
    <AuthShell
      title={`Create your ${APP_NAME} account`}
      subtitle="Enter your details, verify OTP, get a WhatsApp Hi, then set a login password."
      footer={
        <>
          Already registered? <Link to="/login">Log in with password</Link>
        </>
      }
    >
      <ol className="stepper stepper-4" aria-label="Registration steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={i === step ? 'active' : i < step ? 'done' : ''}
            aria-current={i === step ? 'step' : undefined}
          >
            <span className="step-num">{i < step ? '✓' : i + 1}</span>
            <span className="step-label">{label}</span>
          </li>
        ))}
      </ol>
      <p className="stepper-mobile-label">
        Step {step + 1} of {STEPS.length}: <strong>{STEPS[step]}</strong>
      </p>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {step === 0 && (
        <form className="auth-form" onSubmit={handleDetails} noValidate>
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              autoComplete="name"
              enterKeyHint="next"
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
              enterKeyHint="next"
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
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="done"
              placeholder="9974099063"
              value={form.phone}
              onChange={(e) => updateField('phone', e.target.value)}
              required
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Sending OTP…' : 'Request OTP'}
          </button>
        </form>
      )}

      {step === 1 && (
        <form className="auth-form" onSubmit={handleOtp} noValidate>
          <p className="form-note">
            Enter the OTP for <strong>{pendingOtp?.email || form.email}</strong>.
          </p>
          {demoOtp && (
            <div className="demo-banner" role="status">
              <span className="demo-label">Demo OTP</span>
              <p>
                Your OTP: <code>{demoOtp}</code>
              </p>
            </div>
          )}
          <label className="field">
            <span>OTP</span>
            <input
              className="otp-input"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
              enterKeyHint="done"
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
            You&apos;re verified, {firstName}. We sent a WhatsApp hello to your
            number.
          </p>
          <div className="passcode-box">
            <span className="passcode-label">WhatsApp message</span>
            <strong className="passcode-value" style={{ letterSpacing: '0.04em' }}>
              Hi {firstName}
            </strong>
            <span style={{ fontSize: '0.85rem', opacity: 0.85 }}>
              {whatsapp?.ok
                ? `Sent via ${whatsapp.mode}`
                : whatsapp?.error
                  ? `Could not send yet: ${whatsapp.error}`
                  : 'Sending…'}
            </span>
          </div>
          <ul className="hint-list">
            <li>Check WhatsApp on {newUser.phone}</li>
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
            Choose a password for <strong>{newUser.phone}</strong>.
          </p>
          <label className="field">
            <span>Password</span>
            <div className="field-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                enterKeyHint="next"
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => {
                  setPasswordValue(e.target.value)
                  setError('')
                }}
                required
              />
              <button
                type="button"
                className="field-action"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              enterKeyHint="done"
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
            Back
          </button>
        </form>
      )}
    </AuthShell>
  )
}
