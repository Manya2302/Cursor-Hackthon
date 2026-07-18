import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import AuthShell from '../components/AuthShell'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [phone, setPhone] = useState(location.state?.phone || '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const digits = phone.replace(/\D/g, '')
      if (digits.length < 10) throw new Error('Enter a valid phone number.')
      if (!password) throw new Error('Enter your password.')

      await new Promise((r) => setTimeout(r, 400))
      login({ phone, password })
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in with your phone number and password."
      footer={
        <>
          New here? <Link to="/register">Create an account</Link>
        </>
      }
    >
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <label className="field">
          <span>Phone number</span>
          <input
            type="tel"
            autoComplete="tel"
            placeholder="9876543210"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value)
              setError('')
            }}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setError('')
            }}
            required
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Log in'}
        </button>
      </form>
    </AuthShell>
  )
}
